//! Credentials stay in the system Keychain. Never modify item ownership or ACLs
//! during reads. Cache successful reads for this process, serializing access so
//! simultaneous connection requests do not trigger duplicate authorization dialogs.

const SERVICE: &str = "com.lotdb.app";

#[cfg(target_os = "macos")]
mod imp {
    use security_framework::passwords::{
        delete_generic_password, generic_password, set_generic_password_options, PasswordOptions,
    };

    use super::SERVICE;

    fn password_options(account: &str) -> PasswordOptions {
        let mut opts = PasswordOptions::new_generic_password(SERVICE, account);
        opts.set_label("LotDB");
        opts.set_comment("LotDB connection password");
        // Retain compatibility with credentials saved in the protected keychain.
        opts.use_protected_keychain();
        opts
    }

    pub fn store_password(connection_id: &str, password: &str) -> Result<(), String> {
        let data = password.as_bytes();
        // Local unsigned builds may lack the protected-keychain entitlement.
        // Keep the normal login-keychain ACL when falling back.
        let dp = set_generic_password_options(data, password_options(connection_id));
        if dp.is_err() {
            let mut opts = PasswordOptions::new_generic_password(SERVICE, connection_id);
            opts.set_label("LotDB");
            opts.set_comment("LotDB connection password");
            set_generic_password_options(data, opts)
                .map_err(|e| format!("Keychain write failed: {e}"))?;
        }
        Ok(())
    }

    pub fn load_password(connection_id: &str) -> Result<String, String> {
        let opts = password_options(connection_id);
        let bytes = generic_password(opts)
            .or_else(|_| {
                // Items written before data-protection / open-ACL migration.
                security_framework::passwords::get_generic_password(SERVICE, connection_id)
            })
            .map_err(|e| format!("Keychain read failed: {e}"))?;
        String::from_utf8(bytes).map_err(|e| format!("Keychain decode failed: {e}"))
    }

    pub fn delete_password(connection_id: &str) {
        let _ = delete_generic_password(SERVICE, connection_id);
        let _ = security_framework::passwords::delete_generic_password_options(password_options(
            connection_id,
        ));
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn store_password(_connection_id: &str, _password: &str) -> Result<(), String> {
        Err("凭证存储仅支持 macOS".to_string())
    }

    pub fn load_password(_connection_id: &str) -> Result<String, String> {
        Err("凭证存储仅支持 macOS".to_string())
    }

    pub fn delete_password(_connection_id: &str) {}
}

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct PasswordCache {
    passwords: HashMap<String, String>,
}

impl PasswordCache {
    fn load(
        &mut self,
        id: &str,
        read: impl FnOnce() -> Result<String, String>,
    ) -> Result<String, String> {
        if let Some(password) = self.passwords.get(id) {
            return Ok(password.clone());
        }
        let password = read()?;
        self.passwords.insert(id.to_owned(), password.clone());
        Ok(password)
    }

    fn store(
        &mut self,
        id: &str,
        password: &str,
        write: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        write()?;
        self.passwords.insert(id.to_owned(), password.to_owned());
        Ok(())
    }
}

fn cache() -> &'static Mutex<PasswordCache> {
    static CACHE: OnceLock<Mutex<PasswordCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(PasswordCache::default()))
}

pub fn load_password(connection_id: &str) -> Result<String, String> {
    cache()
        .lock()
        .map_err(|_| "Credential cache unavailable".to_string())?
        .load(connection_id, || imp::load_password(connection_id))
}

pub fn store_password(connection_id: &str, password: &str) -> Result<(), String> {
    cache()
        .lock()
        .map_err(|_| "Credential cache unavailable".to_string())?
        .store(connection_id, password, || {
            imp::store_password(connection_id, password)
        })
}

pub fn delete_password(connection_id: &str) {
    // Serialize deletion with reads/writes to prevent stale cache entries.
    let mut cache = cache().lock().unwrap_or_else(|e| e.into_inner());
    cache.passwords.remove(connection_id);
    imp::delete_password(connection_id);
}

/// Keychain APIs are sync and may present a macOS auth dialog. Run them
/// off the async runtime so a stalled dialog cannot freeze IPC.
pub async fn load_password_async(connection_id: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || load_password(&connection_id))
        .await
        .map_err(|e| format!("Keychain task failed: {e}"))?
}

pub async fn store_password_async(connection_id: String, password: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || store_password(&connection_id, &password))
        .await
        .map_err(|e| format!("Keychain task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::PasswordCache;

    #[test]
    fn successful_reads_are_reused_and_accounts_are_isolated() {
        let mut cache = PasswordCache::default();
        assert_eq!(cache.load("a", || Ok("one".into())).unwrap(), "one");
        assert_eq!(
            cache.load("a", || panic!("must not read twice")).unwrap(),
            "one"
        );
        assert_eq!(cache.load("b", || Ok("two".into())).unwrap(), "two");
    }

    #[test]
    fn failed_reads_can_be_retried() {
        let mut cache = PasswordCache::default();
        assert!(cache.load("a", || Err("denied".into())).is_err());
        assert_eq!(cache.load("a", || Ok("retry".into())).unwrap(), "retry");
    }

    #[test]
    fn only_successful_writes_replace_cached_password() {
        let mut cache = PasswordCache::default();
        cache.store("a", "old", || Ok(())).unwrap();
        assert!(cache.store("a", "bad", || Err("denied".into())).is_err());
        assert_eq!(cache.load("a", || panic!()).unwrap(), "old");
        cache.store("a", "new", || Ok(())).unwrap();
        assert_eq!(cache.load("a", || panic!()).unwrap(), "new");
        cache.passwords.remove("a");
        assert_eq!(
            cache.load("a", || Ok("recreated".into())).unwrap(),
            "recreated"
        );
    }
}

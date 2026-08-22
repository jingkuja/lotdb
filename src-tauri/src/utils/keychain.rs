//! Credential storage. macOS uses the system Keychain; other platforms get
//! no-op stubs so the crate compiles for CI (the product targets macOS).

const SERVICE: &str = "com.lotdb.app";

#[cfg(target_os = "macos")]
mod imp {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    use super::SERVICE;

    pub fn store_password(connection_id: &str, password: &str) -> Result<(), String> {
        set_generic_password(SERVICE, connection_id, password.as_bytes())
            .map_err(|e| format!("Keychain write failed: {e}"))
    }

    pub fn load_password(connection_id: &str) -> Result<String, String> {
        let bytes = get_generic_password(SERVICE, connection_id)
            .map_err(|e| format!("Keychain read failed: {e}"))?;
        String::from_utf8(bytes).map_err(|e| format!("Keychain decode failed: {e}"))
    }

    pub fn delete_password(connection_id: &str) {
        // Ignore error — password may not exist
        let _ = delete_generic_password(SERVICE, connection_id);
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

pub use imp::{delete_password, load_password, store_password};

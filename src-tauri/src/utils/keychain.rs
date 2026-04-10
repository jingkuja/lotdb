use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

const SERVICE: &str = "com.lotdb.app";

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

use crate::models::connection::ConnectionConfig;
use crate::utils::keychain;
use sqlx::SqlitePool;
use tauri::State;

type DbPool = SqlitePool;

#[tauri::command]
pub async fn create_connection(
    pool: State<'_, DbPool>,
    config: ConnectionConfig,
) -> Result<ConnectionConfig, String> {
    // Store password in Keychain; save empty string in SQLite
    if !config.password.is_empty() {
        keychain::store_password(&config.id, &config.password)?;
    }

    let ssh_json = config
        .ssh
        .as_ref()
        .map(|s| serde_json::to_string(s).unwrap());
    let ssl_json = config
        .ssl
        .as_ref()
        .map(|s| serde_json::to_string(s).unwrap());

    sqlx::query(
        "INSERT INTO connections (id, name, db_type, host, port, user, database_name, group_id, ssh_config, ssl_config, color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&config.id)
    .bind(&config.name)
    .bind(config.db_type.to_string())
    .bind(&config.host)
    .bind(config.port as i64)
    .bind(&config.user)
    .bind(&config.database)
    .bind(&config.group_id)
    .bind(&ssh_json)
    .bind(&ssl_json)
    .bind(&config.color)
    .execute(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    Ok(config)
}

#[tauri::command]
pub async fn get_connections(pool: State<'_, DbPool>) -> Result<Vec<ConnectionConfig>, String> {
    let rows = sqlx::query_as::<_, ConnectionRow>("SELECT * FROM connections ORDER BY name")
        .fetch_all(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|r| {
            let password = keychain::load_password(&r.id).unwrap_or_default();
            ConnectionConfig::from_row(r, password)
        })
        .collect())
}

#[tauri::command]
pub async fn update_connection(
    pool: State<'_, DbPool>,
    config: ConnectionConfig,
) -> Result<ConnectionConfig, String> {
    // Update Keychain (overwrite existing)
    if !config.password.is_empty() {
        keychain::store_password(&config.id, &config.password)?;
    }

    let ssh_json = config
        .ssh
        .as_ref()
        .map(|s| serde_json::to_string(s).unwrap());
    let ssl_json = config
        .ssl
        .as_ref()
        .map(|s| serde_json::to_string(s).unwrap());

    sqlx::query(
        "UPDATE connections SET name=?, db_type=?, host=?, port=?, user=?, database_name=?, group_id=?, ssh_config=?, ssl_config=?, color=?, updated_at=datetime('now')
         WHERE id=?",
    )
    .bind(&config.name)
    .bind(config.db_type.to_string())
    .bind(&config.host)
    .bind(config.port as i64)
    .bind(&config.user)
    .bind(&config.database)
    .bind(&config.group_id)
    .bind(&ssh_json)
    .bind(&ssl_json)
    .bind(&config.color)
    .bind(&config.id)
    .execute(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    Ok(config)
}

#[tauri::command]
pub async fn delete_connection(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    keychain::delete_password(&id);

    sqlx::query("DELETE FROM connections WHERE id=?")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct ImportConnectionsResult {
    pub imported: u32,
    pub skipped: u32,
}

#[tauri::command]
pub async fn import_connections(
    pool: State<'_, DbPool>,
    configs: Vec<ConnectionConfig>,
) -> Result<ImportConnectionsResult, String> {
    let mut imported = 0u32;
    let mut skipped = 0u32;

    for config in configs {
        // Check if ID already exists
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connections WHERE id=?)")
            .bind(&config.id)
            .fetch_one(pool.inner())
            .await
            .map_err(|e| e.to_string())?;

        if exists {
            skipped += 1;
            continue;
        }

        // Store password in Keychain if provided
        if !config.password.is_empty() {
            keychain::store_password(&config.id, &config.password)?;
        }

        let ssh_json = config
            .ssh
            .as_ref()
            .map(|s| serde_json::to_string(s).unwrap());
        let ssl_json = config
            .ssl
            .as_ref()
            .map(|s| serde_json::to_string(s).unwrap());

        sqlx::query(
            "INSERT INTO connections (id, name, db_type, host, port, user, database_name, group_id, ssh_config, ssl_config, color)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&config.id)
        .bind(&config.name)
        .bind(config.db_type.to_string())
        .bind(&config.host)
        .bind(config.port as i64)
        .bind(&config.user)
        .bind(&config.database)
        .bind(&config.group_id)
        .bind(&ssh_json)
        .bind(&ssl_json)
        .bind(&config.color)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

        imported += 1;
    }

    Ok(ImportConnectionsResult { imported, skipped })
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> Result<String, String> {
    // Re-use the same pool builder (includes SSH tunnel + SSL logic).
    let conn = crate::db::pool::build_connection_pub(&config).await?;
    conn.pool.close().await;

    Ok("连接成功".to_string())
}

// ─── Internal types ────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct ConnectionRow {
    id: String,
    name: String,
    db_type: String,
    host: String,
    port: i64,
    user: String,
    database_name: Option<String>,
    group_id: Option<String>,
    ssh_config: Option<String>,
    ssl_config: Option<String>,
    color: Option<String>,
}

impl ConnectionConfig {
    fn from_row(row: ConnectionRow, password: String) -> Self {
        use crate::models::connection::{DbType, SshConfig, SslConfig};

        let db_type = match row.db_type.as_str() {
            "mysql" => DbType::MySQL,
            _ => DbType::Postgres,
        };

        let ssh: Option<SshConfig> = row.ssh_config.and_then(|s| serde_json::from_str(&s).ok());
        let ssl: Option<SslConfig> = row.ssl_config.and_then(|s| serde_json::from_str(&s).ok());

        ConnectionConfig {
            id: row.id,
            name: row.name,
            db_type,
            host: row.host,
            port: row.port as u16,
            user: row.user,
            password,
            database: row.database_name,
            group_id: row.group_id,
            ssh,
            ssl,
            color: row.color,
        }
    }
}

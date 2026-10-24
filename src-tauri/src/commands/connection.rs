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
    store_secrets(&config).await?;
    insert_connection(pool.inner(), &config).await?;
    Ok(config)
}

/// Passwords go to Keychain; SQLite only ever sees empty strings. An empty
/// password in `config` means "unchanged", so it never clears a stored one.
async fn store_secrets(config: &ConnectionConfig) -> Result<(), String> {
    if !config.password.is_empty() {
        keychain::store_password_async(config.id.clone(), config.password.clone()).await?;
    }
    if let Some(secret) = config.ssh.as_ref().and_then(|s| s.secret()) {
        keychain::store_password_async(keychain::ssh_account(&config.id), secret.to_owned())
            .await?;
    }
    Ok(())
}

/// Fill in passwords the frontend does not have (it never receives them).
pub async fn load_secrets(config: &mut ConnectionConfig) {
    // Off the async runtime — a sync SecItem call can deadlock the IPC loop
    // inside a packaged .app.
    if config.password.is_empty() {
        config.password = keychain::load_password_async(config.id.clone())
            .await
            .unwrap_or_default();
    }
    if let Some(ssh) = config.ssh.as_mut().filter(|s| s.secret().is_none()) {
        if let Ok(secret) = keychain::load_password_async(keychain::ssh_account(&config.id)).await {
            ssh.set_secret(secret);
        }
    }
}

fn ssh_json(config: &ConnectionConfig) -> Option<String> {
    config
        .ssh
        .as_ref()
        .map(|s| serde_json::to_string(&s.without_secrets()).unwrap())
}

async fn insert_connection(pool: &DbPool, config: &ConnectionConfig) -> Result<(), String> {
    let ssl_json = config
        .ssl
        .as_ref()
        .map(|s| serde_json::to_string(s).unwrap());

    sqlx::query(
        "INSERT INTO connections (id, name, db_type, host, port, user, database_name, readonly, group_id, ssh_config, ssl_config, color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&config.id)
    .bind(&config.name)
    .bind(config.db_type.to_string())
    .bind(&config.host)
    .bind(config.port as i64)
    .bind(&config.user)
    .bind(&config.database)
    .bind(config.readonly)
    .bind(&config.group_id)
    .bind(ssh_json(config))
    .bind(&ssl_json)
    .bind(&config.color)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_connections(pool: State<'_, DbPool>) -> Result<Vec<ConnectionConfig>, String> {
    let rows = sqlx::query_as::<_, ConnectionRow>("SELECT * FROM connections ORDER BY name")
        .fetch_all(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

    // Do not touch Keychain here. The packaged .app is a different binary
    // than `tauri dev`, so a sync SecItem read can block forever waiting
    // for an authorization dialog and freeze the sidebar on "加载中".
    // Passwords are loaded on demand in open_connection / test_connection.
    let configs: Vec<ConnectionConfig> = rows
        .into_iter()
        .map(|r| ConnectionConfig::from_row(r, String::new()))
        .collect();

    // Older versions saved SSH passwords in ssh_config. Move them to Keychain
    // in the background, and never hand them to the frontend.
    let legacy: Vec<ConnectionConfig> = configs
        .iter()
        .filter(|c| c.ssh.as_ref().is_some_and(|s| s.secret().is_some()))
        .cloned()
        .collect();
    if !legacy.is_empty() {
        let pool = pool.inner().clone();
        tauri::async_runtime::spawn(async move {
            for config in legacy {
                if store_secrets(&config).await.is_ok() {
                    let _ = sqlx::query("UPDATE connections SET ssh_config=? WHERE id=?")
                        .bind(ssh_json(&config))
                        .bind(&config.id)
                        .execute(&pool)
                        .await;
                }
            }
        });
    }

    Ok(configs
        .into_iter()
        .map(|mut c| {
            c.ssh = c.ssh.map(|s| s.without_secrets());
            c
        })
        .collect())
}

#[tauri::command]
pub async fn update_connection(
    pool: State<'_, DbPool>,
    pools: State<'_, crate::db::pool::PoolManager>,
    registry: State<'_, crate::commands::query::QueryRegistry>,
    config: ConnectionConfig,
) -> Result<ConnectionConfig, String> {
    store_secrets(&config).await?;

    let ssl_json = config
        .ssl
        .as_ref()
        .map(|s| serde_json::to_string(s).unwrap());

    sqlx::query(
        "UPDATE connections SET name=?, db_type=?, host=?, port=?, user=?, database_name=?, readonly=?, group_id=?, ssh_config=?, ssl_config=?, color=?, updated_at=datetime('now')
         WHERE id=?",
    )
    .bind(&config.name)
    .bind(config.db_type.to_string())
    .bind(&config.host)
    .bind(config.port as i64)
    .bind(&config.user)
    .bind(&config.database)
    .bind(config.readonly)
    .bind(&config.group_id)
    .bind(ssh_json(&config))
    .bind(&ssl_json)
    .bind(&config.color)
    .bind(&config.id)
    .execute(pool.inner())
    .await
    .map_err(|e| e.to_string())?;

    // Saved settings and active sessions must not disagree about readonly.
    registry.close_sessions(&config.id);
    pools.close(&config.id).await;

    Ok(config)
}

#[tauri::command]
pub async fn delete_connection(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    keychain::delete_password(&id);
    keychain::delete_password(&keychain::ssh_account(&id));

    sqlx::query("DELETE FROM connections WHERE id=?")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Write all saved connections to `file_path` as JSON. Secrets never leave
/// Keychain: database passwords are blank and SSH credentials are dropped.
#[tauri::command]
pub async fn export_connections(
    pool: State<'_, DbPool>,
    file_path: String,
) -> Result<usize, String> {
    let rows = sqlx::query_as::<_, ConnectionRow>("SELECT * FROM connections ORDER BY name")
        .fetch_all(pool.inner())
        .await
        .map_err(|e| e.to_string())?;
    let configs: Vec<ConnectionConfig> = rows
        .into_iter()
        .map(|r| {
            let mut c = ConnectionConfig::from_row(r, String::new());
            c.ssh = c.ssh.map(|s| s.without_secrets());
            c
        })
        .collect();
    let json = serde_json::to_string_pretty(&configs).map_err(|e| e.to_string())?;
    tokio::fs::write(&file_path, json)
        .await
        .map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(configs.len())
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
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM connections WHERE id=?)")
                .bind(&config.id)
                .fetch_one(pool.inner())
                .await
                .map_err(|e| e.to_string())?;

        if exists {
            skipped += 1;
            continue;
        }

        store_secrets(&config).await?;
        insert_connection(pool.inner(), &config).await?;

        imported += 1;
    }

    Ok(ImportConnectionsResult { imported, skipped })
}

#[tauri::command]
pub async fn test_connection(mut config: ConnectionConfig) -> Result<String, String> {
    load_secrets(&mut config).await;
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
    readonly: bool,
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
            readonly: row.readonly,
            group_id: row.group_id,
            ssh,
            ssl,
            color: row.color,
        }
    }
}

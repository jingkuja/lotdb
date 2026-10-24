use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::time::Duration;

pub async fn init_local_db(app_data_dir: PathBuf) -> Result<SqlitePool, sqlx::Error> {
    std::fs::create_dir_all(&app_data_dir).ok();
    let db_path = app_data_dir.join("lotdb.db");

    // Use filename() instead of a sqlite: URL — app_data_dir contains
    // "Application Support" and URL-parsing spaces can hang or mis-resolve.
    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts)
        .await?;

    // Run migrations
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            db_type TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            user TEXT NOT NULL,
            database_name TEXT,
            group_id TEXT,
            ssh_config TEXT,
            ssl_config TEXT,
            color TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await?;

    // Migration: readonly flag (added after first release) — ignore
    // "duplicate column" errors from databases that already have it.
    let _ = sqlx::query("ALTER TABLE connections ADD COLUMN readonly INTEGER NOT NULL DEFAULT 0")
        .execute(&pool)
        .await;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS connection_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS snippets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sql TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS query_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id TEXT NOT NULL,
            connection_name TEXT NOT NULL,
            sql TEXT NOT NULL,
            status TEXT NOT NULL,
            rows_affected INTEGER,
            execution_ms INTEGER,
            error_message TEXT,
            executed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_query_history_connection \
         ON query_history (connection_id, id)",
    )
    .execute(&pool)
    .await?;

    redact_saved_history(&pool).await?;

    Ok(pool)
}

/// History written before passwords were masked: rewrite those rows once.
/// The LIKE filter keeps this a cheap no-op on later starts.
async fn redact_saved_history(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT id, sql, error_message FROM query_history \
         WHERE sql LIKE '%IDENTIFIED%' OR sql LIKE '%PASSWORD%'",
    )
    .fetch_all(pool)
    .await?;
    for (id, sql, error) in rows {
        let masked = crate::utils::sql::redact_secrets(&sql);
        let masked_error = error.as_deref().map(crate::utils::sql::redact_secrets);
        if masked != sql || masked_error != error {
            sqlx::query("UPDATE query_history SET sql = ?, error_message = ? WHERE id = ?")
                .bind(masked)
                .bind(masked_error)
                .bind(id)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

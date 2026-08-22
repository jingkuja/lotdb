use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use std::path::PathBuf;

pub async fn init_local_db(app_data_dir: PathBuf) -> Result<SqlitePool, sqlx::Error> {
    std::fs::create_dir_all(&app_data_dir).ok();
    let db_path = app_data_dir.join("lotdb.db");
    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&db_url)
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

    Ok(pool)
}

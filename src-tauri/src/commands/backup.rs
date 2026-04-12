use crate::db::pool::PoolManager;
use crate::utils::keychain;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::process::Command;
use tauri::State;

// ─── Result types ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub file_path: String,
    pub size_bytes: u64,
    pub stderr_output: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub rows_affected: u64,
    pub stderr_output: String,
}

// ─── helpers ──────────────────────────────────────────────────────

/// Search common locations for a CLI tool (mysqldump / pg_dump / mysql / psql).
fn find_tool(name: &str) -> Result<std::path::PathBuf, String> {
    // Try PATH first
    if let Ok(p) = which_path(name) {
        return Ok(p);
    }
    // macOS Homebrew locations
    let candidates = [
        format!("/opt/homebrew/bin/{name}"),        // Apple Silicon
        format!("/usr/local/bin/{name}"),            // Intel Homebrew
        format!("/usr/local/mysql/bin/{name}"),      // MySQL installer
        format!("/opt/homebrew/opt/mysql-client/bin/{name}"),
        format!("/opt/homebrew/opt/postgresql@16/bin/{name}"),
        format!("/opt/homebrew/opt/postgresql@15/bin/{name}"),
        format!("/opt/homebrew/opt/postgresql/bin/{name}"),
        format!("/usr/bin/{name}"),
    ];
    for c in &candidates {
        let p = std::path::Path::new(c);
        if p.exists() {
            return Ok(p.to_path_buf());
        }
    }
    Err(format!(
        "找不到 `{name}`，请安装 MySQL 或 PostgreSQL 客户端工具并确保它们在 PATH 中"
    ))
}

fn which_path(name: &str) -> Result<std::path::PathBuf, ()> {
    let out = Command::new("which").arg(name).output().map_err(|_| ())?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return Ok(std::path::PathBuf::from(s));
        }
    }
    Err(())
}

// ─── Fetch connection config from SQLite ──────────────────────────

#[derive(sqlx::FromRow)]
struct ConnRow {
    user: String,
}

async fn get_conn_row(
    sqlite: &SqlitePool,
    connection_id: &str,
) -> Result<ConnRow, String> {
    sqlx::query_as::<_, ConnRow>(
        "SELECT user FROM connections WHERE id = ?",
    )
    .bind(connection_id)
    .fetch_one(sqlite)
    .await
    .map_err(|e| format!("查询连接配置失败: {e}"))
}

// ─── Backup command ───────────────────────────────────────────────

/// Dump a database to a file using mysqldump or pg_dump.
///
/// - `database`: database name to dump
/// - `file_path`: absolute path for the output .sql file
/// - `no_data`: dump schema only (--no-data / --schema-only)
/// - `no_schema`: dump data only (--no-create-info / --data-only)
/// - `tables`: optional list of specific tables; empty = all
#[tauri::command]
pub async fn backup_database(
    pools: State<'_, PoolManager>,
    sqlite: State<'_, SqlitePool>,
    connection_id: String,
    database: String,
    file_path: String,
    no_data: bool,
    no_schema: bool,
    tables: Vec<String>,
) -> Result<BackupResult, String> {
    // Get effective host/port from active pool (handles SSH tunnels)
    let (eff_host, eff_port, db_kind) = {
        let entry = pools
            .pools
            .get(&connection_id)
            .ok_or_else(|| format!("连接 {connection_id} 未打开，请先连接"))?;
        (
            entry.effective_host.clone(),
            entry.effective_port,
            entry.pool.db_type().to_string(),
        )
    };

    // Get user + password from SQLite + Keychain
    let row = get_conn_row(&sqlite, &connection_id).await?;
    let password = keychain::load_password(&connection_id).unwrap_or_default();

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&file_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败: {e}"))?;
    }

    let output = match db_kind.as_str() {
        "mysql" => run_mysqldump(
            &eff_host, eff_port, &row.user, &password, &database,
            &file_path, no_data, no_schema, &tables,
        )?,
        _ => run_pg_dump(
            &eff_host, eff_port, &row.user, &password, &database,
            &file_path, no_data, no_schema, &tables,
        )?,
    };

    let size_bytes = std::fs::metadata(&file_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(BackupResult {
        file_path,
        size_bytes,
        stderr_output: output,
    })
}

fn run_mysqldump(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    file_path: &str,
    no_data: bool,
    no_schema: bool,
    tables: &[String],
) -> Result<String, String> {
    let tool = find_tool("mysqldump")?;
    let mut cmd = Command::new(&tool);

    cmd.arg(format!("-h{host}"))
        .arg(format!("-P{port}"))
        .arg(format!("-u{user}"));

    if !password.is_empty() {
        cmd.arg(format!("-p{password}"));
    }

    // Useful defaults
    cmd.arg("--single-transaction")
        .arg("--routines")
        .arg("--triggers")
        .arg("--set-gtid-purged=OFF");

    if no_data {
        cmd.arg("--no-data");
    }
    if no_schema {
        cmd.arg("--no-create-info");
    }

    cmd.arg(database);

    for t in tables {
        cmd.arg(t);
    }

    // Redirect stdout to file
    let file = std::fs::File::create(file_path)
        .map_err(|e| format!("创建备份文件失败: {e}"))?;
    cmd.stdout(file);

    let out = cmd
        .output()
        .map_err(|e| format!("启动 mysqldump 失败: {e}"))?;

    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    if !out.status.success() {
        return Err(format!(
            "mysqldump 失败 (exit {}): {}",
            out.status.code().unwrap_or(-1),
            stderr
        ));
    }

    Ok(stderr)
}

fn run_pg_dump(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    file_path: &str,
    no_data: bool,
    no_schema: bool,
    tables: &[String],
) -> Result<String, String> {
    let tool = find_tool("pg_dump")?;
    let mut cmd = Command::new(&tool);

    cmd.arg("-h").arg(host)
        .arg("-p").arg(port.to_string())
        .arg("-U").arg(user)
        .arg("-d").arg(database)
        .arg("-f").arg(file_path)
        .arg("--no-password"); // password via env var PGPASSWORD

    if no_data {
        cmd.arg("--schema-only");
    }
    if no_schema {
        cmd.arg("--data-only");
    }

    for t in tables {
        cmd.arg("-t").arg(t);
    }

    if !password.is_empty() {
        cmd.env("PGPASSWORD", password);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("启动 pg_dump 失败: {e}"))?;

    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    if !out.status.success() {
        return Err(format!(
            "pg_dump 失败 (exit {}): {}",
            out.status.code().unwrap_or(-1),
            stderr
        ));
    }

    Ok(stderr)
}

// ─── Restore command ──────────────────────────────────────────────

/// Restore a database from a SQL dump file using mysql or psql.
///
/// - `database`: target database name
/// - `file_path`: absolute path to the .sql dump file
/// - `create_db`: run CREATE DATABASE IF NOT EXISTS before restoring (MySQL only)
#[tauri::command]
pub async fn restore_database(
    pools: State<'_, PoolManager>,
    sqlite: State<'_, SqlitePool>,
    connection_id: String,
    database: String,
    file_path: String,
    create_db: bool,
) -> Result<RestoreResult, String> {
    let (eff_host, eff_port, db_kind) = {
        let entry = pools
            .pools
            .get(&connection_id)
            .ok_or_else(|| format!("连接 {connection_id} 未打开，请先连接"))?;
        (
            entry.effective_host.clone(),
            entry.effective_port,
            entry.pool.db_type().to_string(),
        )
    };

    let row = get_conn_row(&sqlite, &connection_id).await?;
    let password = keychain::load_password(&connection_id).unwrap_or_default();

    // Verify file exists
    if !std::path::Path::new(&file_path).exists() {
        return Err(format!("文件不存在: {file_path}"));
    }

    let stderr = match db_kind.as_str() {
        "mysql" => run_mysql_restore(
            &eff_host, eff_port, &row.user, &password, &database,
            &file_path, create_db,
        )?,
        _ => run_psql_restore(
            &eff_host, eff_port, &row.user, &password, &database,
            &file_path,
        )?,
    };

    Ok(RestoreResult {
        rows_affected: 0, // CLI tools don't reliably report this
        stderr_output: stderr,
    })
}

fn run_mysql_restore(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    file_path: &str,
    create_db: bool,
) -> Result<String, String> {
    // Optionally create the database first
    if create_db {
        let tool = find_tool("mysql")?;
        let mut cmd = Command::new(&tool);
        cmd.arg(format!("-h{host}"))
            .arg(format!("-P{port}"))
            .arg(format!("-u{user}"));
        if !password.is_empty() {
            cmd.arg(format!("-p{password}"));
        }
        cmd.arg("-e")
            .arg(format!("CREATE DATABASE IF NOT EXISTS `{database}`"));
        let out = cmd.output().map_err(|e| format!("启动 mysql 失败: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(format!("创建数据库失败: {stderr}"));
        }
    }

    let tool = find_tool("mysql")?;
    let mut cmd = Command::new(&tool);
    cmd.arg(format!("-h{host}"))
        .arg(format!("-P{port}"))
        .arg(format!("-u{user}"));
    if !password.is_empty() {
        cmd.arg(format!("-p{password}"));
    }
    cmd.arg(database);

    // Feed file via stdin
    let file = std::fs::File::open(file_path)
        .map_err(|e| format!("打开备份文件失败: {e}"))?;
    cmd.stdin(file);

    let out = cmd
        .output()
        .map_err(|e| format!("启动 mysql 失败: {e}"))?;

    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    if !out.status.success() {
        return Err(format!(
            "mysql 恢复失败 (exit {}): {}",
            out.status.code().unwrap_or(-1),
            stderr
        ));
    }

    Ok(stderr)
}

fn run_psql_restore(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
    file_path: &str,
) -> Result<String, String> {
    let tool = find_tool("psql")?;
    let mut cmd = Command::new(&tool);

    cmd.arg("-h").arg(host)
        .arg("-p").arg(port.to_string())
        .arg("-U").arg(user)
        .arg("-d").arg(database)
        .arg("-f").arg(file_path)
        .arg("--no-password");

    if !password.is_empty() {
        cmd.env("PGPASSWORD", password);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("启动 psql 失败: {e}"))?;

    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    // psql exits non-zero on SQL errors but still restores partial data;
    // treat as success but surface stderr.
    let _ = out.status;

    Ok(stderr)
}

use crate::commands::transfer::{TransferControl, TransferRegistry};
use crate::db::pool::{DbPool, PoolManager};
use crate::error::{AppError, ResultExt};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

/// Emitted about twice a second while a dump/restore runs. For a backup
/// `done` is the bytes written so far and `total` is 0 (unknown); for a
/// restore it is the bytes of the dump file fed to the client.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupProgress {
    task_id: String,
    done: u64,
    total: u64,
}

// ─── helpers ──────────────────────────────────────────────────────

/// Search PATH, then common install locations, for a CLI tool (mysqldump /
/// pg_dump / mysql / psql). Only stat calls: no `which` child process runs
/// on the async runtime. A GUI app's PATH is minimal, hence the fallbacks.
fn find_tool(name: &str) -> Result<std::path::PathBuf, AppError> {
    let path_dirs = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    let fallback_dirs = [
        "/opt/homebrew/bin",    // Apple Silicon
        "/usr/local/bin",       // Intel Homebrew
        "/usr/local/mysql/bin", // MySQL installer
        "/opt/homebrew/opt/mysql-client/bin",
        "/opt/homebrew/opt/postgresql@18/bin",
        "/opt/homebrew/opt/postgresql@17/bin",
        "/opt/homebrew/opt/postgresql@16/bin",
        "/opt/homebrew/opt/postgresql@15/bin",
        "/opt/homebrew/opt/postgresql/bin",
        "/usr/bin",
    ];
    path_dirs
        .into_iter()
        .chain(fallback_dirs.iter().map(std::path::PathBuf::from))
        .map(|dir| dir.join(name))
        .find(|p| is_executable(p))
        .ok_or_else(|| {
            AppError::io(format!(
                "找不到 `{name}`，请安装 MySQL 或 PostgreSQL 客户端工具并确保它们在 PATH 中"
            ))
        })
}

fn is_executable(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// Effective host/port (SSH tunnels resolve to 127.0.0.1:<local port>),
/// credentials and the main pool of an open connection. Credentials come from
/// memory — they were loaded from Keychain when the connection was opened.
struct ConnTarget {
    host: String,
    port: u16,
    user: String,
    password: String,
    pool: DbPool,
}

fn conn_target(pools: &PoolManager, connection_id: &str) -> Result<ConnTarget, AppError> {
    let pool = pools.pool(connection_id)?;
    let (host, port) = pools.effective_address(connection_id)?;
    let (user, password) = pools
        .credentials(connection_id)
        .ok_or_else(|| AppError::connection(format!("连接 {connection_id} 未打开，请先连接")))?;
    Ok(ConnTarget {
        host,
        port,
        user,
        password,
        pool,
    })
}

/// mysql / mysqldump read credentials from a 0600 option file passed with
/// `--defaults-extra-file`, so the password never shows up in `ps` (argv)
/// and does not rely on the deprecated MYSQL_PWD. Deleted on drop.
struct MySqlOptionFile(std::path::PathBuf);

impl MySqlOptionFile {
    fn create(user: &str, password: &str) -> Result<Self, AppError> {
        let path = std::env::temp_dir().join(format!("lotdb-{}.cnf", uuid::Uuid::new_v4()));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&path).ctx("创建临时凭据文件失败")?;
        let guard = MySqlOptionFile(path);
        let mut content = format!("[client]\nuser={}\n", option_value(user));
        if !password.is_empty() {
            content.push_str(&format!("password={}\n", option_value(password)));
        }
        file.write_all(content.as_bytes())
            .ctx("写入临时凭据文件失败")?;
        Ok(guard)
    }

    /// Must be the first argument on the command line.
    fn arg(&self) -> String {
        format!("--defaults-extra-file={}", self.0.display())
    }
}

impl Drop for MySqlOptionFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Double-quoted option-file value; `#` inside quotes is not a comment.
fn option_value(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

/// Run a CLI tool without blocking the async runtime. The child is killed
/// when the task is cancelled. `stdin_file` is streamed into the child so a
/// restore can report how much of the dump has been sent; `output_file` is
/// polled for size so a backup can report bytes written.
async fn run_tool(
    app: &tauri::AppHandle,
    task_id: &str,
    control: &TransferControl,
    mut cmd: tokio::process::Command,
    stdin_file: Option<&str>,
    output_file: Option<&str>,
) -> Result<(std::process::ExitStatus, String), AppError> {
    cmd.kill_on_drop(true)
        .stderr(Stdio::piped())
        .stdin(if stdin_file.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = cmd.spawn().ctx("启动外部工具失败")?;

    let mut stderr = child.stderr.take().expect("stderr is piped");
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let sent = Arc::new(AtomicU64::new(0));
    let mut total = 0;
    if let Some(path) = stdin_file {
        let mut file = tokio::fs::File::open(path).await.ctx("打开备份文件失败")?;
        total = file.metadata().await.map(|m| m.len()).unwrap_or(0);
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let sent = sent.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = match file.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                // The client exits early on errors (ON_ERROR_STOP); stop feeding.
                if stdin.write_all(&buf[..n]).await.is_err() {
                    break;
                }
                sent.fetch_add(n as u64, Ordering::Relaxed);
            }
            // Dropping stdin sends EOF.
        });
    }

    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let status = loop {
        if control.cancelled.load(Ordering::Acquire) {
            let _ = child.kill().await;
            return Err(AppError::io("已取消"));
        }
        tokio::select! {
            status = child.wait() => break status.ctx("等待外部工具失败")?,
            _ = control.notify.notified() => {
                let _ = child.kill().await;
                return Err(AppError::io("已取消"));
            }
            _ = tick.tick() => {
                let done = match output_file {
                    Some(path) => tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0),
                    None => sent.load(Ordering::Relaxed),
                };
                let _ = app.emit(
                    "backup-progress",
                    BackupProgress { task_id: task_id.to_owned(), done, total },
                );
            }
        }
    };
    let stderr = stderr_task.await.unwrap_or_default();
    Ok((status, stderr))
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(-1)
}

// ─── Backup command ───────────────────────────────────────────────

/// Dump a database to a file using mysqldump or pg_dump.
///
/// - `database`: database name to dump
/// - `file_path`: absolute path for the output .sql file
/// - `no_data`: dump schema only (--no-data / --schema-only)
/// - `no_schema`: dump data only (--no-create-info / --data-only)
/// - `tables`: optional list of specific tables; empty = all
/// - `task_id`: pass the same id to `cancel_transfer` to stop the dump
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn backup_database(
    app: tauri::AppHandle,
    pools: State<'_, PoolManager>,
    registry: State<'_, TransferRegistry>,
    task_id: Option<String>,
    connection_id: String,
    database: String,
    file_path: String,
    no_data: bool,
    no_schema: bool,
    tables: Vec<String>,
) -> Result<BackupResult, AppError> {
    let target = conn_target(&pools, &connection_id)?;

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&file_path).parent() {
        std::fs::create_dir_all(parent).ctx("创建目录失败")?;
    }

    let task_id = task_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let control = registry.register(&task_id)?;
    let result = match &target.pool {
        DbPool::MySQL(_) => {
            run_mysqldump(
                &app, &task_id, &control, &target, &database, &file_path, no_data, no_schema,
                &tables,
            )
            .await
        }
        DbPool::Postgres(_) => {
            run_pg_dump(
                &app, &task_id, &control, &target, &database, &file_path, no_data, no_schema,
                &tables,
            )
            .await
        }
    };
    registry.finish(&task_id);
    // A cancelled or failed dump leaves a truncated file behind; remove it
    // so it cannot be mistaken for a usable backup later.
    let output = result.inspect_err(|_| {
        let _ = std::fs::remove_file(&file_path);
    })?;

    let size_bytes = std::fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);

    Ok(BackupResult {
        file_path,
        size_bytes,
        stderr_output: output,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_mysqldump(
    app: &tauri::AppHandle,
    task_id: &str,
    control: &TransferControl,
    target: &ConnTarget,
    database: &str,
    file_path: &str,
    no_data: bool,
    no_schema: bool,
    tables: &[String],
) -> Result<String, AppError> {
    let tool = find_tool("mysqldump")?;
    let options = MySqlOptionFile::create(&target.user, &target.password)?;
    let mut cmd = tokio::process::Command::new(&tool);

    cmd.arg(options.arg())
        .arg(format!("-h{}", target.host))
        .arg(format!("-P{}", target.port));

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
    let file = std::fs::File::create(file_path).ctx("创建备份文件失败")?;
    cmd.stdout(file);

    let (status, stderr) = run_tool(app, task_id, control, cmd, None, Some(file_path)).await?;

    if !status.success() {
        return Err(AppError::io(format!(
            "mysqldump 失败 (exit {}): {}",
            exit_code(status),
            stderr
        )));
    }

    Ok(stderr)
}

#[allow(clippy::too_many_arguments)]
async fn run_pg_dump(
    app: &tauri::AppHandle,
    task_id: &str,
    control: &TransferControl,
    target: &ConnTarget,
    database: &str,
    file_path: &str,
    no_data: bool,
    no_schema: bool,
    tables: &[String],
) -> Result<String, AppError> {
    let tool = find_tool("pg_dump")?;
    let mut cmd = tokio::process::Command::new(&tool);

    cmd.arg("-h")
        .arg(&target.host)
        .arg("-p")
        .arg(target.port.to_string())
        .arg("-U")
        .arg(&target.user)
        .arg("-d")
        .arg(database)
        .arg("-f")
        .arg(file_path)
        .arg("--no-password") // password via env var PGPASSWORD
        .stdout(Stdio::null());

    if no_data {
        cmd.arg("--schema-only");
    }
    if no_schema {
        cmd.arg("--data-only");
    }

    for t in tables {
        cmd.arg("-t").arg(t);
    }

    if !target.password.is_empty() {
        cmd.env("PGPASSWORD", &target.password);
    }

    let (status, stderr) = run_tool(app, task_id, control, cmd, None, Some(file_path)).await?;

    if !status.success() {
        return Err(AppError::io(format!(
            "pg_dump 失败 (exit {}): {}",
            exit_code(status),
            stderr
        )));
    }

    Ok(stderr)
}

// ─── Restore command ──────────────────────────────────────────────

/// Restore a database from a SQL dump file using mysql or psql.
///
/// - `database`: target database name
/// - `file_path`: absolute path to the .sql dump file
/// - `create_db`: run CREATE DATABASE IF NOT EXISTS before restoring (MySQL only)
/// - `task_id`: pass the same id to `cancel_transfer` to stop the restore
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn restore_database(
    app: tauri::AppHandle,
    pools: State<'_, PoolManager>,
    registry: State<'_, TransferRegistry>,
    task_id: Option<String>,
    connection_id: String,
    database: String,
    file_path: String,
    create_db: bool,
) -> Result<RestoreResult, AppError> {
    pools.ensure_writable(&connection_id)?;
    let target = conn_target(&pools, &connection_id)?;

    // Verify file exists
    if !std::path::Path::new(&file_path).exists() {
        return Err(AppError::io(format!("文件不存在: {file_path}")));
    }

    let task_id = task_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let control = registry.register(&task_id)?;
    let result = match &target.pool {
        DbPool::MySQL(_) => {
            if create_db {
                let sql = format!(
                    "CREATE DATABASE IF NOT EXISTS {}",
                    crate::utils::sql::quote_ident_mysql(&database)
                );
                if let Err(e) = target.pool.execute(&sql).await {
                    registry.finish(&task_id);
                    return Err(AppError::from_sqlx("创建数据库失败", e));
                }
            }
            run_mysql_restore(&app, &task_id, &control, &target, &database, &file_path).await
        }
        DbPool::Postgres(_) => {
            run_psql_restore(&app, &task_id, &control, &target, &database, &file_path).await
        }
    };
    registry.finish(&task_id);

    Ok(RestoreResult {
        rows_affected: 0, // CLI tools don't reliably report this
        stderr_output: result?,
    })
}

async fn run_mysql_restore(
    app: &tauri::AppHandle,
    task_id: &str,
    control: &TransferControl,
    target: &ConnTarget,
    database: &str,
    file_path: &str,
) -> Result<String, AppError> {
    let tool = find_tool("mysql")?;
    let options = MySqlOptionFile::create(&target.user, &target.password)?;
    let mut cmd = tokio::process::Command::new(&tool);
    cmd.arg(options.arg())
        .arg(format!("-h{}", target.host))
        .arg(format!("-P{}", target.port))
        .arg(database)
        .stdout(Stdio::null());

    let (status, stderr) = run_tool(app, task_id, control, cmd, Some(file_path), None).await?;

    if !status.success() {
        return Err(AppError::io(format!(
            "mysql 恢复失败 (exit {}): {}",
            exit_code(status),
            stderr
        )));
    }

    Ok(stderr)
}

async fn run_psql_restore(
    app: &tauri::AppHandle,
    task_id: &str,
    control: &TransferControl,
    target: &ConnTarget,
    database: &str,
    file_path: &str,
) -> Result<String, AppError> {
    let tool = find_tool("psql")?;
    let mut cmd = tokio::process::Command::new(&tool);

    // Stop at the first error inside one transaction: a failed restore rolls
    // back completely instead of leaving a half-restored database. -X skips
    // ~/.psqlrc so user settings cannot change the behavior.
    cmd.arg("-h")
        .arg(&target.host)
        .arg("-p")
        .arg(target.port.to_string())
        .arg("-U")
        .arg(&target.user)
        .arg("-d")
        .arg(database)
        .arg("-X")
        .arg("-v")
        .arg("ON_ERROR_STOP=1")
        .arg("--single-transaction")
        .arg("--no-password")
        .stdout(Stdio::null());

    if !target.password.is_empty() {
        cmd.env("PGPASSWORD", &target.password);
    }

    let (status, stderr) = run_tool(app, task_id, control, cmd, Some(file_path), None).await?;

    if !status.success() {
        return Err(AppError::io(format!(
            "psql 恢复失败，已回滚 (exit {}): {}",
            exit_code(status),
            stderr
        )));
    }

    Ok(stderr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_values_survive_special_characters() {
        assert_eq!(option_value(r#"p#a"s\w"#), r#""p#a\"s\\w""#);
        assert_eq!(option_value("a\nb"), r#""a\nb""#);
    }

    #[test]
    fn option_file_is_private_and_removed() {
        let file = MySqlOptionFile::create("root", "secret").unwrap();
        let path = file.0.clone();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("password=\"secret\""));
        drop(file);
        assert!(!path.exists());
    }
}

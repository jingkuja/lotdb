use crate::db::pool::PoolManager;
use crate::db::value::{mysql_value_to_json, pg_value_to_json};
use crate::error::AppError;
use crate::models::connection::ConnectionConfig;
use crate::utils::keychain;
use dashmap::DashMap;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{Arguments, Column, Row};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;
use tauri::State;
use tokio::sync::Mutex;

/// Default cap on how many rows a single query may return to the UI.
const DEFAULT_MAX_ROWS: u64 = 1000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_ms: u128,
    /// True when the result set had more rows than the returned cap.
    pub truncated: bool,
}

/// A query currently running on a pinned connection, cancellable by ID.
#[derive(Debug, Clone)]
pub struct RunningQuery {
    pub connection_id: String,
    /// MySQL CONNECTION_ID() / PG pg_backend_pid() of the pinned connection.
    pub session_id: u64,
    cancelled: Arc<AtomicBool>,
}

/// Registry of in-flight executions, keyed by the frontend-generated execution ID.
#[derive(Default)]
pub struct QueryRegistry {
    pub running: DashMap<String, RunningQuery>,
    sessions: DashMap<(String, String), Arc<Mutex<Option<QuerySession>>>>,
}

enum QuerySession {
    MySQL(sqlx::MySqlConnection),
    Postgres(sqlx::PgConnection),
}

impl QueryRegistry {
    pub fn close_sessions(&self, connection_id: &str) {
        self.sessions.retain(|(id, _), _| id != connection_id);
    }
}

#[tauri::command]
pub fn close_query_session(
    registry: State<'_, QueryRegistry>,
    connection_id: String,
    session_id: String,
) {
    registry.sessions.remove(&(connection_id, session_id));
}

/// How to execute a statement: fetch rows, or execute and take rows_affected.
#[derive(Debug, PartialEq, Eq)]
pub enum StmtKind {
    Rows,
    Execute,
}

/// Classify a statement by its leading keyword.
///
/// SELECT/SHOW/EXPLAIN/… return a result set and must go through fetch;
/// everything else (INSERT/UPDATE/DELETE/DDL) must go through execute(),
/// otherwise rows_affected() is silently 0.
fn classify_statement(sql: &str) -> StmtKind {
    match first_keyword(sql).as_deref() {
        Some(
            "SELECT" | "SHOW" | "EXPLAIN" | "DESC" | "DESCRIBE" | "ANALYZE" | "TABLE" | "VALUES"
            | "CALL" | "PRAGMA",
        ) => StmtKind::Rows,
        Some("WITH") => with_clause_kind(sql),
        _ => StmtKind::Execute,
    }
}

/// First alphabetic keyword of the statement, uppercased; skips leading
/// whitespace and comments (`--`, `#`, `/* */`).
fn first_keyword(sql: &str) -> Option<String> {
    let bytes = sql.as_bytes();
    let mut i = 0;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if sql[i..].starts_with("--") || sql[i..].starts_with('#') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if sql[i..].starts_with("/*") {
            match sql[i + 2..].find("*/") {
                Some(end) => {
                    i = (i + 2 + end + 2).min(bytes.len());
                    continue;
                }
                None => return None,
            }
        }
        break;
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    if start == i {
        None
    } else {
        Some(sql[start..i].to_ascii_uppercase())
    }
}

/// For `WITH …`: the top-level verb after the last CTE decides the kind.
/// `WITH x AS (…) SELECT …` → Rows; `WITH x AS (…) INSERT …` → Execute.
fn with_clause_kind(sql: &str) -> StmtKind {
    let bytes = sql.as_bytes();
    let mut depth: i32 = 0;
    // True right after a CTE body's `)` at depth 0 — the next depth-0 word
    // is then the main verb (unless a `,` or `AS` follows, i.e. another CTE).
    let mut after_cte_close = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'\'' | b'"' | b'`' => {
                // Skip quoted string, honoring doubled quote escapes.
                let quote = c;
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' && quote == b'\'' {
                        i += 2;
                        continue;
                    }
                    if bytes[i] == quote {
                        if i + 1 < bytes.len() && bytes[i + 1] == quote {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    after_cte_close = true;
                }
                i += 1;
            }
            b',' if depth == 0 => {
                after_cte_close = false;
                i += 1;
            }
            _ => {
                if depth == 0 && c.is_ascii_alphabetic() {
                    let start = i;
                    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                    let word = sql[start..i].to_ascii_uppercase();
                    if word == "AS" {
                        // CTE column list / definition follows, not the main verb.
                        after_cte_close = false;
                    } else if after_cte_close {
                        return match word.as_str() {
                            "INSERT" | "UPDATE" | "DELETE" | "MERGE" => StmtKind::Execute,
                            _ => StmtKind::Rows,
                        };
                    }
                } else {
                    i += 1;
                }
            }
        }
    }
    StmtKind::Rows
}

/// Open (or re-open) a connection pool for a saved connection config.
#[tauri::command]
pub async fn open_connection(
    pools: State<'_, PoolManager>,
    registry: State<'_, QueryRegistry>,
    mut config: ConnectionConfig,
) -> Result<(), AppError> {
    // Load password from Keychain if not provided (off the async runtime —
    // a sync SecItem call can deadlock the IPC loop inside a packaged .app).
    if config.password.is_empty() {
        config.password = keychain::load_password_async(config.id.clone())
            .await
            .unwrap_or_default();
    }
    registry.close_sessions(&config.id);
    pools.open(&config).await.map_err(AppError::connection)
}

/// Close an active connection pool.
#[tauri::command]
pub async fn close_connection(
    pools: State<'_, PoolManager>,
    registry: State<'_, QueryRegistry>,
    id: String,
) -> Result<(), AppError> {
    registry.close_sessions(&id);
    pools.close(&id).await;
    Ok(())
}

/// Return IDs of all currently open connection pools.
#[tauri::command]
pub fn get_active_connections(pools: State<'_, PoolManager>) -> Vec<String> {
    pools.active_ids()
}

/// Cancel a running query by its execution ID.
///
/// Sends `KILL QUERY` / `pg_cancel_backend` from a *second* pooled
/// connection; the pinned one running the query then fails with the
/// server-side "cancelled" error and `execute_query` returns it.
#[tauri::command]
pub async fn cancel_query(
    pools: State<'_, PoolManager>,
    registry: State<'_, QueryRegistry>,
    execution_id: String,
) -> Result<(), AppError> {
    cancel_query_impl(&pools, &registry, &execution_id).await
}

/// State-free cancel — shared with integration tests.
pub async fn cancel_query_impl(
    pools: &PoolManager,
    registry: &QueryRegistry,
    execution_id: &str,
) -> Result<(), AppError> {
    let rq = registry
        .running
        .get(execution_id)
        .map(|e| e.value().clone())
        .ok_or_else(|| AppError::sql("查询已结束，无法取消"))?;

    let pool = {
        let entry = pools
            .pools
            .get(&rq.connection_id)
            .ok_or_else(|| AppError::connection(format!("连接 {} 未打开", rq.connection_id)))?;
        match &entry.pool {
            crate::db::pool::DbPool::MySQL(p) => crate::db::pool::DbPool::MySQL(p.clone()),
            crate::db::pool::DbPool::Postgres(p) => crate::db::pool::DbPool::Postgres(p.clone()),
        }
    };

    rq.cancelled.store(true, Ordering::Release);
    let result: Result<(), AppError> = async {
        match &pool {
            crate::db::pool::DbPool::MySQL(pool) => {
                let mut conn = pool
                    .acquire()
                    .await
                    .map_err(|e| AppError::from_sqlx("获取连接失败", e))?;
                sqlx::query(&format!("KILL QUERY {}", rq.session_id))
                    .execute(&mut *conn)
                    .await
                    .map_err(|e| AppError::from_sqlx("取消查询失败", e))?;
            }
            crate::db::pool::DbPool::Postgres(pool) => {
                let mut conn = pool
                    .acquire()
                    .await
                    .map_err(|e| AppError::from_sqlx("获取连接失败", e))?;
                sqlx::query(&format!("SELECT pg_cancel_backend({})", rq.session_id))
                    .execute(&mut *conn)
                    .await
                    .map_err(|e| AppError::from_sqlx("取消查询失败", e))?;
            }
        }

        Ok(())
    }
    .await;
    if result.is_err() {
        rq.cancelled.store(false, Ordering::Release);
    }
    result
}

/// Execute a SQL query and return results.
///
/// - `max_rows`: cap on returned rows (0 = unlimited, None = default 1000).
/// - `execution_id`: when provided, the query is registered for cancellation
///   until it finishes.
#[tauri::command]
pub async fn execute_query(
    pools: State<'_, PoolManager>,
    registry: State<'_, QueryRegistry>,
    connection_id: String,
    sql: String,
    max_rows: Option<u64>,
    execution_id: Option<String>,
    session_id: Option<String>,
) -> Result<QueryResult, AppError> {
    run_session_query(
        &pools,
        &registry,
        &connection_id,
        &sql,
        &[],
        max_rows,
        execution_id.as_deref(),
        session_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn execute_query_with_params(
    pools: State<'_, PoolManager>,
    registry: State<'_, QueryRegistry>,
    connection_id: String,
    sql: String,
    params: Vec<serde_json::Value>,
    max_rows: Option<u64>,
    execution_id: Option<String>,
    session_id: Option<String>,
) -> Result<QueryResult, AppError> {
    run_session_query(
        &pools,
        &registry,
        &connection_id,
        &sql,
        &params,
        max_rows,
        execution_id.as_deref(),
        session_id.as_deref(),
    )
    .await
}

/// State-free query execution — shared by the Tauri command and integration
/// tests. Readonly connections reject DML/DDL here (SELECT/SHOW/… pass).
pub async fn run_query(
    pools: &PoolManager,
    registry: &QueryRegistry,
    connection_id: &str,
    sql: &str,
    max_rows: Option<u64>,
    execution_id: Option<&str>,
) -> Result<QueryResult, AppError> {
    run_session_query(
        pools,
        registry,
        connection_id,
        sql,
        &[],
        max_rows,
        execution_id,
        None,
    )
    .await
}

pub async fn run_query_with_params(
    pools: &PoolManager,
    registry: &QueryRegistry,
    connection_id: &str,
    sql: &str,
    params: &[serde_json::Value],
    max_rows: Option<u64>,
    execution_id: Option<&str>,
) -> Result<QueryResult, AppError> {
    run_session_query(
        pools,
        registry,
        connection_id,
        sql,
        params,
        max_rows,
        execution_id,
        None,
    )
    .await
}

/// A tab owns its physical connection until it closes. Detached connections do
/// not occupy the shared metadata/cancellation pool; dropping closes the socket,
/// so open transactions and session variables never leak to another tab.
#[allow(clippy::too_many_arguments)]
pub async fn run_session_query(
    pools: &PoolManager,
    registry: &QueryRegistry,
    connection_id: &str,
    sql: &str,
    params: &[serde_json::Value],
    max_rows: Option<u64>,
    execution_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<QueryResult, AppError> {
    let pool = {
        let entry = pools
            .pools
            .get(connection_id)
            .ok_or_else(|| AppError::connection(format!("连接 {connection_id} 未打开")))?;
        match &entry.pool {
            crate::db::pool::DbPool::MySQL(p) => crate::db::pool::DbPool::MySQL(p.clone()),
            crate::db::pool::DbPool::Postgres(p) => crate::db::pool::DbPool::Postgres(p.clone()),
        }
    };
    let mysql = matches!(pool, crate::db::pool::DbPool::MySQL(_));
    let readonly = pools.is_readonly(connection_id);
    if readonly {
        crate::utils::sql::readonly_sql(sql, mysql).map_err(AppError::sql)?;
    }
    // Exactly one statement per invocation; frontend scripts reuse session_id.
    if crate::utils::sql::split_sql(sql, mysql)
        .map_err(AppError::sql)?
        .len()
        != 1
    {
        return Err(AppError::sql("请逐条执行 SQL，并保持相同查询会话"));
    }
    let slot = if let Some(id) = session_id {
        registry
            .sessions
            .entry((connection_id.to_string(), id.to_string()))
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    } else {
        Arc::new(Mutex::new(None))
    };
    let mut session = slot.lock().await;
    if session.is_none() {
        *session = Some(match pool {
            crate::db::pool::DbPool::MySQL(p) => QuerySession::MySQL(
                p.acquire()
                    .await
                    .map_err(|e| AppError::from_sqlx("获取会话失败", e))?
                    .detach(),
            ),
            crate::db::pool::DbPool::Postgres(p) => QuerySession::Postgres(
                p.acquire()
                    .await
                    .map_err(|e| AppError::from_sqlx("获取会话失败", e))?
                    .detach(),
            ),
        });
    }
    let kind = classify_statement(sql);
    let max_rows = normalize_max_rows(max_rows);
    let start = Instant::now();
    let result = match session.as_mut().unwrap() {
        QuerySession::MySQL(conn) => {
            let pid = mysql_session_id(conn).await?;
            let _guard = CancellationGuard::register(registry, execution_id, connection_id, pid);
            let args = if params.is_empty() {
                MySqlArgs::None
            } else {
                let mut args = sqlx::mysql::MySqlArguments::default();
                for p in params {
                    bind_mysql_arg(&mut args, p)?;
                }
                MySqlArgs::Some(args)
            };
            if readonly {
                sqlx::Executor::execute(&mut *conn, "START TRANSACTION READ ONLY")
                    .await
                    .map_err(|e| AppError::from_sqlx("开启只读事务失败", e))?;
            }
            let result = run_mysql(conn, sql, kind, max_rows, args).await;
            if readonly {
                sqlx::Executor::execute(&mut *conn, "ROLLBACK")
                    .await
                    .map_err(|e| AppError::from_sqlx("结束只读事务失败", e))?;
            }
            if _guard.cancelled.load(Ordering::Acquire) {
                return Err(AppError::sql("查询已取消"));
            }
            result
        }
        QuerySession::Postgres(conn) => {
            let pid = pg_session_id(conn).await?;
            let _guard = CancellationGuard::register(registry, execution_id, connection_id, pid);
            let args = if params.is_empty() {
                PgArgs::None
            } else {
                let mut args = sqlx::postgres::PgArguments::default();
                for p in params {
                    bind_pg_arg(&mut args, p)?;
                }
                PgArgs::Some(args)
            };
            if readonly {
                sqlx::Executor::execute(&mut *conn, "START TRANSACTION READ ONLY")
                    .await
                    .map_err(|e| AppError::from_sqlx("开启只读事务失败", e))?;
            }
            let result = run_postgres(conn, sql, kind, max_rows, args).await;
            if readonly {
                sqlx::Executor::execute(&mut *conn, "ROLLBACK")
                    .await
                    .map_err(|e| AppError::from_sqlx("结束只读事务失败", e))?;
            }
            if _guard.cancelled.load(Ordering::Acquire) {
                return Err(AppError::sql("查询已取消"));
            }
            result
        }
    };
    // Do not reconnect automatically after a broken transaction/session.
    result.map(|(columns, rows, affected_rows, truncated)| QueryResult {
        columns,
        rows,
        affected_rows,
        truncated,
        execution_ms: start.elapsed().as_millis(),
    })
}

/// Reject Execute-kind statements (DML/DDL) on readonly connections.
/// Also exposed for `execute_statements` which only ever runs DML.
pub fn ensure_writable(
    pools: &PoolManager,
    connection_id: &str,
    kind: StmtKind,
) -> Result<(), AppError> {
    if kind == StmtKind::Execute && pools.is_readonly(connection_id) {
        return Err(AppError::sql(
            "该连接为只读模式，已拦截 DML/DDL 语句（可在连接设置中关闭只读）",
        ));
    }
    Ok(())
}

fn normalize_max_rows(max_rows: Option<u64>) -> Option<u64> {
    match max_rows {
        None => Some(DEFAULT_MAX_ROWS),
        Some(0) => None, // explicit 0 = unlimited
        Some(n) => Some(n),
    }
}

/// Removes the registry entry when the query finishes (success or error).
struct CancellationGuard<'a> {
    registry: &'a QueryRegistry,
    execution_id: Option<String>,
    cancelled: Arc<AtomicBool>,
}

impl<'a> CancellationGuard<'a> {
    fn register(
        registry: &'a QueryRegistry,
        execution_id: Option<&str>,
        connection_id: &str,
        session_id: u64,
    ) -> Self {
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(id) = execution_id {
            registry.running.insert(
                id.to_string(),
                RunningQuery {
                    connection_id: connection_id.to_string(),
                    session_id,
                    cancelled: cancelled.clone(),
                },
            );
        }
        Self {
            registry,
            execution_id: execution_id.map(|s| s.to_string()),
            cancelled,
        }
    }
}

impl Drop for CancellationGuard<'_> {
    fn drop(&mut self) {
        if let Some(id) = &self.execution_id {
            self.registry.running.remove(id);
        }
    }
}

async fn mysql_session_id(conn: &mut sqlx::MySqlConnection) -> Result<u64, AppError> {
    sqlx::query_scalar("SELECT CONNECTION_ID()")
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| AppError::from_sqlx("获取会话 ID 失败", e))
}

async fn pg_session_id(conn: &mut sqlx::PgConnection) -> Result<u64, AppError> {
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| AppError::from_sqlx("获取会话 ID 失败", e))?;
    Ok(pid as u64)
}

/// (columns, rows, affected_rows, truncated)
type RawResult = (Vec<String>, Vec<Vec<serde_json::Value>>, u64, bool);

enum MySqlArgs {
    None,
    Some(sqlx::mysql::MySqlArguments),
}

enum PgArgs {
    None,
    Some(sqlx::postgres::PgArguments),
}

async fn run_mysql(
    conn: &mut sqlx::MySqlConnection,
    sql: &str,
    kind: StmtKind,
    max_rows: Option<u64>,
    args: MySqlArgs,
) -> Result<RawResult, AppError> {
    match kind {
        StmtKind::Rows => {
            let mut stream = match args {
                MySqlArgs::None => sqlx::Executor::fetch(&mut *conn, sql),
                MySqlArgs::Some(a) => sqlx::query_with(sql, a).fetch(&mut *conn),
            };
            let out = collect_rows(&mut stream, max_rows, mysql_value_to_json).await?;
            drop(stream);
            Ok(out)
        }
        StmtKind::Execute => {
            let res = match args {
                MySqlArgs::None => sqlx::Executor::execute(&mut *conn, sql).await,
                MySqlArgs::Some(a) => sqlx::query_with(sql, a).execute(&mut *conn).await,
            }
            .map_err(|e| AppError::from_sqlx("执行失败", e))?;
            Ok((vec![], vec![], res.rows_affected(), false))
        }
    }
}

async fn run_postgres(
    conn: &mut sqlx::PgConnection,
    sql: &str,
    kind: StmtKind,
    max_rows: Option<u64>,
    args: PgArgs,
) -> Result<RawResult, AppError> {
    match kind {
        StmtKind::Rows => {
            let mut stream = match args {
                PgArgs::None => sqlx::Executor::fetch(&mut *conn, sql),
                PgArgs::Some(a) => sqlx::query_with(sql, a).fetch(&mut *conn),
            };
            let out = collect_rows(&mut stream, max_rows, pg_value_to_json).await?;
            drop(stream);
            Ok(out)
        }
        StmtKind::Execute => {
            let res = match args {
                PgArgs::None => sqlx::Executor::execute(&mut *conn, sql).await,
                PgArgs::Some(a) => sqlx::query_with(sql, a).execute(&mut *conn).await,
            }
            .map_err(|e| AppError::from_sqlx("执行失败", e))?;
            Ok((vec![], vec![], res.rows_affected(), false))
        }
    }
}

/// Stream rows from `stream`, stopping after `max_rows` rows.
/// Returns (columns, rows, rows_returned, truncated).
async fn collect_rows<S, R, F>(
    stream: &mut S,
    max_rows: Option<u64>,
    to_json: F,
) -> Result<RawResult, AppError>
where
    S: futures::Stream<Item = Result<R, sqlx::Error>> + Unpin,
    R: Row,
    F: Fn(&R, usize) -> serde_json::Value,
{
    let mut columns: Vec<String> = vec![];
    let mut rows: Vec<Vec<serde_json::Value>> = vec![];
    let mut truncated = false;

    while let Some(item) = stream.next().await {
        let row = item.map_err(|e| AppError::from_sqlx("查询失败", e))?;
        if columns.is_empty() {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        if let Some(m) = max_rows {
            if rows.len() as u64 >= m {
                truncated = true;
                break;
            }
        }
        let n = row.columns().len();
        rows.push((0..n).map(|i| to_json(&row, i)).collect());
    }

    let affected = rows.len() as u64;
    Ok((columns, rows, affected, truncated))
}

/// Bind a JSON param for MySQL. Errors propagate so a bad param can't
/// silently shift the remaining bindings out of position.
fn bind_mysql_arg(
    args: &mut sqlx::mysql::MySqlArguments,
    v: &serde_json::Value,
) -> Result<(), AppError> {
    match v {
        serde_json::Value::Null => args
            .add(Option::<String>::None)
            .map_err(|e| AppError::sql(format!("参数绑定失败: {e}"))),
        serde_json::Value::Bool(b) => args
            .add(*b)
            .map_err(|e| AppError::sql(format!("参数绑定失败: {e}"))),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                args.add(i)
                    .map_err(|e| AppError::sql(format!("参数绑定失败: {e}")))
            } else if let Some(f) = n.as_f64() {
                args.add(f)
                    .map_err(|e| AppError::sql(format!("参数绑定失败: {e}")))
            } else {
                Err(AppError::sql(format!("不支持的参数类型: {n}")))
            }
        }
        serde_json::Value::String(s) => args
            .add(s.as_str())
            .map_err(|e| AppError::sql(format!("参数绑定失败: {e}"))),
        other => args
            .add(other.to_string())
            .map_err(|e| AppError::sql(format!("参数绑定失败: {e}"))),
    }
}

/// Bind a JSON param for PostgreSQL. Errors propagate, same rationale.
fn bind_pg_arg(
    args: &mut sqlx::postgres::PgArguments,
    v: &serde_json::Value,
) -> Result<(), AppError> {
    match v {
        serde_json::Value::Null => args
            .add(Option::<String>::None)
            .map_err(|e| AppError::sql(format!("参数绑定失败: {e}"))),
        serde_json::Value::Bool(b) => args
            .add(*b)
            .map_err(|e| AppError::sql(format!("参数绑定失败: {e}"))),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                args.add(i)
                    .map_err(|e| AppError::sql(format!("参数绑定失败: {e}")))
            } else if let Some(f) = n.as_f64() {
                args.add(f)
                    .map_err(|e| AppError::sql(format!("参数绑定失败: {e}")))
            } else {
                Err(AppError::sql(format!("不支持的参数类型: {n}")))
            }
        }
        serde_json::Value::String(s) => args
            .add(s.as_str())
            .map_err(|e| AppError::sql(format!("参数绑定失败: {e}"))),
        other => args
            .add(other.to_string())
            .map_err(|e| AppError::sql(format!("参数绑定失败: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_basic_statements() {
        assert_eq!(classify_statement("SELECT 1"), StmtKind::Rows);
        assert_eq!(classify_statement("select * from t"), StmtKind::Rows);
        assert_eq!(classify_statement("  SHOW TABLES"), StmtKind::Rows);
        assert_eq!(classify_statement("EXPLAIN SELECT 1"), StmtKind::Rows);
        assert_eq!(classify_statement("DESC t"), StmtKind::Rows);
        assert_eq!(classify_statement("VALUES (1), (2)"), StmtKind::Rows);
        assert_eq!(
            classify_statement("INSERT INTO t VALUES (1)"),
            StmtKind::Execute
        );
        assert_eq!(classify_statement("UPDATE t SET a=1"), StmtKind::Execute);
        assert_eq!(classify_statement("DELETE FROM t"), StmtKind::Execute);
        assert_eq!(
            classify_statement("CREATE TABLE t (a INT)"),
            StmtKind::Execute
        );
        assert_eq!(classify_statement("TRUNCATE t"), StmtKind::Execute);
    }

    #[test]
    fn skips_comments_before_keyword() {
        assert_eq!(classify_statement("-- comment\nSELECT 1"), StmtKind::Rows);
        assert_eq!(
            classify_statement("/* header */ DELETE FROM t"),
            StmtKind::Execute
        );
        assert_eq!(
            classify_statement("# hash comment\nSHOW STATUS"),
            StmtKind::Rows
        );
        assert_eq!(classify_statement("(SELECT 1)"), StmtKind::Execute); // parenthesized → not matched; safe default
    }

    #[test]
    fn classifies_with_cte() {
        assert_eq!(
            classify_statement("WITH x AS (SELECT 1) SELECT * FROM x"),
            StmtKind::Rows
        );
        assert_eq!(
            classify_statement("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"),
            StmtKind::Execute
        );
        assert_eq!(
            classify_statement("WITH a AS (SELECT 1), b AS (SELECT 2) UPDATE t SET c=1"),
            StmtKind::Execute
        );
        // Keywords inside the CTE body must not fool the scanner.
        assert_eq!(
            classify_statement("WITH x AS (SELECT 'INSERT' AS s, ')' AS p) SELECT * FROM x"),
            StmtKind::Rows
        );
        assert_eq!(
            classify_statement("with recursive c(n) as (select 1) select sum(n) from c"),
            StmtKind::Rows
        );
        assert_eq!(
            classify_statement("WITH x AS (SELECT 1) DELETE FROM t WHERE a IN (SELECT * FROM x)"),
            StmtKind::Execute
        );
        // CTE column list: its `)` must not be mistaken for the CTE body's.
        assert_eq!(
            classify_statement("WITH t (a, b) AS (SELECT 1, 2) SELECT * FROM t"),
            StmtKind::Rows
        );
        assert_eq!(
            classify_statement("WITH t (a, b) AS (VALUES (1, 2)) INSERT INTO u SELECT * FROM t"),
            StmtKind::Execute
        );
        assert_eq!(
            classify_statement("WITH x AS NOT MATERIALIZED (SELECT 1) SELECT * FROM x"),
            StmtKind::Rows
        );
    }

    #[test]
    fn max_rows_normalization() {
        assert_eq!(normalize_max_rows(None), Some(DEFAULT_MAX_ROWS));
        assert_eq!(normalize_max_rows(Some(0)), None);
        assert_eq!(normalize_max_rows(Some(5000)), Some(5000));
    }
}

use crate::db::dialect::Dialect;
use crate::db::pool::{DbPool, PoolManager};
use crate::error::{AppError, ResultExt};
use crate::utils::sql::{quote_ident_mysql, quote_ident_pg, string_literal};
use serde::{Deserialize, Serialize};
use tauri::State;

// ─── Create database ──────────────────────────────────────────────

#[tauri::command]
pub async fn create_database(
    pools: State<'_, PoolManager>,
    connection_id: String,
    db_name: String,
    charset: Option<String>,
    collation: Option<String>,
) -> Result<(), AppError> {
    pools.ensure_writable(&connection_id)?;
    if db_name.trim().is_empty() {
        return Err("数据库名称不能为空".into());
    }
    let pool = pools.pool(&connection_id)?;
    let mut sql = format!("CREATE DATABASE {}", pool.dialect().quote_ident(&db_name));
    if pool.dialect().is_mysql() {
        if let Some(cs) = charset.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(&format!(" CHARACTER SET {}", charset_name(cs)?));
        }
        if let Some(co) = collation.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(&format!(" COLLATE {}", charset_name(co)?));
        }
    }
    pool.execute(&sql).await.ctx("创建数据库失败")?;
    Ok(())
}

/// Charset and collation names are keywords-like identifiers, not quotable
/// in every position; accept only the characters real names use.
fn charset_name(name: &str) -> Result<&str, AppError> {
    if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        Ok(name)
    } else {
        Err(format!("无效的字符集或排序规则: {name}").into())
    }
}

/// `user`@`host` with both parts quoted; an empty host means any host.
fn mysql_account(username: &str, host: &str) -> String {
    let host = if host.is_empty() { "%" } else { host };
    format!(
        "{}@{}",
        quote_ident_mysql(username),
        quote_ident_mysql(host)
    )
}

/// A MySQL string literal for statements that only accept a plain literal
/// (`IDENTIFIED BY`). Whether a backslash escapes depends on the session's
/// NO_BACKSLASH_ESCAPES, so ask the very connection that will run it.
async fn mysql_plain_literal(
    conn: &mut sqlx::MySqlConnection,
    value: &str,
) -> Result<String, AppError> {
    let sql_mode: String = sqlx::query_scalar("SELECT CAST(@@SESSION.sql_mode AS CHAR)")
        .fetch_one(&mut *conn)
        .await
        .ctx("读取 sql_mode 失败")?;
    let mut escaped = value.replace('\'', "''");
    if !sql_mode
        .to_ascii_uppercase()
        .contains("NO_BACKSLASH_ESCAPES")
    {
        escaped = escaped.replace('\\', "\\\\");
    }
    Ok(format!("'{escaped}'"))
}

// ─── Drop database ────────────────────────────────────────────────

#[tauri::command]
pub async fn drop_database(
    pools: State<'_, PoolManager>,
    connection_id: String,
    db_name: String,
) -> Result<(), AppError> {
    drop_database_impl(&pools, connection_id, db_name).await
}

pub async fn drop_database_impl(
    pools: &PoolManager,
    connection_id: String,
    db_name: String,
) -> Result<(), AppError> {
    pools.ensure_writable(&connection_id)?;
    let pool = pools.pool(&connection_id)?;
    // Our own cached PG pool for that database would block the DROP.
    pools.close_database_pool(&connection_id, &db_name).await;
    pool.execute(&format!(
        "DROP DATABASE {}",
        pool.dialect().quote_ident(&db_name)
    ))
    .await
    .ctx("删除数据库失败")?;
    Ok(())
}

// ─── User / role types ────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub username: String,
    /// MySQL: the host field (e.g. "%" or "localhost"). Empty string for PG.
    pub host: String,
    pub is_super: bool,
    /// PG only: whether the role can login
    pub can_login: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbPrivilege {
    pub database: String,
    pub privileges: String,
}

// ─── List users ───────────────────────────────────────────────────

#[tauri::command]
pub async fn list_users(
    pools: State<'_, PoolManager>,
    connection_id: String,
) -> Result<Vec<UserInfo>, AppError> {
    match &pools.pool(&connection_id)? {
        DbPool::MySQL(pool) => {
            let rows: Vec<(String, String, String)> =
                sqlx::query_as("SELECT user, host, Super_priv FROM mysql.user ORDER BY user, host")
                    .fetch_all(pool)
                    .await
                    .ctx("查询用户列表失败")?;

            Ok(rows
                .into_iter()
                .map(|(username, host, super_priv)| UserInfo {
                    username,
                    host,
                    is_super: super_priv == "Y",
                    can_login: true,
                })
                .collect())
        }
        DbPool::Postgres(pool) => {
            let rows: Vec<(String, bool, bool)> = sqlx::query_as(
                "SELECT rolname, rolsuper, rolcanlogin \
                 FROM pg_roles \
                 WHERE rolname NOT LIKE 'pg_%' \
                 ORDER BY rolname",
            )
            .fetch_all(pool)
            .await
            .ctx("查询角色列表失败")?;

            Ok(rows
                .into_iter()
                .map(|(username, is_super, can_login)| UserInfo {
                    username,
                    host: String::new(),
                    is_super,
                    can_login,
                })
                .collect())
        }
    }
}

// ─── Get user grants ──────────────────────────────────────────────

#[tauri::command]
pub async fn get_user_grants(
    pools: State<'_, PoolManager>,
    connection_id: String,
    username: String,
    host: String,
) -> Result<Vec<DbPrivilege>, AppError> {
    match &pools.pool(&connection_id)? {
        DbPool::MySQL(pool) => {
            // SHOW GRANTS returns rows like:
            // GRANT SELECT, INSERT ON `mydb`.* TO `user`@`host`
            let sql = format!("SHOW GRANTS FOR {}", mysql_account(&username, &host));
            let rows: Vec<(String,)> = sqlx::query_as(&sql)
                .fetch_all(pool)
                .await
                .ctx("查询权限失败")?;

            // Parse each line: extract (database, privileges)
            let grants = rows
                .into_iter()
                .filter_map(|(line,)| parse_mysql_grant_line(&line))
                .collect();
            Ok(grants)
        }
        DbPool::Postgres(pool) => {
            // Check which non-template databases the role has CONNECT on
            let rows: Vec<(String, bool)> = sqlx::query_as(
                "SELECT datname, \
                 has_database_privilege($1, datname, 'CONNECT') AS has_connect \
                 FROM pg_database \
                 WHERE datistemplate = false \
                 ORDER BY datname",
            )
            .bind(&username)
            .fetch_all(pool)
            .await
            .ctx("查询权限失败")?;

            let grants = rows
                .into_iter()
                .filter(|(_, has)| *has)
                .map(|(db, _)| DbPrivilege {
                    database: db,
                    privileges: "CONNECT".to_string(),
                })
                .collect();
            Ok(grants)
        }
    }
}

/// Parse a MySQL SHOW GRANTS line into (database, privileges).
/// Handles: GRANT priv1, priv2 ON `db`.* TO ...
/// Skips global grants (ON *.*) and non-table grants.
fn parse_mysql_grant_line(line: &str) -> Option<DbPrivilege> {
    // Extract ON clause
    let upper = line.to_uppercase();
    let on_pos = upper.find(" ON ")?;
    let to_pos = upper.find(" TO ")?;

    let on_target = line[on_pos + 4..to_pos].trim();

    // Skip global grants
    if on_target.starts_with("*.*") || on_target == "*" {
        return None;
    }

    // Extract privileges part (between GRANT and ON)
    let priv_part = line["GRANT ".len()..on_pos].trim();

    // Extract database name (between backticks or raw)
    let db_name = if on_target.starts_with('`') {
        on_target.split_once('`')?.1.split('`').next()?.to_string()
    } else {
        on_target.split('.').next()?.to_string()
    };

    Some(DbPrivilege {
        database: db_name,
        privileges: priv_part.to_string(),
    })
}

// ─── Create user ──────────────────────────────────────────────────

#[tauri::command]
pub async fn create_user(
    pools: State<'_, PoolManager>,
    connection_id: String,
    username: String,
    host: String,
    password: String,
) -> Result<(), AppError> {
    create_user_impl(&pools, connection_id, username, host, password).await
}

pub async fn create_user_impl(
    pools: &PoolManager,
    connection_id: String,
    username: String,
    host: String,
    password: String,
) -> Result<(), AppError> {
    pools.ensure_writable(&connection_id)?;
    let pool = pools.pool(&connection_id)?;

    match &pool {
        DbPool::MySQL(pool) => {
            let mut conn = pool.acquire().await.ctx("获取连接失败")?;
            let literal = mysql_plain_literal(&mut conn, &password).await?;
            let sql = format!(
                "CREATE USER {} IDENTIFIED BY {literal}",
                mysql_account(&username, &host)
            );
            sqlx::Executor::execute(&mut *conn, sql.as_str())
                .await
                .ctx("创建用户失败")?;
        }
        DbPool::Postgres(pool) => {
            // PG: CREATE ROLE with LOGIN and PASSWORD
            let role = quote_ident_pg(&username);
            let sql = if password.is_empty() {
                format!("CREATE ROLE {role} WITH LOGIN")
            } else {
                format!(
                    "CREATE ROLE {role} WITH LOGIN PASSWORD {}",
                    string_literal(&password, false)
                )
            };
            sqlx::Executor::execute(pool, sql.as_str())
                .await
                .ctx("创建角色失败")?;
        }
    }

    Ok(())
}

// ─── Drop user ────────────────────────────────────────────────────

#[tauri::command]
pub async fn drop_user(
    pools: State<'_, PoolManager>,
    connection_id: String,
    username: String,
    host: String,
) -> Result<(), AppError> {
    pools.ensure_writable(&connection_id)?;
    let sql = match pools.dialect(&connection_id)? {
        Dialect::MySQL => format!("DROP USER {}", mysql_account(&username, &host)),
        Dialect::Postgres => format!("DROP ROLE {}", quote_ident_pg(&username)),
    };
    pools
        .pool(&connection_id)?
        .execute(&sql)
        .await
        .ctx("删除用户失败")?;
    Ok(())
}

// ─── Grant / Revoke database privilege ───────────────────────────

#[tauri::command]
pub async fn grant_privilege(
    pools: State<'_, PoolManager>,
    connection_id: String,
    username: String,
    host: String,
    database: String,
) -> Result<(), AppError> {
    pools.ensure_writable(&connection_id)?;
    let pool = pools.pool(&connection_id)?;
    let sql = match pool.dialect() {
        Dialect::MySQL => format!(
            "GRANT ALL PRIVILEGES ON {}.* TO {}",
            quote_ident_mysql(&database),
            mysql_account(&username, &host)
        ),
        Dialect::Postgres => format!(
            "GRANT CONNECT ON DATABASE {} TO {}",
            quote_ident_pg(&database),
            quote_ident_pg(&username)
        ),
    };
    pool.execute(&sql).await.ctx("授权失败")?;
    if pool.dialect().is_mysql() {
        pool.execute("FLUSH PRIVILEGES").await.ctx("刷新权限失败")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn revoke_privilege(
    pools: State<'_, PoolManager>,
    connection_id: String,
    username: String,
    host: String,
    database: String,
) -> Result<(), AppError> {
    pools.ensure_writable(&connection_id)?;
    let pool = pools.pool(&connection_id)?;
    let sql = match pool.dialect() {
        Dialect::MySQL => format!(
            "REVOKE ALL PRIVILEGES ON {}.* FROM {}",
            quote_ident_mysql(&database),
            mysql_account(&username, &host)
        ),
        Dialect::Postgres => format!(
            "REVOKE CONNECT ON DATABASE {} FROM {}",
            quote_ident_pg(&database),
            quote_ident_pg(&username)
        ),
    };
    pool.execute(&sql).await.ctx("撤销权限失败")?;
    if pool.dialect().is_mysql() {
        pool.execute("FLUSH PRIVILEGES").await.ctx("刷新权限失败")?;
    }
    Ok(())
}

// ─── Process list ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub id: i64,
    pub user: String,
    /// MySQL: "host:port"; PG: client_addr (may be empty for local)
    pub host: String,
    pub database: Option<String>,
    /// MySQL: Command (Query/Sleep/…); PG: state (active/idle/…)
    pub command: String,
    /// Duration in seconds
    pub time_sec: i64,
    pub state: String,
    pub info: Option<String>,
}

/// (id, user, host, db, command, time, state, info)
type MysqlProcessRow = (
    i64,
    String,
    String,
    Option<String>,
    String,
    i64,
    Option<String>,
    Option<String>,
);
/// (pid, user, client, db, state, duration, query)
type PgProcessRow = (
    i32,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<f64>,
    Option<String>,
);

#[tauri::command]
pub async fn list_processes(
    pools: State<'_, PoolManager>,
    connection_id: String,
) -> Result<Vec<ProcessInfo>, AppError> {
    list_processes_impl(&pools, connection_id).await
}

pub async fn list_processes_impl(
    pools: &PoolManager,
    connection_id: String,
) -> Result<Vec<ProcessInfo>, AppError> {
    match &pools.pool(&connection_id)? {
        DbPool::MySQL(pool) => {
            // id, user, host, db, command, time, state, info
            let rows: Vec<MysqlProcessRow> = sqlx::query_as(
                // ID is BIGINT UNSIGNED and TIME is INT; cast so both decode as i64.
                "SELECT CAST(id AS SIGNED), user, host, db, command, CAST(time AS SIGNED), state, info \
                     FROM information_schema.PROCESSLIST \
                     ORDER BY time DESC",
            )
            .fetch_all(pool)
            .await
            .ctx("查询进程列表失败")?;

            Ok(rows
                .into_iter()
                .map(
                    |(id, user, host, db, command, time, state, info)| ProcessInfo {
                        id,
                        user,
                        host,
                        database: db,
                        command,
                        time_sec: time,
                        state: state.unwrap_or_default(),
                        info,
                    },
                )
                .collect())
        }
        DbPool::Postgres(pool) => {
            let rows: Vec<PgProcessRow> = sqlx::query_as(
                "SELECT pid, \
                            usename, \
                            COALESCE(client_addr::text, ''), \
                            datname, \
                            COALESCE(state, ''), \
                            EXTRACT(EPOCH FROM (now() - query_start))::float8, \
                            query \
                     FROM pg_stat_activity \
                     WHERE pid <> pg_backend_pid() \
                     ORDER BY query_start DESC NULLS LAST",
            )
            .fetch_all(pool)
            .await
            .ctx("查询进程列表失败")?;

            Ok(rows
                .into_iter()
                .map(|(pid, user, client, db, state, dur, query)| ProcessInfo {
                    id: pid as i64,
                    user: user.unwrap_or_default(),
                    host: client.unwrap_or_default(),
                    database: db,
                    command: state.clone().unwrap_or_default(),
                    time_sec: dur.unwrap_or(0.0) as i64,
                    state: state.unwrap_or_default(),
                    info: query,
                })
                .collect())
        }
    }
}

// ─── Kill process / query ─────────────────────────────────────────

/// kill_type: "connection" | "query"
#[tauri::command]
pub async fn kill_process(
    pools: State<'_, PoolManager>,
    connection_id: String,
    process_id: i64,
    kill_type: String,
) -> Result<(), AppError> {
    pools.ensure_writable(&connection_id)?;
    let query_only = kill_type == "query";
    let sql = match (pools.dialect(&connection_id)?, query_only) {
        (Dialect::MySQL, true) => format!("KILL QUERY {process_id}"),
        (Dialect::MySQL, false) => format!("KILL CONNECTION {process_id}"),
        (Dialect::Postgres, true) => format!("SELECT pg_cancel_backend({process_id})"),
        (Dialect::Postgres, false) => format!("SELECT pg_terminate_backend({process_id})"),
    };
    pools
        .pool(&connection_id)?
        .execute(&sql)
        .await
        .ctx("终止进程失败")?;
    Ok(())
}

// ─── Disk usage ───────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSizeInfo {
    pub database: String,
    pub size_bytes: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSizeInfo {
    pub table_name: String,
    pub data_bytes: i64,
    pub index_bytes: i64,
    pub total_bytes: i64,
    /// Estimated row count; may be None for views/foreign tables
    pub row_count: Option<i64>,
}

/// Return size of every visible database.
#[tauri::command]
pub async fn get_disk_usage(
    pools: State<'_, PoolManager>,
    connection_id: String,
) -> Result<Vec<DbSizeInfo>, AppError> {
    match &pools.pool(&connection_id)? {
        DbPool::MySQL(pool) => {
            let rows: Vec<(String, i64)> = sqlx::query_as(
                "SELECT table_schema, \
                        CAST(COALESCE(SUM(data_length + index_length), 0) AS SIGNED) \
                 FROM information_schema.tables \
                 GROUP BY table_schema \
                 ORDER BY 2 DESC",
            )
            .fetch_all(pool)
            .await
            .ctx("查询数据库大小失败")?;

            Ok(rows
                .into_iter()
                .map(|(database, size_bytes)| DbSizeInfo {
                    database,
                    size_bytes,
                })
                .collect())
        }
        DbPool::Postgres(pool) => {
            let rows: Vec<(String, i64)> = sqlx::query_as(
                "SELECT datname, pg_database_size(datname)::bigint \
                 FROM pg_database \
                 WHERE datistemplate = false \
                 ORDER BY 2 DESC",
            )
            .fetch_all(pool)
            .await
            .ctx("查询数据库大小失败")?;

            Ok(rows
                .into_iter()
                .map(|(database, size_bytes)| DbSizeInfo {
                    database,
                    size_bytes,
                })
                .collect())
        }
    }
}

/// Return per-table sizes for a given database / schema.
#[tauri::command]
pub async fn get_table_sizes(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
) -> Result<Vec<TableSizeInfo>, AppError> {
    get_table_sizes_impl(&pools, connection_id, database, schema).await
}

pub async fn get_table_sizes_impl(
    pools: &PoolManager,
    connection_id: String,
    database: String,
    schema: Option<String>,
) -> Result<Vec<TableSizeInfo>, AppError> {
    match &pools.pool(&connection_id)? {
        DbPool::MySQL(pool) => {
            let rows: Vec<(String, i64, i64, Option<i64>)> = sqlx::query_as(
                "SELECT table_name, \
                        CAST(COALESCE(data_length, 0) AS SIGNED), \
                        CAST(COALESCE(index_length, 0) AS SIGNED), \
                        CAST(table_rows AS SIGNED) \
                 FROM information_schema.tables \
                 WHERE table_schema = ? \
                 ORDER BY (data_length + index_length) DESC",
            )
            .bind(&database)
            .fetch_all(pool)
            .await
            .ctx("查询表大小失败")?;

            Ok(rows
                .into_iter()
                .map(
                    |(table_name, data_bytes, index_bytes, row_count)| TableSizeInfo {
                        total_bytes: data_bytes + index_bytes,
                        table_name,
                        data_bytes,
                        index_bytes,
                        row_count,
                    },
                )
                .collect())
        }
        DbPool::Postgres(_) => {
            // Sizes are per database: query the one the user selected.
            let pool = pools
                .pg_pool_for_database(&connection_id, &database)
                .await?;
            let schema_filter = schema.as_deref().unwrap_or("public");
            // By OID, so mixed-case or quoted table names need no quoting.
            let rows: Vec<(String, i64, i64, i64, i64)> = sqlx::query_as(
                "SELECT c.relname::text, \
                        pg_relation_size(c.oid)::bigint, \
                        pg_indexes_size(c.oid)::bigint, \
                        pg_total_relation_size(c.oid)::bigint, \
                        c.reltuples::bigint \
                 FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') \
                 ORDER BY 4 DESC",
            )
            .bind(schema_filter)
            .fetch_all(&pool)
            .await
            .ctx("查询表大小失败")?;

            Ok(rows
                .into_iter()
                .map(
                    |(table_name, data_bytes, index_bytes, total_bytes, reltuples)| {
                        TableSizeInfo {
                            table_name,
                            data_bytes,
                            index_bytes,
                            total_bytes,
                            // -1 means never vacuumed/analyzed: unknown.
                            row_count: (reltuples >= 0).then_some(reltuples),
                        }
                    },
                )
                .collect())
        }
    }
}

// ─── EXPLAIN ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainResult {
    /// true = text/tree output (PG or MySQL ANALYZE); false = tabular (MySQL EXPLAIN)
    pub is_text: bool,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

#[tauri::command]
pub async fn explain_query(
    pools: State<'_, PoolManager>,
    registry: State<'_, crate::commands::query::QueryRegistry>,
    connection_id: String,
    sql: String,
    analyze: bool,
    session_id: Option<String>,
    execution_id: Option<String>,
) -> Result<ExplainResult, AppError> {
    let mysql = pools.dialect(&connection_id)?.is_mysql();
    let prefix = if !analyze {
        "EXPLAIN"
    } else if mysql {
        "EXPLAIN ANALYZE"
    } else {
        "EXPLAIN (ANALYZE, BUFFERS)"
    };
    let result = crate::commands::query::run_session_query(
        &pools,
        &registry,
        &connection_id,
        &format!("{prefix} {sql}"),
        &[],
        Some(0),
        execution_id.as_deref(),
        session_id.as_deref(),
    )
    .await?;
    Ok(ExplainResult {
        is_text: !mysql || analyze,
        columns: result.columns,
        rows: result
            .rows
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|v| match v {
                        serde_json::Value::Null => None,
                        serde_json::Value::String(s) => Some(s),
                        other => Some(other.to_string()),
                    })
                    .collect()
            })
            .collect(),
    })
}

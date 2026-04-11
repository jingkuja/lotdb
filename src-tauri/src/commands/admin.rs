use crate::db::pool::{DbPool, PoolManager};
use serde::{Deserialize, Serialize};
use sqlx::Column as _;
use tauri::State;

// ─── Create database ──────────────────────────────────────────────

#[tauri::command]
pub async fn create_database(
    pools: State<'_, PoolManager>,
    connection_id: String,
    db_name: String,
    charset: Option<String>,
    collation: Option<String>,
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    if !db_name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return Err("数据库名称只能包含字母、数字、下划线和连字符".to_string());
    }

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let mut sql = format!("CREATE DATABASE `{db_name}`");
            if let Some(cs) = &charset {
                sql.push_str(&format!(" CHARACTER SET {cs}"));
            }
            if let Some(co) = &collation {
                sql.push_str(&format!(" COLLATE {co}"));
            }
            sqlx::query(&sql)
                .execute(pool)
                .await
                .map_err(|e| format!("创建数据库失败: {e}"))?;
        }
        DbPool::Postgres(pool) => {
            sqlx::query(&format!("CREATE DATABASE \"{db_name}\""))
                .execute(pool)
                .await
                .map_err(|e| format!("创建数据库失败: {e}"))?;
        }
    }

    Ok(())
}

// ─── Drop database ────────────────────────────────────────────────

#[tauri::command]
pub async fn drop_database(
    pools: State<'_, PoolManager>,
    connection_id: String,
    db_name: String,
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    if !db_name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return Err("数据库名称包含非法字符".to_string());
    }

    match &entry.pool {
        DbPool::MySQL(pool) => {
            sqlx::query(&format!("DROP DATABASE `{db_name}`"))
                .execute(pool)
                .await
                .map_err(|e| format!("删除数据库失败: {e}"))?;
        }
        DbPool::Postgres(pool) => {
            sqlx::query(&format!("DROP DATABASE \"{db_name}\""))
                .execute(pool)
                .await
                .map_err(|e| format!("删除数据库失败: {e}"))?;
        }
    }

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
) -> Result<Vec<UserInfo>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let rows: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT user, host, Super_priv FROM mysql.user ORDER BY user, host",
            )
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询用户列表失败: {e}"))?;

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
            .map_err(|e| format!("查询角色列表失败: {e}"))?;

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
) -> Result<Vec<DbPrivilege>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            // SHOW GRANTS returns rows like:
            // GRANT SELECT, INSERT ON `mydb`.* TO `user`@`host`
            let sql = format!("SHOW GRANTS FOR `{username}`@`{host}`");
            let rows: Vec<(String,)> = sqlx::query_as(&sql)
                .fetch_all(pool)
                .await
                .map_err(|e| format!("查询权限失败: {e}"))?;

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
            .map_err(|e| format!("查询权限失败: {e}"))?;

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
        on_target
            .splitn(2, '`')
            .nth(1)?
            .splitn(2, '`')
            .next()?
            .to_string()
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
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let h = if host.is_empty() { "%" } else { &host };
            let sql =
                format!("CREATE USER `{username}`@`{h}` IDENTIFIED BY '{password}'");
            sqlx::query(&sql)
                .execute(pool)
                .await
                .map_err(|e| format!("创建用户失败: {e}"))?;
        }
        DbPool::Postgres(pool) => {
            // PG: CREATE ROLE with LOGIN and PASSWORD
            let sql = if password.is_empty() {
                format!("CREATE ROLE \"{username}\" WITH LOGIN")
            } else {
                format!("CREATE ROLE \"{username}\" WITH LOGIN PASSWORD '{password}'")
            };
            sqlx::query(&sql)
                .execute(pool)
                .await
                .map_err(|e| format!("创建角色失败: {e}"))?;
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
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let h = if host.is_empty() { "%" } else { &host };
            sqlx::query(&format!("DROP USER `{username}`@`{h}`"))
                .execute(pool)
                .await
                .map_err(|e| format!("删除用户失败: {e}"))?;
        }
        DbPool::Postgres(pool) => {
            sqlx::query(&format!("DROP ROLE \"{username}\""))
                .execute(pool)
                .await
                .map_err(|e| format!("删除角色失败: {e}"))?;
        }
    }

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
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let h = if host.is_empty() { "%" } else { &host };
            sqlx::query(&format!(
                "GRANT ALL PRIVILEGES ON `{database}`.* TO `{username}`@`{h}`"
            ))
            .execute(pool)
            .await
            .map_err(|e| format!("授权失败: {e}"))?;
            sqlx::query("FLUSH PRIVILEGES")
                .execute(pool)
                .await
                .map_err(|e| format!("刷新权限失败: {e}"))?;
        }
        DbPool::Postgres(pool) => {
            sqlx::query(&format!(
                "GRANT CONNECT ON DATABASE \"{database}\" TO \"{username}\""
            ))
            .execute(pool)
            .await
            .map_err(|e| format!("授权失败: {e}"))?;
        }
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
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let h = if host.is_empty() { "%" } else { &host };
            sqlx::query(&format!(
                "REVOKE ALL PRIVILEGES ON `{database}`.* FROM `{username}`@`{h}`"
            ))
            .execute(pool)
            .await
            .map_err(|e| format!("撤销权限失败: {e}"))?;
            sqlx::query("FLUSH PRIVILEGES")
                .execute(pool)
                .await
                .map_err(|e| format!("刷新权限失败: {e}"))?;
        }
        DbPool::Postgres(pool) => {
            sqlx::query(&format!(
                "REVOKE CONNECT ON DATABASE \"{database}\" FROM \"{username}\""
            ))
            .execute(pool)
            .await
            .map_err(|e| format!("撤销权限失败: {e}"))?;
        }
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

#[tauri::command]
pub async fn list_processes(
    pools: State<'_, PoolManager>,
    connection_id: String,
) -> Result<Vec<ProcessInfo>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            // id, user, host, db, command, time, state, info
            let rows: Vec<(i64, String, String, Option<String>, String, i64, Option<String>, Option<String>)> =
                sqlx::query_as(
                    "SELECT id, user, host, db, command, time, state, info \
                     FROM information_schema.PROCESSLIST \
                     ORDER BY time DESC",
                )
                .fetch_all(pool)
                .await
                .map_err(|e| format!("查询进程列表失败: {e}"))?;

            Ok(rows
                .into_iter()
                .map(|(id, user, host, db, command, time, state, info)| ProcessInfo {
                    id,
                    user,
                    host,
                    database: db,
                    command,
                    time_sec: time,
                    state: state.unwrap_or_default(),
                    info,
                })
                .collect())
        }
        DbPool::Postgres(pool) => {
            let rows: Vec<(i32, Option<String>, Option<String>, Option<String>, Option<String>, Option<f64>, Option<String>)> =
                sqlx::query_as(
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
                .map_err(|e| format!("查询进程列表失败: {e}"))?;

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
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let sql = if kill_type == "query" {
                format!("KILL QUERY {process_id}")
            } else {
                format!("KILL CONNECTION {process_id}")
            };
            sqlx::query(&sql)
                .execute(pool)
                .await
                .map_err(|e| format!("KILL 失败: {e}"))?;
        }
        DbPool::Postgres(pool) => {
            let sql = if kill_type == "query" {
                format!("SELECT pg_cancel_backend({process_id})")
            } else {
                format!("SELECT pg_terminate_backend({process_id})")
            };
            sqlx::query(&sql)
                .execute(pool)
                .await
                .map_err(|e| format!("终止进程失败: {e}"))?;
        }
    }

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
) -> Result<Vec<DbSizeInfo>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
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
            .map_err(|e| format!("查询数据库大小失败: {e}"))?;

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
            .map_err(|e| format!("查询数据库大小失败: {e}"))?;

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
) -> Result<Vec<TableSizeInfo>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
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
            .map_err(|e| format!("查询表大小失败: {e}"))?;

            Ok(rows
                .into_iter()
                .map(|(table_name, data_bytes, index_bytes, row_count)| TableSizeInfo {
                    total_bytes: data_bytes + index_bytes,
                    table_name,
                    data_bytes,
                    index_bytes,
                    row_count,
                })
                .collect())
        }
        DbPool::Postgres(pool) => {
            let schema_filter = schema.as_deref().unwrap_or("public");
            let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
                "SELECT tablename, \
                        pg_relation_size(schemaname||'.'||tablename)::bigint, \
                        pg_indexes_size(schemaname||'.'||tablename)::bigint, \
                        pg_total_relation_size(schemaname||'.'||tablename)::bigint \
                 FROM pg_tables \
                 WHERE schemaname = $1 \
                 ORDER BY 4 DESC",
            )
            .bind(schema_filter)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询表大小失败: {e}"))?;

            Ok(rows
                .into_iter()
                .map(|(table_name, data_bytes, index_bytes, total_bytes)| TableSizeInfo {
                    table_name,
                    data_bytes,
                    index_bytes,
                    total_bytes,
                    row_count: None,
                })
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
    connection_id: String,
    sql: String,
    analyze: bool,
) -> Result<ExplainResult, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            if analyze {
                // MySQL 8.0+ EXPLAIN ANALYZE returns a single text column
                let explain_sql = format!("EXPLAIN ANALYZE {sql}");
                let rows: Vec<(String,)> = sqlx::query_as(&explain_sql)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| format!("EXPLAIN ANALYZE 失败: {e}"))?;
                Ok(ExplainResult {
                    is_text: true,
                    columns: vec!["EXPLAIN".to_string()],
                    rows: rows
                        .into_iter()
                        .map(|(line,)| vec![Some(line)])
                        .collect(),
                })
            } else {
                // MySQL EXPLAIN returns tabular rows
                // Columns: id, select_type, table, partitions, type,
                //          possible_keys, key, key_len, ref, rows, filtered, Extra
                let explain_sql = format!("EXPLAIN {sql}");
                let rows = sqlx::query(&explain_sql)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| format!("EXPLAIN 失败: {e}"))?;

                if rows.is_empty() {
                    return Ok(ExplainResult {
                        is_text: false,
                        columns: vec![],
                        rows: vec![],
                    });
                }

                use sqlx::Row;
                let columns: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect();

                let data_rows = rows
                    .iter()
                    .map(|row| {
                        columns
                            .iter()
                            .enumerate()
                            .map(|(i, _)| {
                                row.try_get::<Option<String>, _>(i)
                                    .ok()
                                    .flatten()
                            })
                            .collect()
                    })
                    .collect();

                Ok(ExplainResult {
                    is_text: false,
                    columns,
                    rows: data_rows,
                })
            }
        }
        DbPool::Postgres(pool) => {
            let explain_sql = if analyze {
                format!("EXPLAIN (ANALYZE, BUFFERS) {sql}")
            } else {
                format!("EXPLAIN {sql}")
            };
            let rows: Vec<(String,)> = sqlx::query_as(&explain_sql)
                .fetch_all(pool)
                .await
                .map_err(|e| format!("EXPLAIN 失败: {e}"))?;
            Ok(ExplainResult {
                is_text: true,
                columns: vec!["QUERY PLAN".to_string()],
                rows: rows
                    .into_iter()
                    .map(|(line,)| vec![Some(line)])
                    .collect(),
            })
        }
    }
}

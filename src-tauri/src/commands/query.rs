use crate::db::pool::PoolManager;
use crate::models::connection::ConnectionConfig;
use crate::utils::keychain;
use serde::{Deserialize, Serialize};
use sqlx::{Arguments, Column, Row, TypeInfo, ValueRef};
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_ms: u128,
}

/// Open (or re-open) a connection pool for a saved connection config.
#[tauri::command]
pub async fn open_connection(
    pools: State<'_, PoolManager>,
    mut config: ConnectionConfig,
) -> Result<(), String> {
    // Load password from Keychain if not provided
    if config.password.is_empty() {
        config.password = keychain::load_password(&config.id).unwrap_or_default();
    }
    pools.open(&config).await
}

/// Close an active connection pool.
#[tauri::command]
pub async fn close_connection(pools: State<'_, PoolManager>, id: String) -> Result<(), String> {
    pools.close(&id).await;
    Ok(())
}

/// Return IDs of all currently open connection pools.
#[tauri::command]
pub fn get_active_connections(pools: State<'_, PoolManager>) -> Vec<String> {
    pools.active_ids()
}

/// Execute a SQL query and return results.
#[tauri::command]
pub async fn execute_query(
    pools: State<'_, PoolManager>,
    connection_id: String,
    sql: String,
) -> Result<QueryResult, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let start = std::time::Instant::now();

    match &entry.value().pool {
        crate::db::pool::DbPool::MySQL(pool) => execute_mysql(pool, &sql, start).await,
        crate::db::pool::DbPool::Postgres(pool) => execute_postgres(pool, &sql, start).await,
    }
}

/// Execute a parameterized SQL query with named/positional params.
#[tauri::command]
pub async fn execute_query_with_params(
    pools: State<'_, PoolManager>,
    connection_id: String,
    sql: String,
    params: Vec<serde_json::Value>,
) -> Result<QueryResult, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let start = std::time::Instant::now();

    match &entry.value().pool {
        crate::db::pool::DbPool::MySQL(pool) => {
            execute_mysql_with_params(pool, &sql, &params, start).await
        }
        crate::db::pool::DbPool::Postgres(pool) => {
            execute_postgres_with_params(pool, &sql, &params, start).await
        }
    }
}

async fn execute_mysql_with_params(
    pool: &sqlx::MySqlPool,
    sql: &str,
    params: &[serde_json::Value],
    start: std::time::Instant,
) -> Result<QueryResult, String> {
    let mut args = sqlx::mysql::MySqlArguments::default();
    for param in params {
        bind_mysql_arg(&mut args, param);
    }
    let rows = sqlx::query_with(sql, args)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询失败: {e}"))?;

    let columns = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect::<Vec<_>>())
        .unwrap_or_default();

    let result_rows = rows
        .iter()
        .map(|row| (0..row.columns().len()).map(|i| mysql_value_to_json(row, i)).collect::<Vec<_>>())
        .collect::<Vec<_>>();

    Ok(QueryResult {
        affected_rows: rows.len() as u64,
        columns,
        rows: result_rows,
        execution_ms: start.elapsed().as_millis(),
    })
}

fn bind_mysql_arg(args: &mut sqlx::mysql::MySqlArguments, v: &serde_json::Value) {
    match v {
        serde_json::Value::Null => args.add(None::<String>).unwrap_or(()),
        serde_json::Value::Bool(b) => args.add(*b).unwrap_or(()),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                args.add(i).unwrap_or(());
            } else if let Some(f) = n.as_f64() {
                args.add(f).unwrap_or(());
            }
        }
        serde_json::Value::String(s) => args.add(s.as_str()).unwrap_or(()),
        other => args.add(other.to_string().as_str()).unwrap_or(()),
    }
}

async fn execute_postgres_with_params(
    pool: &sqlx::PgPool,
    sql: &str,
    params: &[serde_json::Value],
    start: std::time::Instant,
) -> Result<QueryResult, String> {
    let mut args = sqlx::postgres::PgArguments::default();
    for param in params {
        bind_pg_arg(&mut args, param);
    }
    let rows = sqlx::query_with(sql, args)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询失败: {e}"))?;

    let columns = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect::<Vec<_>>())
        .unwrap_or_default();

    let result_rows = rows
        .iter()
        .map(|row| (0..row.columns().len()).map(|i| pg_value_to_json(row, i)).collect::<Vec<_>>())
        .collect::<Vec<_>>();

    Ok(QueryResult {
        affected_rows: rows.len() as u64,
        columns,
        rows: result_rows,
        execution_ms: start.elapsed().as_millis(),
    })
}

fn bind_pg_arg(args: &mut sqlx::postgres::PgArguments, v: &serde_json::Value) {
    match v {
        serde_json::Value::Null => args.add(None::<String>).unwrap_or(()),
        serde_json::Value::Bool(b) => args.add(*b).unwrap_or(()),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                args.add(i).unwrap_or(());
            } else if let Some(f) = n.as_f64() {
                args.add(f).unwrap_or(());
            }
        }
        serde_json::Value::String(s) => args.add(s.as_str()).unwrap_or(()),
        other => args.add(other.to_string().as_str()).unwrap_or(()),
    }
}

async fn execute_mysql(
    pool: &sqlx::MySqlPool,
    sql: &str,
    start: std::time::Instant,
) -> Result<QueryResult, String> {
    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询失败: {e}"))?;

    let columns = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| c.name().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let result_rows = rows
        .iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|i| mysql_value_to_json(row, i))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    Ok(QueryResult {
        affected_rows: rows.len() as u64,
        columns,
        rows: result_rows,
        execution_ms: start.elapsed().as_millis(),
    })
}

async fn execute_postgres(
    pool: &sqlx::PgPool,
    sql: &str,
    start: std::time::Instant,
) -> Result<QueryResult, String> {
    let rows = sqlx::query(sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询失败: {e}"))?;

    let columns = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| c.name().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let result_rows = rows
        .iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|i| pg_value_to_json(row, i))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    Ok(QueryResult {
        affected_rows: rows.len() as u64,
        columns,
        rows: result_rows,
        execution_ms: start.elapsed().as_millis(),
    })
}

fn mysql_value_to_json(row: &sqlx::mysql::MySqlRow, i: usize) -> serde_json::Value {
    let raw = row.try_get_raw(i).ok();
    raw.map(|v| {
        if v.is_null() {
            return serde_json::Value::Null;
        }
        let type_name = v.type_info().name().to_ascii_lowercase();
        if type_name.contains("int") {
            if let Ok(n) = row.try_get::<i64, _>(i) {
                return serde_json::json!(n);
            }
        }
        if type_name.contains("float")
            || type_name.contains("double")
            || type_name.contains("decimal")
        {
            if let Ok(n) = row.try_get::<f64, _>(i) {
                return serde_json::json!(n);
            }
        }
        if let Ok(s) = row.try_get::<String, _>(i) {
            serde_json::json!(s)
        } else {
            serde_json::Value::Null
        }
    })
    .unwrap_or(serde_json::Value::Null)
}

fn pg_value_to_json(row: &sqlx::postgres::PgRow, i: usize) -> serde_json::Value {
    let raw = row.try_get_raw(i).ok();
    raw.map(|v| {
        if v.is_null() {
            return serde_json::Value::Null;
        }
        let type_name = v.type_info().name().to_ascii_lowercase();
        if ["int2", "int4", "int8", "oid"]
            .iter()
            .any(|t| type_name.contains(t))
        {
            if let Ok(n) = row.try_get::<i64, _>(i) {
                return serde_json::json!(n);
            }
        }
        if ["float4", "float8", "numeric"]
            .iter()
            .any(|t| type_name.contains(t))
        {
            if let Ok(n) = row.try_get::<f64, _>(i) {
                return serde_json::json!(n);
            }
        }
        if type_name == "bool" {
            if let Ok(b) = row.try_get::<bool, _>(i) {
                return serde_json::json!(b);
            }
        }
        if let Ok(s) = row.try_get::<String, _>(i) {
            serde_json::json!(s)
        } else {
            serde_json::Value::Null
        }
    })
    .unwrap_or(serde_json::Value::Null)
}

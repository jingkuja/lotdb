use crate::db::pool::{DbPool, PoolManager};
use serde::{Deserialize, Serialize};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnFilter {
    pub column: String,
    /// "=" | "!=" | "LIKE" | "NOT LIKE" | ">" | "<" | ">=" | "<=" | "IS NULL" | "IS NOT NULL"
    pub op: String,
    pub value: String,
}

/// Build a WHERE clause from filters.
/// `quote_ident` wraps a column name in the DB-appropriate quoting.
fn build_where(filters: &[ColumnFilter], quote_ident: fn(&str) -> String) -> String {
    let conditions: Vec<String> = filters
        .iter()
        .filter_map(|f| {
            let col = quote_ident(&f.column);
            match f.op.as_str() {
                "IS NULL" => Some(format!("{col} IS NULL")),
                "IS NOT NULL" => Some(format!("{col} IS NOT NULL")),
                "LIKE" => {
                    if f.value.is_empty() {
                        return None;
                    }
                    let escaped = f.value.replace('\'', "''");
                    Some(format!("{col} LIKE '%{escaped}%'"))
                }
                "NOT LIKE" => {
                    if f.value.is_empty() {
                        return None;
                    }
                    let escaped = f.value.replace('\'', "''");
                    Some(format!("{col} NOT LIKE '%{escaped}%'"))
                }
                op @ ("=" | "!=" | ">" | "<" | ">=" | "<=") => {
                    if f.value.is_empty() {
                        return None;
                    }
                    let escaped = f.value.replace('\'', "''");
                    Some(format!("{col} {op} '{escaped}'"))
                }
                _ => None,
            }
        })
        .collect();

    if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    }
}

/// Fetch a page of rows from a table, with a total count, optional sort, and column filters.
#[tauri::command]
pub async fn get_table_data(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    limit: i64,
    offset: i64,
    order_by: Option<String>,
    order_dir: Option<String>, // "ASC" | "DESC"
    filters: Option<Vec<ColumnFilter>>,
) -> Result<TableDataResult, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let dir = match order_dir.as_deref() {
        Some("DESC") => "DESC",
        _ => "ASC",
    };
    let filters_ref = filters.as_deref().unwrap_or(&[]);

    match &entry.pool {
        DbPool::MySQL(pool) => {
            fetch_mysql(pool, &database, &table, limit, offset, order_by.as_deref(), dir, filters_ref).await
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = pools.pg_pool_for_database(&connection_id, &database).await?;
            let schema_ref = schema.as_deref().unwrap_or("public");
            fetch_postgres(&pool, &database, schema_ref, &table, limit, offset, order_by.as_deref(), dir, filters_ref).await
        }
    }
}

async fn fetch_mysql(
    pool: &sqlx::MySqlPool,
    database: &str,
    table: &str,
    limit: i64,
    offset: i64,
    order_by: Option<&str>,
    order_dir: &str,
    filters: &[ColumnFilter],
) -> Result<TableDataResult, String> {
    let q_table = format!("`{database}`.`{table}`");
    let where_clause = build_where(filters, |c| format!("`{c}`"));

    let count_sql = format!("SELECT COUNT(*) FROM {q_table}{where_clause}");
    let total_count: i64 = sqlx::query_scalar(&count_sql)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("计数失败: {e}"))?;

    let order_clause = order_by
        .map(|col| format!(" ORDER BY `{col}` {order_dir}"))
        .unwrap_or_default();
    let data_sql = format!("SELECT * FROM {q_table}{where_clause}{order_clause} LIMIT {limit} OFFSET {offset}");
    let rows = sqlx::query(&data_sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询失败: {e}"))?;

    let columns = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default();

    let result_rows = rows
        .iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|i| mysql_val(row, i))
                .collect()
        })
        .collect();

    Ok(TableDataResult { columns, rows: result_rows, total_count })
}

async fn fetch_postgres(
    pool: &sqlx::PgPool,
    _database: &str,
    schema: &str,
    table: &str,
    limit: i64,
    offset: i64,
    order_by: Option<&str>,
    order_dir: &str,
    filters: &[ColumnFilter],
) -> Result<TableDataResult, String> {
    let q_table = format!("\"{schema}\".\"{table}\"");
    let where_clause = build_where(filters, |c| format!("\"{c}\""));

    let count_sql = format!("SELECT COUNT(*) FROM {q_table}{where_clause}");
    let total_count: i64 = sqlx::query_scalar(&count_sql)
        .fetch_one(pool)
        .await
        .map_err(|e| format!("计数失败: {e}"))?;

    let order_clause = order_by
        .map(|col| format!(" ORDER BY \"{col}\" {order_dir}"))
        .unwrap_or_default();
    let data_sql = format!("SELECT * FROM {q_table}{where_clause}{order_clause} LIMIT {limit} OFFSET {offset}");
    let rows = sqlx::query(&data_sql)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("查询失败: {e}"))?;

    let columns = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default();

    let result_rows = rows
        .iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|i| pg_val(row, i))
                .collect()
        })
        .collect();

    Ok(TableDataResult { columns, rows: result_rows, total_count })
}

/// Execute multiple SQL statements inside a single transaction.
/// Returns the total number of rows affected.
#[tauri::command]
pub async fn execute_statements(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: Option<String>,
    sqls: Vec<String>,
) -> Result<u64, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let mut tx = pool.begin().await.map_err(|e| format!("开启事务失败: {e}"))?;
            let mut total: u64 = 0;
            for sql in &sqls {
                let res = sqlx::query(sql)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("执行失败: {e}\nSQL: {sql}"))?;
                total += res.rows_affected();
            }
            tx.commit().await.map_err(|e| format!("提交事务失败: {e}"))?;
            Ok(total)
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = if let Some(db) = &database {
                pools.pg_pool_for_database(&connection_id, db).await?
            } else {
                let e = pools.pools.get(&connection_id)
                    .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;
                match &e.pool {
                    DbPool::Postgres(p) => p.clone(),
                    _ => unreachable!(),
                }
            };
            let mut tx = pool.begin().await.map_err(|e| format!("开启事务失败: {e}"))?;
            let mut total: u64 = 0;
            for sql in &sqls {
                let res = sqlx::query(sql)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| format!("执行失败: {e}\nSQL: {sql}"))?;
                total += res.rows_affected();
            }
            tx.commit().await.map_err(|e| format!("提交事务失败: {e}"))?;
            Ok(total)
        }
    }
}

fn mysql_val(row: &sqlx::mysql::MySqlRow, i: usize) -> serde_json::Value {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

    let raw = match row.try_get_raw(i) {
        Ok(v) => v,
        Err(_) => return serde_json::Value::Null,
    };
    if raw.is_null() {
        return serde_json::Value::Null;
    }
    let type_name = raw.type_info().name().to_ascii_lowercase();

    if type_name.contains("int") {
        if let Ok(n) = row.try_get::<i64, _>(i) {
            return serde_json::json!(n);
        }
    }
    if type_name.contains("float") || type_name.contains("double") || type_name.contains("decimal") {
        if let Ok(n) = row.try_get::<f64, _>(i) {
            return serde_json::json!(n);
        }
    }
    if type_name == "bit" {
        if let Ok(b) = row.try_get::<bool, _>(i) {
            return serde_json::json!(b);
        }
    }

    // DATETIME / TIMESTAMP → NaiveDateTime
    if type_name == "datetime" || type_name == "timestamp" {
        if let Ok(dt) = row.try_get::<NaiveDateTime, _>(i) {
            return serde_json::json!(dt.to_string());
        }
    }

    // DATE
    if type_name == "date" {
        if let Ok(d) = row.try_get::<NaiveDate, _>(i) {
            return serde_json::json!(d.to_string());
        }
    }

    // TIME
    if type_name == "time" {
        if let Ok(t) = row.try_get::<NaiveTime, _>(i) {
            return serde_json::json!(t.to_string());
        }
    }

    // JSON
    if type_name == "json" {
        if let Ok(v) = row.try_get::<serde_json::Value, _>(i) {
            return v;
        }
    }

    // Fallback: text / varchar / enum / set / blob …
    if let Ok(s) = row.try_get::<String, _>(i) {
        return serde_json::json!(s);
    }

    serde_json::Value::Null
}

fn pg_val(row: &sqlx::postgres::PgRow, i: usize) -> serde_json::Value {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};

    let raw = match row.try_get_raw(i) {
        Ok(v) => v,
        Err(_) => return serde_json::Value::Null,
    };
    if raw.is_null() {
        return serde_json::Value::Null;
    }
    let type_name = raw.type_info().name().to_ascii_lowercase();

    // Integer types
    if ["int2", "int4", "int8", "oid"].iter().any(|t| type_name.as_str() == *t) {
        if let Ok(n) = row.try_get::<i64, _>(i) {
            return serde_json::json!(n);
        }
    }

    // Float / numeric
    if ["float4", "float8"].iter().any(|t| type_name.as_str() == *t) {
        if let Ok(n) = row.try_get::<f64, _>(i) {
            return serde_json::json!(n);
        }
    }
    if type_name == "numeric" {
        // numeric may not fit f64 — return as string
        if let Ok(n) = row.try_get::<f64, _>(i) {
            return serde_json::json!(n);
        }
        if let Ok(s) = row.try_get::<String, _>(i) {
            return serde_json::json!(s);
        }
    }

    // Boolean
    if type_name == "bool" {
        if let Ok(b) = row.try_get::<bool, _>(i) {
            return serde_json::json!(b);
        }
    }

    // JSON / JSONB — return the value directly so the frontend gets a real object
    if type_name == "json" || type_name == "jsonb" {
        if let Ok(v) = row.try_get::<serde_json::Value, _>(i) {
            return v;
        }
    }

    // Timestamp with time zone
    if type_name == "timestamptz" {
        if let Ok(dt) = row.try_get::<DateTime<Utc>, _>(i) {
            return serde_json::json!(dt.to_rfc3339());
        }
    }

    // Timestamp without time zone
    if type_name == "timestamp" {
        if let Ok(dt) = row.try_get::<NaiveDateTime, _>(i) {
            return serde_json::json!(dt.to_string());
        }
    }

    // Date
    if type_name == "date" {
        if let Ok(d) = row.try_get::<NaiveDate, _>(i) {
            return serde_json::json!(d.to_string());
        }
    }

    // Time / timetz
    if type_name == "time" || type_name == "timetz" {
        if let Ok(t) = row.try_get::<NaiveTime, _>(i) {
            return serde_json::json!(t.to_string());
        }
    }

    // UUID
    if type_name == "uuid" {
        if let Ok(u) = row.try_get::<uuid::Uuid, _>(i) {
            return serde_json::json!(u.to_string());
        }
    }

    // Bytea — hex-encode
    if type_name == "bytea" {
        if let Ok(b) = row.try_get::<Vec<u8>, _>(i) {
            let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
            return serde_json::json!(format!("\\x{hex}"));
        }
    }

    // Fallback: anything that can be decoded as text
    if let Ok(s) = row.try_get::<String, _>(i) {
        return serde_json::json!(s);
    }

    serde_json::Value::Null
}

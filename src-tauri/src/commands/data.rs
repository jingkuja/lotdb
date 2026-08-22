use crate::db::pool::{DbPool, PoolManager};
use crate::db::value::{mysql_value_to_json, pg_value_to_json};
use crate::error::AppError;
use crate::utils::sql::{quote_ident_mysql, quote_ident_pg};
use serde::{Deserialize, Serialize};
use sqlx::{Arguments, Column, Row};
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

/// Escape LIKE wildcards in a filter value using `#` as the escape char
/// (portable across MySQL/PG, avoids the backslash dialect minefield).
fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '#' => out.push_str("##"),
            '%' => out.push_str("#%"),
            '_' => out.push_str("#_"),
            _ => out.push(c),
        }
    }
    out
}

#[derive(Debug, PartialEq, Eq)]
enum Dialect {
    MySQL,
    Postgres,
}

impl Dialect {
    /// `?` for MySQL, `$n` for PostgreSQL.
    fn placeholder(&self, n: usize) -> String {
        match self {
            Dialect::MySQL => "?".to_string(),
            Dialect::Postgres => format!("${n}"),
        }
    }

    fn quote_ident(&self, ident: &str) -> String {
        match self {
            Dialect::MySQL => quote_ident_mysql(ident),
            Dialect::Postgres => quote_ident_pg(ident),
        }
    }
}

/// WHERE clause with bind placeholders instead of inlined values.
/// Returns (clause-with-placeholder-SQL, bind values in order).
///
/// `pg_col_types` maps column name → pg_catalog udt_name. PG binds are typed
/// TEXT, so comparing e.g. an int column against a text param fails with
/// "operator does not exist"; casting the placeholder to the column's real
/// type (`$1::int4`) restores the old literal-coercion behavior (and works
/// for custom enum types too). MySQL needs no casts — it coerces strings.
fn build_where(
    filters: &[ColumnFilter],
    dialect: Dialect,
    pg_col_types: &std::collections::HashMap<String, String>,
) -> (String, Vec<String>) {
    let mut binds: Vec<String> = Vec::new();
    let mut conditions: Vec<String> = Vec::new();

    for f in filters {
        let col = dialect.quote_ident(&f.column);
        match f.op.as_str() {
            "IS NULL" => conditions.push(format!("{col} IS NULL")),
            "IS NOT NULL" => conditions.push(format!("{col} IS NOT NULL")),
            "LIKE" | "NOT LIKE" => {
                if f.value.is_empty() {
                    continue;
                }
                let ph = dialect.placeholder(binds.len() + 1);
                binds.push(format!("%{}%", escape_like(&f.value)));
                conditions.push(format!("{col} {} {ph} ESCAPE '#'", f.op));
            }
            op @ ("=" | "!=" | ">" | "<" | ">=" | "<=") => {
                if f.value.is_empty() {
                    continue;
                }
                let mut ph = dialect.placeholder(binds.len() + 1);
                if dialect == Dialect::Postgres {
                    let udt = pg_col_types
                        .get(&f.column)
                        .map(String::as_str)
                        .unwrap_or("text");
                    if is_safe_type_name(udt) {
                        ph.push_str(&format!("::{udt}"));
                    }
                }
                binds.push(f.value.clone());
                conditions.push(format!("{col} {op} {ph}"));
            }
            _ => {}
        }
    }

    if conditions.is_empty() {
        (String::new(), binds)
    } else {
        (format!(" WHERE {}", conditions.join(" AND ")), binds)
    }
}

/// Only inline udt names made of plain identifier characters.
fn is_safe_type_name(t: &str) -> bool {
    !t.is_empty()
        && t.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Fetch a page of rows from a table, with a total count, optional sort, and column filters.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
) -> Result<TableDataResult, AppError> {
    get_table_data_impl(
        &pools,
        &connection_id,
        &database,
        schema.as_deref(),
        &table,
        limit,
        offset,
        order_by.as_deref(),
        order_dir.as_deref(),
        filters.as_deref().unwrap_or(&[]),
    )
    .await
}

/// State-free table fetch — shared by the Tauri command and integration tests.
#[allow(clippy::too_many_arguments)]
pub async fn get_table_data_impl(
    pools: &PoolManager,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
    table: &str,
    limit: i64,
    offset: i64,
    order_by: Option<&str>,
    order_dir: Option<&str>,
    filters: &[ColumnFilter],
) -> Result<TableDataResult, AppError> {
    let entry = pools
        .pools
        .get(connection_id)
        .ok_or_else(|| AppError::connection(format!("连接 {connection_id} 未打开")))?;

    let dir = match order_dir {
        Some("DESC") => "DESC",
        _ => "ASC",
    };

    match &entry.pool {
        DbPool::MySQL(pool) => {
            fetch_mysql(pool, database, table, limit, offset, order_by, dir, filters).await
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = pools
                .pg_pool_for_database(connection_id, database)
                .await
                .map_err(AppError::connection)?;
            let schema_ref = schema.unwrap_or("public");
            fetch_postgres(
                &pool, database, schema_ref, table, limit, offset, order_by, dir, filters,
            )
            .await
        }
    }
}

fn build_mysql_args(binds: &[String]) -> Result<sqlx::mysql::MySqlArguments, AppError> {
    let mut args = sqlx::mysql::MySqlArguments::default();
    for b in binds {
        args.add(b.as_str())
            .map_err(|e| AppError::sql(format!("筛选参数绑定失败: {e}")))?;
    }
    Ok(args)
}

fn build_pg_args(binds: &[String]) -> Result<sqlx::postgres::PgArguments, AppError> {
    let mut args = sqlx::postgres::PgArguments::default();
    for b in binds {
        args.add(b.as_str())
            .map_err(|e| AppError::sql(format!("筛选参数绑定失败: {e}")))?;
    }
    Ok(args)
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
) -> Result<TableDataResult, AppError> {
    let q_table = format!(
        "{}.{}",
        quote_ident_mysql(database),
        quote_ident_mysql(table)
    );
    let (where_clause, binds) = build_where(filters, Dialect::MySQL, &Default::default());

    let count_sql = format!("SELECT COUNT(*) FROM {q_table}{where_clause}");
    let total_count: i64 = sqlx::query_scalar_with(&count_sql, build_mysql_args(&binds)?)
        .fetch_one(pool)
        .await
        .map_err(|e| AppError::from_sqlx("计数失败", e))?;

    let order_clause = order_by
        .map(|col| format!(" ORDER BY {} {order_dir}", quote_ident_mysql(col)))
        .unwrap_or_default();
    let (limit, offset) = sanitize_page(limit, offset);
    let data_sql = format!(
        "SELECT * FROM {q_table}{where_clause}{order_clause} LIMIT {limit} OFFSET {offset}"
    );
    let rows = sqlx::query_with(&data_sql, build_mysql_args(&binds)?)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::from_sqlx("查询失败", e))?;

    let columns = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default();

    let result_rows = rows
        .iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|i| mysql_value_to_json(row, i))
                .collect()
        })
        .collect();

    Ok(TableDataResult {
        columns,
        rows: result_rows,
        total_count,
    })
}

#[allow(clippy::too_many_arguments)]
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
) -> Result<TableDataResult, AppError> {
    let q_table = format!("{}.{}", quote_ident_pg(schema), quote_ident_pg(table));
    let col_types = pg_column_types(pool, schema, table).await?;
    let (where_clause, binds) = build_where(filters, Dialect::Postgres, &col_types);

    let count_sql = format!("SELECT COUNT(*) FROM {q_table}{where_clause}");
    let total_count: i64 = sqlx::query_scalar_with(&count_sql, build_pg_args(&binds)?)
        .fetch_one(pool)
        .await
        .map_err(|e| AppError::from_sqlx("计数失败", e))?;

    let order_clause = order_by
        .map(|col| format!(" ORDER BY {} {order_dir}", quote_ident_pg(col)))
        .unwrap_or_default();
    let (limit, offset) = sanitize_page(limit, offset);
    let data_sql = format!(
        "SELECT * FROM {q_table}{where_clause}{order_clause} LIMIT {limit} OFFSET {offset}"
    );
    let rows = sqlx::query_with(&data_sql, build_pg_args(&binds)?)
        .fetch_all(pool)
        .await
        .map_err(|e| AppError::from_sqlx("查询失败", e))?;

    let columns = rows
        .first()
        .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
        .unwrap_or_default();

    let result_rows = rows
        .iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|i| pg_value_to_json(row, i))
                .collect()
        })
        .collect();

    Ok(TableDataResult {
        columns,
        rows: result_rows,
        total_count,
    })
}

/// Clamp LIMIT/OFFSET to non-negative values before inlining into SQL.
fn sanitize_page(limit: i64, offset: i64) -> (i64, i64) {
    (limit.clamp(0, i64::MAX), offset.clamp(0, i64::MAX))
}

/// Column name → pg_catalog udt_name for a table (or view).
/// Used to cast filter placeholders to the column's real type.
async fn pg_column_types(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
) -> Result<std::collections::HashMap<String, String>, AppError> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT column_name, udt_name \
         FROM information_schema.columns \
         WHERE table_schema = $1 AND table_name = $2",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::from_sqlx("查询列类型失败", e))?;
    Ok(rows.into_iter().collect())
}

/// Execute multiple SQL statements inside a single transaction.
/// Returns the total number of rows affected.
#[tauri::command]
pub async fn execute_statements(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: Option<String>,
    sqls: Vec<String>,
) -> Result<u64, AppError> {
    execute_statements_impl(&pools, &connection_id, database.as_deref(), &sqls).await
}

/// State-free batch DML in one transaction — shared with integration tests.
/// Readonly connections are rejected outright (this path only writes).
pub async fn execute_statements_impl(
    pools: &PoolManager,
    connection_id: &str,
    database: Option<&str>,
    sqls: &[String],
) -> Result<u64, AppError> {
    if pools.is_readonly(connection_id) {
        return Err(AppError::sql(
            "该连接为只读模式，已拦截数据变更（可在连接设置中关闭只读）",
        ));
    }

    let entry = pools
        .pools
        .get(connection_id)
        .ok_or_else(|| AppError::connection(format!("连接 {connection_id} 未打开")))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let mut tx = pool
                .begin()
                .await
                .map_err(|e| AppError::from_sqlx("开启事务失败", e))?;
            let mut total: u64 = 0;
            for sql in sqls {
                let res = sqlx::query(sql)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| AppError::from_sqlx(&format!("执行失败\nSQL: {sql}"), e))?;
                total += res.rows_affected();
            }
            tx.commit()
                .await
                .map_err(|e| AppError::from_sqlx("提交事务失败", e))?;
            Ok(total)
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = if let Some(db) = database {
                pools
                    .pg_pool_for_database(connection_id, db)
                    .await
                    .map_err(AppError::connection)?
            } else {
                let e = pools
                    .pools
                    .get(connection_id)
                    .ok_or_else(|| AppError::connection(format!("连接 {connection_id} 未打开")))?;
                match &e.pool {
                    DbPool::Postgres(p) => p.clone(),
                    _ => unreachable!(),
                }
            };
            let mut tx = pool
                .begin()
                .await
                .map_err(|e| AppError::from_sqlx("开启事务失败", e))?;
            let mut total: u64 = 0;
            for sql in sqls {
                let res = sqlx::query(sql)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| AppError::from_sqlx(&format!("执行失败\nSQL: {sql}"), e))?;
                total += res.rows_affected();
            }
            tx.commit()
                .await
                .map_err(|e| AppError::from_sqlx("提交事务失败", e))?;
            Ok(total)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(col: &str, op: &str, value: &str) -> ColumnFilter {
        ColumnFilter {
            column: col.to_string(),
            op: op.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn where_binds_values_mysql() {
        let (sql, binds) = build_where(
            &[
                filter("name", "=", "it's a `test`"),
                filter("age", ">", "18"),
            ],
            Dialect::MySQL,
            &Default::default(),
        );
        assert_eq!(sql, " WHERE `name` = ? AND `age` > ?");
        assert_eq!(binds, vec!["it's a `test`", "18"]);
    }

    #[test]
    fn where_binds_values_pg_with_column_type_casts() {
        use std::collections::HashMap;
        let mut types = HashMap::new();
        types.insert("name".to_string(), "varchar".to_string());
        types.insert("age".to_string(), "int4".to_string());
        let (sql, binds) = build_where(
            &[filter("name", "=", "x"), filter("age", "<=", "20")],
            Dialect::Postgres,
            &types,
        );
        assert_eq!(sql, " WHERE \"name\" = $1::varchar AND \"age\" <= $2::int4");
        assert_eq!(binds, vec!["x", "20"]);
    }

    #[test]
    fn where_pg_unknown_column_falls_back_to_text() {
        let (sql, _) = build_where(
            &[filter("ghost", "=", "1")],
            Dialect::Postgres,
            &Default::default(),
        );
        assert_eq!(sql, " WHERE \"ghost\" = $1::text");
    }

    #[test]
    fn where_escapes_like_wildcards() {
        let (sql, binds) = build_where(
            &[filter("name", "LIKE", "a%b_c#d")],
            Dialect::MySQL,
            &Default::default(),
        );
        assert_eq!(sql, " WHERE `name` LIKE ? ESCAPE '#'");
        assert_eq!(binds, vec!["%a#%b#_c##d%"]);
    }

    #[test]
    fn where_handles_null_ops() {
        let (sql, binds) = build_where(
            &[filter("a", "IS NULL", ""), filter("b", "IS NOT NULL", "")],
            Dialect::Postgres,
            &Default::default(),
        );
        assert_eq!(sql, " WHERE \"a\" IS NULL AND \"b\" IS NOT NULL");
        assert!(binds.is_empty());
    }

    #[test]
    fn where_skips_empty_values() {
        let (sql, binds) =
            build_where(&[filter("a", "=", "")], Dialect::MySQL, &Default::default());
        assert_eq!(sql, "");
        assert!(binds.is_empty());
    }

    #[test]
    fn quotes_identifiers_with_inner_quotes() {
        assert_eq!(quote_ident_mysql("we`ird"), "`we``ird`");
        assert_eq!(quote_ident_mysql("norm"), "`norm`");
        assert_eq!(quote_ident_pg("q\"uote"), "\"q\"\"uote\"");
        assert_eq!(quote_ident_pg("norm"), "\"norm\"");
    }

    #[test]
    fn sanitizes_page_values() {
        assert_eq!(sanitize_page(10, 20), (10, 20));
        assert_eq!(sanitize_page(-5, -1), (0, 0));
    }
}

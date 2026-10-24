use crate::db::dialect::Dialect;
use crate::db::pool::{DbPool, PoolManager};
use crate::db::value::{mysql_value_to_json, pg_value_to_json};
use crate::error::{AppError, ResultExt};
#[cfg(test)]
use crate::utils::sql::{quote_ident_mysql, quote_ident_pg};
use serde::{Deserialize, Serialize};
use sqlx::{Arguments, Row};
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
    include_count: Option<bool>,
    stable_columns: Option<Vec<String>>,
) -> Result<TableDataResult, AppError> {
    get_table_page_impl(
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
        include_count.unwrap_or(false),
        stable_columns.as_deref().unwrap_or(&[]),
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
    get_table_page_impl(
        pools,
        connection_id,
        database,
        schema,
        table,
        limit,
        offset,
        order_by,
        order_dir,
        filters,
        true,
        &[],
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn get_table_page_impl(
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
    include_count: bool,
    stable_columns: &[String],
) -> Result<TableDataResult, AppError> {
    let pool = pools.pool_for(connection_id, database).await?;
    let dialect = pool.dialect();
    let schema = schema.unwrap_or("public");
    let col_types = match &pool {
        DbPool::Postgres(p) => pg_column_types(p, schema, table).await?,
        DbPool::MySQL(_) => Default::default(),
    };
    let q_table = dialect.table_ref(database, Some(schema), table);
    let (where_clause, binds) = build_where(filters, dialect, &col_types);

    let dir = match order_dir {
        Some("DESC") => "DESC",
        _ => "ASC",
    };
    let mut order_columns: Vec<&str> = order_by.into_iter().collect();
    for col in stable_columns {
        if !order_columns.contains(&col.as_str()) {
            order_columns.push(col);
        }
    }
    let order_clause = if order_columns.is_empty() {
        String::new()
    } else {
        format!(
            " ORDER BY {}",
            order_columns
                .iter()
                .map(|col| format!("{} {dir}", dialect.quote_ident(col)))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let (limit, offset) = sanitize_page(limit, offset);
    let count_sql = format!("SELECT COUNT(*) FROM {q_table}{where_clause}");
    let data_sql = format!(
        "SELECT * FROM {q_table}{where_clause}{order_clause} LIMIT {limit} OFFSET {offset}"
    );
    let count_sql = include_count.then_some(count_sql.as_str());

    let (total_count, rows) = match &pool {
        DbPool::MySQL(p) => {
            let total = match count_sql {
                Some(sql) => sqlx::query_scalar_with(sql, build_mysql_args(&binds)?)
                    .fetch_one(p)
                    .await
                    .ctx("计数失败")?,
                None => -1,
            };
            let rows = sqlx::query_with(&data_sql, build_mysql_args(&binds)?)
                .fetch_all(p)
                .await
                .ctx("查询失败")?;
            (
                total,
                rows.iter()
                    .map(|r| row_json(r, mysql_value_to_json))
                    .collect(),
            )
        }
        DbPool::Postgres(p) => {
            let total = match count_sql {
                Some(sql) => sqlx::query_scalar_with(sql, build_pg_args(&binds)?)
                    .fetch_one(p)
                    .await
                    .ctx("计数失败")?,
                None => -1,
            };
            let rows = sqlx::query_with(&data_sql, build_pg_args(&binds)?)
                .fetch_all(p)
                .await
                .ctx("查询失败")?;
            (
                total,
                rows.iter().map(|r| row_json(r, pg_value_to_json)).collect(),
            )
        }
    };
    let columns = pool
        .describe_columns(&data_sql)
        .await
        .ctx("获取结果列失败")?;

    Ok(TableDataResult {
        columns,
        rows,
        total_count,
    })
}

fn row_json<R: Row>(
    row: &R,
    to_json: fn(&R, usize) -> serde_json::Value,
) -> Vec<serde_json::Value> {
    (0..row.columns().len()).map(|i| to_json(row, i)).collect()
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

/// Clamp LIMIT/OFFSET to non-negative values before inlining into SQL.
fn sanitize_page(limit: i64, offset: i64) -> (i64, i64) {
    (limit.clamp(0, 1001), offset.clamp(0, i64::MAX))
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
    .ctx("查询列类型失败")?;
    Ok(rows.into_iter().collect())
}

#[derive(Debug, Deserialize)]
pub struct RowCheck {
    pub sql: String,
    pub original: Vec<serde_json::Value>,
}

/// Compare a freshly read row with the snapshot the grid sent back.
///
/// The snapshot made a round trip through JavaScript, where `10.0` becomes
/// `10`; serde_json treats those as different numbers, so numbers are compared
/// by value instead of by representation.
fn same_row(actual: &[serde_json::Value], original: &[serde_json::Value]) -> bool {
    actual.len() == original.len() && actual.iter().zip(original).all(|(a, b)| same_value(a, b))
}

fn same_value(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_i64(), y.as_i64()) {
            (Some(x), Some(y)) => x == y,
            _ => match (x.as_u64(), y.as_u64()) {
                (Some(x), Some(y)) => x == y,
                _ => x.as_f64() == y.as_f64(),
            },
        },
        (Value::Array(x), Value::Array(y)) => same_row(x, y),
        _ => a == b,
    }
}

/// Execute multiple SQL statements inside a single transaction.
/// Returns the total number of rows affected.
#[tauri::command]
pub async fn execute_statements(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: Option<String>,
    sqls: Vec<String>,
    checks: Option<Vec<RowCheck>>,
) -> Result<u64, AppError> {
    execute_checked_statements_impl(
        &pools,
        &connection_id,
        database.as_deref(),
        &sqls,
        checks.as_deref().unwrap_or(&[]),
    )
    .await
}

/// State-free batch DML in one transaction — shared with integration tests.
/// Readonly connections are rejected outright (this path only writes).
pub async fn execute_statements_impl(
    pools: &PoolManager,
    connection_id: &str,
    database: Option<&str>,
    sqls: &[String],
) -> Result<u64, AppError> {
    execute_checked_statements_impl(pools, connection_id, database, sqls, &[]).await
}

pub async fn execute_checked_statements_impl(
    pools: &PoolManager,
    connection_id: &str,
    database: Option<&str>,
    sqls: &[String],
    checks: &[RowCheck],
) -> Result<u64, AppError> {
    if pools.is_readonly(connection_id) {
        return Err(AppError::sql(
            "该连接为只读模式，已拦截数据变更（可在连接设置中关闭只读）",
        ));
    }
    let pool = match database {
        Some(db) => pools.pool_for(connection_id, db).await?,
        None => pools.pool(connection_id)?,
    };
    match &pool {
        DbPool::MySQL(p) => {
            let mut tx = p.begin().await.ctx("开启事务失败")?;
            for check in checks {
                let row = sqlx::query(&check.sql)
                    .fetch_optional(&mut *tx)
                    .await
                    .ctx("校验原始数据失败")?;
                ensure_unchanged(
                    row.as_ref().map(|r| row_json(r, mysql_value_to_json)),
                    check,
                )?;
            }
            let mut total: u64 = 0;
            for sql in sqls {
                let res = sqlx::query(sql)
                    .execute(&mut *tx)
                    .await
                    .ctx(&format!("执行失败\nSQL: {sql}"))?;
                total += res.rows_affected();
            }
            tx.commit().await.ctx("提交事务失败")?;
            Ok(total)
        }
        DbPool::Postgres(p) => {
            let mut tx = p.begin().await.ctx("开启事务失败")?;
            for check in checks {
                let row = sqlx::query(&check.sql)
                    .fetch_optional(&mut *tx)
                    .await
                    .ctx("校验原始数据失败")?;
                ensure_unchanged(row.as_ref().map(|r| row_json(r, pg_value_to_json)), check)?;
            }
            let mut total: u64 = 0;
            for sql in sqls {
                let res = sqlx::query(sql)
                    .execute(&mut *tx)
                    .await
                    .ctx(&format!("执行失败\nSQL: {sql}"))?;
                total += res.rows_affected();
            }
            tx.commit().await.ctx("提交事务失败")?;
            Ok(total)
        }
    }
}

/// The transaction is dropped (rolled back) when this fails.
fn ensure_unchanged(
    actual: Option<Vec<serde_json::Value>>,
    check: &RowCheck,
) -> Result<(), AppError> {
    if actual.is_some_and(|row| same_row(&row, &check.original)) {
        Ok(())
    } else {
        Err(AppError::sql(
            "数据已被其他操作修改或删除，本次提交已回滚。请先保存草稿，再刷新数据并重新编辑。",
        ))
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
    fn row_check_ignores_float_representation() {
        use serde_json::json;
        // Backend reads DOUBLE 10 as 10.0; JS sends it back as 10.
        assert!(same_row(
            &[json!(1), json!(10.0), json!("a")],
            &[json!(1), json!(10), json!("a")]
        ));
        assert!(same_row(&[json!(0.1)], &[json!(0.1)]));
        assert!(same_row(&[json!(u64::MAX)], &[json!(u64::MAX)]));
        assert!(!same_row(&[json!(10.5)], &[json!(10)]));
        assert!(!same_row(&[json!("10")], &[json!(10)]));
        assert!(!same_row(&[json!(null)], &[json!(0)]));
        assert!(!same_row(&[json!(1)], &[json!(1), json!(2)]));
    }

    #[test]
    fn sanitizes_page_values() {
        assert_eq!(sanitize_page(10, 20), (10, 20));
        assert_eq!(sanitize_page(-5, -1), (0, 0));
    }
}

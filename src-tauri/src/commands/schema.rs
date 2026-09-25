use crate::db::pool::{DbPool, PoolManager};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaObjects {
    pub tables: Vec<String>,
    pub views: Vec<String>,
    pub functions: Vec<String>,
}

/// List databases visible to the current connection.
/// MySQL: SHOW DATABASES; PostgreSQL: pg_database WHERE datistemplate=false.
#[tauri::command]
pub async fn list_databases(
    pools: State<'_, PoolManager>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let rows: Vec<(String,)> = sqlx::query_as("SHOW DATABASES")
                .fetch_all(pool)
                .await
                .map_err(|e| format!("查询数据库列表失败: {e}"))?;
            Ok(rows.into_iter().map(|(name,)| name).collect())
        }
        DbPool::Postgres(pool) => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
            )
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询数据库列表失败: {e}"))?;
            Ok(rows.into_iter().map(|(name,)| name).collect())
        }
    }
}

/// List schemas within a database.
/// MySQL: always returns empty (schemas == databases in MySQL).
/// PostgreSQL: lists non-system schemas in the target database.
#[tauri::command]
pub async fn list_schemas(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
) -> Result<Vec<String>, String> {
    let is_pg = {
        let entry = pools
            .pools
            .get(&connection_id)
            .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;
        matches!(entry.pool, DbPool::Postgres(_))
    };

    if !is_pg {
        return Ok(vec![]);
    }

    let pool = pools
        .pg_pool_for_database(&connection_id, &database)
        .await?;
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT nspname FROM pg_namespace \
         WHERE nspname NOT LIKE 'pg_%' AND nspname != 'information_schema' \
         ORDER BY nspname",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询 Schema 列表失败: {e}"))?;
    Ok(rows.into_iter().map(|(name,)| name).collect())
}

/// List tables, views, and functions in a database/schema.
/// MySQL: `database` is the schema name; `schema` param is ignored.
/// PostgreSQL: `schema` is the pg schema (defaults to "public").
#[tauri::command]
pub async fn list_objects(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
) -> Result<SchemaObjects, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let tables: Vec<(String,)> = sqlx::query_as(
                "SELECT TABLE_NAME FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
                 ORDER BY TABLE_NAME",
            )
            .bind(&database)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询表列表失败: {e}"))?;

            let views: Vec<(String,)> = sqlx::query_as(
                "SELECT TABLE_NAME FROM information_schema.VIEWS \
                 WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            )
            .bind(&database)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询视图列表失败: {e}"))?;

            let functions: Vec<(String,)> = sqlx::query_as(
                "SELECT ROUTINE_NAME FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME",
            )
            .bind(&database)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询函数列表失败: {e}"))?;

            Ok(SchemaObjects {
                tables: tables.into_iter().map(|(n,)| n).collect(),
                views: views.into_iter().map(|(n,)| n).collect(),
                functions: functions.into_iter().map(|(n,)| n).collect(),
            })
        }
        DbPool::Postgres(_) => {
            // Drop the entry lock before awaiting
            drop(entry);
            let pool = pools
                .pg_pool_for_database(&connection_id, &database)
                .await?;
            let schema_name = schema.as_deref().unwrap_or("public");

            let tables: Vec<(String,)> = sqlx::query_as(
                "SELECT table_name FROM information_schema.tables \
                 WHERE table_schema = $1 AND table_type = 'BASE TABLE' \
                 ORDER BY table_name",
            )
            .bind(schema_name)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("查询表列表失败: {e}"))?;

            let views: Vec<(String,)> = sqlx::query_as(
                "SELECT table_name FROM information_schema.views \
                 WHERE table_schema = $1 ORDER BY table_name",
            )
            .bind(schema_name)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("查询视图列表失败: {e}"))?;

            let functions: Vec<(String,)> = sqlx::query_as(
                "SELECT routine_name FROM information_schema.routines \
                 WHERE routine_schema = $1 AND routine_type = 'FUNCTION' \
                 ORDER BY routine_name",
            )
            .bind(schema_name)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("查询函数列表失败: {e}"))?;

            Ok(SchemaObjects {
                tables: tables.into_iter().map(|(n,)| n).collect(),
                views: views.into_iter().map(|(n,)| n).collect(),
                functions: functions.into_iter().map(|(n,)| n).collect(),
            })
        }
    }
}

// ─── Table structure ─────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub comment: Option<String>,
    pub extra: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDef {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub index_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDef {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

/// Get column definitions for a table.
#[tauri::command]
pub async fn get_table_columns(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<ColumnDef>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            // PRIMARY KEY info
            let pk_rows: Vec<(String,)> = sqlx::query_as(
                "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                 AND CONSTRAINT_NAME = 'PRIMARY'",
            )
            .bind(&database)
            .bind(&table)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询主键失败: {e}"))?;
            let pk_set: std::collections::HashSet<String> =
                pk_rows.into_iter().map(|(n,)| n).collect();

            #[derive(sqlx::FromRow)]
            struct MysqlCol {
                column_name: String,
                column_type: String,
                is_nullable: String,
                column_default: Option<String>,
                extra: String,
                column_comment: String,
            }

            let rows: Vec<MysqlCol> = sqlx::query_as(
                "SELECT COLUMN_NAME as column_name, CAST(COLUMN_TYPE AS CHAR) as column_type, \
                 IS_NULLABLE as is_nullable, CAST(COLUMN_DEFAULT AS CHAR) as column_default, \
                 EXTRA as extra, CAST(COLUMN_COMMENT AS CHAR) as column_comment \
                 FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                 ORDER BY ORDINAL_POSITION",
            )
            .bind(&database)
            .bind(&table)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询列失败: {e}"))?;

            Ok(rows
                .into_iter()
                .map(|r| ColumnDef {
                    is_primary_key: pk_set.contains(&r.column_name),
                    name: r.column_name,
                    data_type: r.column_type,
                    nullable: r.is_nullable == "YES",
                    default_value: r.column_default,
                    comment: if r.column_comment.is_empty() {
                        None
                    } else {
                        Some(r.column_comment)
                    },
                    extra: if r.extra.is_empty() {
                        None
                    } else {
                        Some(r.extra)
                    },
                })
                .collect())
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = pools
                .pg_pool_for_database(&connection_id, &database)
                .await?;
            let schema_name = schema.as_deref().unwrap_or("public");

            #[derive(sqlx::FromRow)]
            struct PgCol {
                name: String,
                data_type: String,
                nullable: bool,
                default_value: Option<String>,
                is_primary_key: bool,
                comment: Option<String>,
            }

            let rows: Vec<PgCol> = sqlx::query_as(
                "SELECT \
                   a.attname AS name, \
                   pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, \
                   NOT a.attnotnull AS nullable, \
                   pg_get_expr(d.adbin, d.adrelid) AS default_value, \
                   COALESCE(pk.is_pk, false) AS is_primary_key, \
                   col_description(a.attrelid, a.attnum) AS comment \
                 FROM pg_catalog.pg_attribute a \
                 JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_catalog.pg_attrdef d \
                   ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 LEFT JOIN ( \
                   SELECT a2.attnum, true AS is_pk \
                   FROM pg_index ix \
                   JOIN pg_attribute a2 ON a2.attrelid = ix.indrelid \
                     AND a2.attnum = ANY(ix.indkey) \
                   JOIN pg_class c2 ON c2.oid = ix.indrelid \
                   JOIN pg_namespace n2 ON n2.oid = c2.relnamespace \
                   WHERE ix.indisprimary AND n2.nspname = $1 AND c2.relname = $2 \
                 ) pk ON pk.attnum = a.attnum \
                 WHERE n.nspname = $1 AND c.relname = $2 \
                   AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
            )
            .bind(schema_name)
            .bind(&table)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("查询列失败: {e}"))?;

            Ok(rows
                .into_iter()
                .map(|r| ColumnDef {
                    name: r.name,
                    data_type: r.data_type,
                    nullable: r.nullable,
                    default_value: r.default_value,
                    is_primary_key: r.is_primary_key,
                    comment: r.comment,
                    extra: None,
                })
                .collect())
        }
    }
}

/// Get index definitions for a table.
#[tauri::command]
pub async fn get_table_indexes(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<IndexDef>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            #[derive(sqlx::FromRow)]
            struct MysqlIdx {
                index_name: String,
                column_name: String,
                non_unique: i64,
                index_type: String,
            }

            let rows: Vec<MysqlIdx> = sqlx::query_as(
                "SELECT INDEX_NAME as index_name, COLUMN_NAME as column_name, \
                 NON_UNIQUE as non_unique, CAST(INDEX_TYPE AS CHAR) AS index_type \
                 FROM information_schema.STATISTICS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
                 ORDER BY INDEX_NAME, SEQ_IN_INDEX",
            )
            .bind(&database)
            .bind(&table)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询索引失败: {e}"))?;

            // Group by index name
            let mut map: BTreeMap<String, IndexDef> = BTreeMap::new();
            for r in rows {
                let entry = map.entry(r.index_name.clone()).or_insert(IndexDef {
                    primary: r.index_name == "PRIMARY",
                    unique: r.non_unique == 0,
                    index_type: r.index_type.clone(),
                    name: r.index_name,
                    columns: vec![],
                });
                entry.columns.push(r.column_name);
            }
            Ok(map.into_values().collect())
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = pools
                .pg_pool_for_database(&connection_id, &database)
                .await?;
            let schema_name = schema.as_deref().unwrap_or("public");

            #[derive(sqlx::FromRow)]
            struct PgIdx {
                index_name: String,
                column_name: String,
                is_unique: bool,
                is_primary: bool,
                index_type: String,
                #[allow(dead_code)]
                position: i32,
            }

            let rows: Vec<PgIdx> = sqlx::query_as(
                "SELECT \
                   i.relname AS index_name, \
                   a.attname AS column_name, \
                   ix.indisunique AS is_unique, \
                   ix.indisprimary AS is_primary, \
                   am.amname AS index_type, \
                   array_position(ix.indkey::int[], a.attnum::int) AS position \
                 FROM pg_class t \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 JOIN pg_index ix ON t.oid = ix.indrelid \
                 JOIN pg_class i ON i.oid = ix.indexrelid \
                 JOIN pg_am am ON i.relam = am.oid \
                 JOIN pg_attribute a ON a.attrelid = t.oid \
                   AND a.attnum = ANY(ix.indkey) \
                 WHERE n.nspname = $1 AND t.relname = $2 \
                 ORDER BY i.relname, position",
            )
            .bind(schema_name)
            .bind(&table)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("查询索引失败: {e}"))?;

            let mut map: BTreeMap<String, IndexDef> = BTreeMap::new();
            for r in rows {
                let entry = map.entry(r.index_name.clone()).or_insert(IndexDef {
                    name: r.index_name,
                    unique: r.is_unique,
                    primary: r.is_primary,
                    index_type: r.index_type,
                    columns: vec![],
                });
                entry.columns.push(r.column_name);
            }
            Ok(map.into_values().collect())
        }
    }
}

fn pg_action_code(code: &str) -> &'static str {
    match code {
        "a" => "NO ACTION",
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
}

/// Get foreign key definitions for a table.
#[tauri::command]
pub async fn get_table_foreign_keys(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<ForeignKeyDef>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            #[derive(sqlx::FromRow)]
            struct MysqlFk {
                constraint_name: String,
                column_name: String,
                ref_table: String,
                ref_column: String,
                update_rule: String,
                delete_rule: String,
            }

            let rows: Vec<MysqlFk> = sqlx::query_as(
                "SELECT kcu.CONSTRAINT_NAME as constraint_name, \
                 kcu.COLUMN_NAME as column_name, \
                 kcu.REFERENCED_TABLE_NAME as ref_table, \
                 kcu.REFERENCED_COLUMN_NAME as ref_column, \
                 rc.UPDATE_RULE as update_rule, \
                 rc.DELETE_RULE as delete_rule \
                 FROM information_schema.KEY_COLUMN_USAGE kcu \
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS rc \
                   ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME \
                   AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA \
                 WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? \
                   AND kcu.REFERENCED_TABLE_NAME IS NOT NULL \
                 ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
            )
            .bind(&database)
            .bind(&table)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("查询外键失败: {e}"))?;

            let mut map: BTreeMap<String, ForeignKeyDef> = BTreeMap::new();
            for r in rows {
                let entry = map
                    .entry(r.constraint_name.clone())
                    .or_insert(ForeignKeyDef {
                        name: r.constraint_name,
                        columns: vec![],
                        ref_table: r.ref_table.clone(),
                        ref_columns: vec![],
                        on_update: r.update_rule,
                        on_delete: r.delete_rule,
                    });
                entry.columns.push(r.column_name);
                entry.ref_columns.push(r.ref_column);
            }
            Ok(map.into_values().collect())
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = pools
                .pg_pool_for_database(&connection_id, &database)
                .await?;
            let schema_name = schema.as_deref().unwrap_or("public");

            #[derive(sqlx::FromRow)]
            struct PgFk {
                constraint_name: String,
                column_name: String,
                ref_table: String,
                ref_column: String,
                on_update: String,
                on_delete: String,
            }

            let rows: Vec<PgFk> = sqlx::query_as(
                "SELECT \
                   c.conname AS constraint_name, \
                   a.attname AS column_name, \
                   tf.relname AS ref_table, \
                   af.attname AS ref_column, \
                   c.confupdtype::text AS on_update, \
                   c.confdeltype::text AS on_delete \
                 FROM pg_constraint c \
                 JOIN pg_class t ON t.oid = c.conrelid \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 JOIN pg_class tf ON tf.oid = c.confrelid \
                 JOIN pg_attribute a ON a.attrelid = c.conrelid \
                   AND a.attnum = ANY(c.conkey) \
                 JOIN pg_attribute af ON af.attrelid = c.confrelid \
                   AND af.attnum = ANY(c.confkey) \
                 WHERE c.contype = 'f' AND n.nspname = $1 AND t.relname = $2 \
                 ORDER BY c.conname, a.attnum",
            )
            .bind(schema_name)
            .bind(&table)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("查询外键失败: {e}"))?;

            let mut map: BTreeMap<String, ForeignKeyDef> = BTreeMap::new();
            for r in rows {
                let entry = map
                    .entry(r.constraint_name.clone())
                    .or_insert(ForeignKeyDef {
                        name: r.constraint_name,
                        columns: vec![],
                        ref_table: r.ref_table.clone(),
                        ref_columns: vec![],
                        on_update: pg_action_code(&r.on_update).to_string(),
                        on_delete: pg_action_code(&r.on_delete).to_string(),
                    });
                entry.columns.push(r.column_name);
                entry.ref_columns.push(r.ref_column);
            }
            Ok(map.into_values().collect())
        }
    }
}

// ─── Object search ────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    /// Database (MySQL) or connected database (PG).
    pub database: String,
    /// Schema name — Some for PG, None for MySQL.
    pub schema: Option<String>,
    /// Object name.
    pub name: String,
    /// "table" | "view" | "function"
    pub object_type: String,
}

/// Search for database objects whose name matches `query` (case-insensitive LIKE).
/// Returns up to `limit` results (default 100).
#[tauri::command]
pub async fn search_objects(
    pools: State<'_, PoolManager>,
    connection_id: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SearchResult>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let max = limit.unwrap_or(100) as i64;
    let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));

    match &entry.pool {
        DbPool::MySQL(pool) => {
            #[derive(sqlx::FromRow)]
            struct Row {
                database_name: String,
                name: String,
                object_type: String,
            }

            // Tables + views
            let mut results: Vec<Row> = sqlx::query_as(
                "SELECT TABLE_SCHEMA AS database_name, TABLE_NAME AS name, \
                 CASE TABLE_TYPE WHEN 'BASE TABLE' THEN 'table' ELSE 'view' END AS object_type \
                 FROM information_schema.TABLES \
                 WHERE TABLE_NAME LIKE ? ESCAPE '\\\\' \
                   AND TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
                 LIMIT ?",
            )
            .bind(&pattern)
            .bind(max)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("搜索失败: {e}"))?;

            // Functions + procedures
            let mut fns: Vec<Row> = sqlx::query_as(
                "SELECT ROUTINE_SCHEMA AS database_name, ROUTINE_NAME AS name, \
                 LOWER(ROUTINE_TYPE) AS object_type \
                 FROM information_schema.ROUTINES \
                 WHERE ROUTINE_NAME LIKE ? ESCAPE '\\\\' \
                   AND ROUTINE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') \
                 LIMIT ?",
            )
            .bind(&pattern)
            .bind(max)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("搜索函数失败: {e}"))?;

            results.append(&mut fns);
            results.sort_by(|a, b| a.name.cmp(&b.name));
            results.truncate(max as usize);

            Ok(results
                .into_iter()
                .map(|r| SearchResult {
                    database: r.database_name,
                    schema: None,
                    name: r.name,
                    object_type: r.object_type,
                })
                .collect())
        }
        DbPool::Postgres(pool) => {
            #[derive(sqlx::FromRow)]
            struct Row {
                schema_name: String,
                name: String,
                object_type: String,
            }

            // Tables + views
            let mut results: Vec<Row> = sqlx::query_as(
                "SELECT table_schema AS schema_name, table_name AS name, \
                 CASE table_type WHEN 'BASE TABLE' THEN 'table' ELSE 'view' END AS object_type \
                 FROM information_schema.tables \
                 WHERE table_name ILIKE $1 \
                   AND table_schema NOT IN ('pg_catalog','information_schema') \
                 LIMIT $2",
            )
            .bind(&pattern)
            .bind(max)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("搜索失败: {e}"))?;

            // Functions
            let mut fns: Vec<Row> = sqlx::query_as(
                "SELECT routine_schema AS schema_name, routine_name AS name, \
                 'function' AS object_type \
                 FROM information_schema.routines \
                 WHERE routine_name ILIKE $1 \
                   AND routine_schema NOT IN ('pg_catalog','information_schema') \
                   AND routine_type = 'FUNCTION' \
                 LIMIT $2",
            )
            .bind(&pattern)
            .bind(max)
            .fetch_all(pool)
            .await
            .map_err(|e| format!("搜索函数失败: {e}"))?;

            results.append(&mut fns);
            results.sort_by(|a, b| a.name.cmp(&b.name));
            results.truncate(max as usize);

            let (current_db,): (String,) = sqlx::query_as("SELECT current_database()::text")
                .fetch_one(pool)
                .await
                .map_err(|e| format!("查询当前数据库失败: {e}"))?;

            Ok(results
                .into_iter()
                .map(|r| SearchResult {
                    database: current_db.clone(),
                    schema: Some(r.schema_name),
                    name: r.name,
                    object_type: r.object_type,
                })
                .collect())
        }
    }
}

// ─── Completion schema ───────────────────────────────────────────

/// One table entry with all its column names — used to build editor autocomplete.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionTable {
    pub database: String,
    pub schema: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
}

/// Bulk-fetch all table/column names for autocomplete.
/// MySQL: queries across all non-system databases.
/// PostgreSQL: queries all non-system schemas in the connected database.
#[tauri::command]
pub async fn get_completion_schema(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: Option<String>,
) -> Result<Vec<CompletionTable>, String> {
    let base = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?
        .pool
        .clone();
    let pool = match (&base, database.as_deref()) {
        (DbPool::Postgres(_), Some(db)) => {
            DbPool::Postgres(pools.pg_pool_for_database(&connection_id, db).await?)
        }
        _ => base,
    };
    match &pool {
        DbPool::MySQL(pool) => {
            #[derive(sqlx::FromRow)]
            struct Row {
                database_name: String,
                table_name: String,
                column_name: String,
            }

            let rows: Vec<Row> = sqlx::query_as(
                "SELECT c.TABLE_SCHEMA AS database_name, \
                        c.TABLE_NAME  AS table_name, \
                        c.COLUMN_NAME AS column_name \
                 FROM information_schema.COLUMNS c \
                 JOIN information_schema.TABLES t \
                   ON c.TABLE_SCHEMA = t.TABLE_SCHEMA \
                  AND c.TABLE_NAME   = t.TABLE_NAME \
                 WHERE c.TABLE_SCHEMA NOT IN \
                   ('information_schema','performance_schema','mysql','sys') \
                 AND (? IS NULL OR c.TABLE_SCHEMA = ?) \
                 ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION",
            )
            .bind(database.as_deref())
            .bind(database.as_deref())
            .fetch_all(pool)
            .await
            .map_err(|e| format!("获取补全数据失败: {e}"))?;

            let mut map: BTreeMap<(String, String), CompletionTable> = BTreeMap::new();
            for r in rows {
                let entry = map
                    .entry((r.database_name.clone(), r.table_name.clone()))
                    .or_insert(CompletionTable {
                        database: r.database_name,
                        schema: None,
                        name: r.table_name,
                        columns: vec![],
                    });
                entry.columns.push(r.column_name);
            }
            Ok(map.into_values().collect())
        }
        DbPool::Postgres(pool) => {
            #[derive(sqlx::FromRow)]
            struct Row {
                schema_name: String,
                table_name: String,
                column_name: String,
            }

            let rows: Vec<Row> = sqlx::query_as(
                "SELECT table_schema AS schema_name, \
                        table_name, \
                        column_name \
                 FROM information_schema.columns \
                 WHERE table_schema NOT IN ('pg_catalog','information_schema') \
                 ORDER BY table_schema, table_name, ordinal_position",
            )
            .fetch_all(pool)
            .await
            .map_err(|e| format!("获取补全数据失败: {e}"))?;

            let (current_db,): (String,) = sqlx::query_as("SELECT current_database()::text")
                .fetch_one(pool)
                .await
                .map_err(|e| format!("查询当前数据库失败: {e}"))?;

            let mut map: BTreeMap<(String, String), CompletionTable> = BTreeMap::new();
            for r in rows {
                let entry = map
                    .entry((r.schema_name.clone(), r.table_name.clone()))
                    .or_insert(CompletionTable {
                        database: current_db.clone(),
                        schema: Some(r.schema_name),
                        name: r.table_name,
                        columns: vec![],
                    });
                entry.columns.push(r.column_name);
            }
            Ok(map.into_values().collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_action_code_maps_all_actions() {
        assert_eq!(pg_action_code("a"), "NO ACTION");
        assert_eq!(pg_action_code("r"), "RESTRICT");
        assert_eq!(pg_action_code("c"), "CASCADE");
        assert_eq!(pg_action_code("n"), "SET NULL");
        assert_eq!(pg_action_code("d"), "SET DEFAULT");
        assert_eq!(pg_action_code("?"), "NO ACTION");
    }
}

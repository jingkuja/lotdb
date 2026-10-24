use crate::db::pool::{DbPool, PoolManager};
use crate::error::{AppError, ResultExt};
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
) -> Result<Vec<String>, AppError> {
    match &pools.pool(&connection_id)? {
        DbPool::MySQL(pool) => {
            let rows: Vec<(String,)> = sqlx::query_as("SHOW DATABASES")
                .fetch_all(pool)
                .await
                .ctx("查询数据库列表失败")?;
            Ok(rows.into_iter().map(|(name,)| name).collect())
        }
        DbPool::Postgres(pool) => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
            )
            .fetch_all(pool)
            .await
            .ctx("查询数据库列表失败")?;
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
) -> Result<Vec<String>, AppError> {
    if pools.dialect(&connection_id)?.is_mysql() {
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
    .ctx("查询 Schema 列表失败")?;
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
) -> Result<SchemaObjects, AppError> {
    match &pools.pool_for(&connection_id, &database).await? {
        DbPool::MySQL(pool) => {
            let tables: Vec<(String,)> = sqlx::query_as(
                "SELECT TABLE_NAME FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
                 ORDER BY TABLE_NAME",
            )
            .bind(&database)
            .fetch_all(pool)
            .await
            .ctx("查询表列表失败")?;

            let views: Vec<(String,)> = sqlx::query_as(
                "SELECT TABLE_NAME FROM information_schema.VIEWS \
                 WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            )
            .bind(&database)
            .fetch_all(pool)
            .await
            .ctx("查询视图列表失败")?;

            let functions: Vec<(String,)> = sqlx::query_as(
                "SELECT ROUTINE_NAME FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME",
            )
            .bind(&database)
            .fetch_all(pool)
            .await
            .ctx("查询函数列表失败")?;

            Ok(SchemaObjects {
                tables: tables.into_iter().map(|(n,)| n).collect(),
                views: views.into_iter().map(|(n,)| n).collect(),
                functions: functions.into_iter().map(|(n,)| n).collect(),
            })
        }
        DbPool::Postgres(pool) => {
            let schema_name = schema.as_deref().unwrap_or("public");

            let tables: Vec<(String,)> = sqlx::query_as(
                "SELECT table_name FROM information_schema.tables \
                 WHERE table_schema = $1 AND table_type = 'BASE TABLE' \
                 ORDER BY table_name",
            )
            .bind(schema_name)
            .fetch_all(pool)
            .await
            .ctx("查询表列表失败")?;

            let views: Vec<(String,)> = sqlx::query_as(
                "SELECT table_name FROM information_schema.views \
                 WHERE table_schema = $1 ORDER BY table_name",
            )
            .bind(schema_name)
            .fetch_all(pool)
            .await
            .ctx("查询视图列表失败")?;

            let functions: Vec<(String,)> = sqlx::query_as(
                "SELECT routine_name FROM information_schema.routines \
                 WHERE routine_schema = $1 AND routine_type = 'FUNCTION' \
                 ORDER BY routine_name",
            )
            .bind(schema_name)
            .fetch_all(pool)
            .await
            .ctx("查询函数列表失败")?;

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
    /// MySQL: the column as SHOW CREATE TABLE prints it, for regenerating a
    /// full column definition (MODIFY COLUMN) without losing attributes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mysql_definition: Option<MysqlColumnSql>,
}

/// Pieces of a MySQL column definition, each ready to paste into DDL.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlColumnSql {
    /// DEFAULT expression, quoted as the server prints it (`'abc'`,
    /// `CURRENT_TIMESTAMP`, `(uuid())`); empty when there is none or NULL.
    pub default_sql: String,
    /// `CHARACTER SET x COLLATE y`, bound to textual types.
    pub charset: String,
    /// `GENERATED ALWAYS AS (expr) VIRTUAL|STORED`.
    pub generated: String,
    /// Everything else: `ON UPDATE CURRENT_TIMESTAMP`, `SRID n`, `/*!80023 INVISIBLE */`.
    pub attributes: String,
}

/// Split one SHOW CREATE TABLE line into whitespace-separated tokens,
/// keeping quoted strings, parenthesised groups and comments whole.
fn ddl_tokens(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut tokens = vec![];
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        let mut depth = 0usize;
        while i < chars.len() && (depth > 0 || !chars[i].is_whitespace()) {
            match chars[i] {
                q @ ('\'' | '"' | '`') => {
                    i += 1;
                    while i < chars.len() {
                        if chars[i] == '\\' && q != '`' {
                            i += 2;
                            continue;
                        }
                        if chars[i] == q {
                            if chars.get(i + 1) == Some(&q) {
                                i += 2;
                                continue;
                            }
                            break;
                        }
                        i += 1;
                    }
                    i += 1;
                }
                '/' if depth == 0 && chars.get(i + 1) == Some(&'*') => {
                    while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                        i += 1;
                    }
                    i += 2;
                }
                '(' => {
                    depth += 1;
                    i += 1;
                }
                ')' => {
                    depth = depth.saturating_sub(1);
                    i += 1;
                }
                _ => i += 1,
            }
        }
        tokens.push(chars[start..i.min(chars.len())].iter().collect());
    }
    tokens
}

/// Column definitions from SHOW CREATE TABLE output, keyed by column name.
fn parse_mysql_create_columns(create: &str) -> std::collections::HashMap<String, MysqlColumnSql> {
    let mut out = std::collections::HashMap::new();
    for line in create.lines() {
        let Some(rest) = line.trim_start().strip_prefix('`') else {
            continue;
        };
        // `name` with doubled backticks inside.
        let mut name = String::new();
        let mut chars = rest.char_indices().peekable();
        let mut end = None;
        while let Some((idx, c)) = chars.next() {
            if c == '`' {
                if chars.peek().map(|(_, n)| *n) == Some('`') {
                    chars.next();
                    name.push('`');
                    continue;
                }
                end = Some(idx + 1);
                break;
            }
            name.push(c);
        }
        let Some(end) = end else { continue };
        let body = rest[end..].trim().trim_end_matches(',');
        let tokens = ddl_tokens(body);
        let upper = |i: usize| {
            tokens
                .get(i)
                .map(|t| t.to_ascii_uppercase())
                .unwrap_or_default()
        };
        let is_attr = |t: &str| {
            matches!(
                t,
                "CHARACTER"
                    | "COLLATE"
                    | "GENERATED"
                    | "NOT"
                    | "NULL"
                    | "DEFAULT"
                    | "ON"
                    | "AUTO_INCREMENT"
                    | "COMMENT"
                    | "SRID"
                    | "VISIBLE"
                    | "INVISIBLE"
            ) || t.starts_with("/*")
        };
        let mut col = MysqlColumnSql::default();
        let push = |field: &mut String, part: &str| {
            if !field.is_empty() {
                field.push(' ');
            }
            field.push_str(part);
        };
        // The data type comes first; LotDB reads it from COLUMN_TYPE.
        let mut i = 0;
        while i < tokens.len() && !is_attr(&upper(i)) {
            i += 1;
        }
        while i < tokens.len() {
            match upper(i).as_str() {
                "CHARACTER" => {
                    push(
                        &mut col.charset,
                        &tokens[i..(i + 3).min(tokens.len())].join(" "),
                    );
                    i += 3;
                }
                "COLLATE" => {
                    push(
                        &mut col.charset,
                        &tokens[i..(i + 2).min(tokens.len())].join(" "),
                    );
                    i += 2;
                }
                "GENERATED" => {
                    let start = i;
                    while i < tokens.len() {
                        let t = upper(i);
                        i += 1;
                        if t == "VIRTUAL" || t == "STORED" {
                            break;
                        }
                    }
                    col.generated = tokens[start..i].join(" ");
                }
                "NOT" => i += 2,
                "NULL" | "AUTO_INCREMENT" => i += 1,
                "COMMENT" => i += 2,
                "DEFAULT" => {
                    let value = tokens.get(i + 1).cloned().unwrap_or_default();
                    if !value.eq_ignore_ascii_case("NULL") {
                        col.default_sql = value;
                    }
                    i += 2;
                }
                "ON" => {
                    push(
                        &mut col.attributes,
                        &tokens[i..(i + 3).min(tokens.len())].join(" "),
                    );
                    i += 3;
                }
                _ => {
                    push(&mut col.attributes, &tokens[i]);
                    i += 1;
                }
            }
        }
        out.insert(name, col);
    }
    out
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
) -> Result<Vec<ColumnDef>, AppError> {
    match &pools.pool_for(&connection_id, &database).await? {
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
            .ctx("查询主键失败")?;
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

            // Best effort: views and odd output simply go without it.
            let create: Option<String> = sqlx::query(&format!(
                "SHOW CREATE TABLE {}",
                crate::utils::sql::qualified_mysql(&database, &table)
            ))
            .fetch_one(pool)
            .await
            .ok()
            .and_then(|row| sqlx::Row::try_get::<String, _>(&row, 1).ok());
            let mut definitions = create
                .as_deref()
                .map(parse_mysql_create_columns)
                .unwrap_or_default();

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
            .ctx("查询列失败")?;

            Ok(rows
                .into_iter()
                .map(|r| ColumnDef {
                    is_primary_key: pk_set.contains(&r.column_name),
                    mysql_definition: definitions.remove(&r.column_name),
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
        DbPool::Postgres(pool) => {
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
            .fetch_all(pool)
            .await
            .ctx("查询列失败")?;

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
                    mysql_definition: None,
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
) -> Result<Vec<IndexDef>, AppError> {
    match &pools.pool_for(&connection_id, &database).await? {
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
            .ctx("查询索引失败")?;

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
        DbPool::Postgres(pool) => {
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
            .fetch_all(pool)
            .await
            .ctx("查询索引失败")?;

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
) -> Result<Vec<ForeignKeyDef>, AppError> {
    get_table_foreign_keys_impl(&pools, connection_id, database, schema, table).await
}

pub async fn get_table_foreign_keys_impl(
    pools: &PoolManager,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<ForeignKeyDef>, AppError> {
    match &pools.pool_for(&connection_id, &database).await? {
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
            .ctx("查询外键失败")?;

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
        DbPool::Postgres(pool) => {
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
                 CROSS JOIN LATERAL unnest(c.conkey, c.confkey) \
                   WITH ORDINALITY AS k(attnum, ref_attnum, pos) \
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum \
                 JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = k.ref_attnum \
                 WHERE c.contype = 'f' AND n.nspname = $1 AND t.relname = $2 \
                 ORDER BY c.conname, k.pos",
            )
            .bind(schema_name)
            .bind(&table)
            .fetch_all(pool)
            .await
            .ctx("查询外键失败")?;

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
) -> Result<Vec<SearchResult>, AppError> {
    let max = limit.unwrap_or(100) as i64;
    let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));

    match &pools.pool(&connection_id)? {
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
            .ctx("搜索失败")?;

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
            .ctx("搜索函数失败")?;

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
            .ctx("搜索失败")?;

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
            .ctx("搜索函数失败")?;

            results.append(&mut fns);
            results.sort_by(|a, b| a.name.cmp(&b.name));
            results.truncate(max as usize);

            let (current_db,): (String,) = sqlx::query_as("SELECT current_database()::text")
                .fetch_one(pool)
                .await
                .ctx("查询当前数据库失败")?;

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
) -> Result<Vec<CompletionTable>, AppError> {
    let pool = match database.as_deref() {
        Some(db) => pools.pool_for(&connection_id, db).await?,
        None => pools.pool(&connection_id)?,
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
            .ctx("获取补全数据失败")?;

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
            .ctx("获取补全数据失败")?;

            let (current_db,): (String,) = sqlx::query_as("SELECT current_database()::text")
                .fetch_one(pool)
                .await
                .ctx("查询当前数据库失败")?;

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
    fn parses_mysql_column_definitions() {
        let create = "CREATE TABLE `t` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  \
            `code` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'a b''c' COMMENT 'x, y',\n  \
            `ts` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),\n  \
            `total` int GENERATED ALWAYS AS ((`id` * 2)) STORED,\n  \
            `u` char(36) DEFAULT (uuid()) /*!80023 INVISIBLE */,\n  \
            `we``ird` int DEFAULT NULL,\n  \
            PRIMARY KEY (`id`)\n) ENGINE=InnoDB";
        let cols = parse_mysql_create_columns(create);
        assert_eq!(cols.len(), 6);
        assert_eq!(cols["id"], MysqlColumnSql::default());
        assert_eq!(
            cols["code"],
            MysqlColumnSql {
                default_sql: "'a b''c'".into(),
                charset: "CHARACTER SET utf8mb4 COLLATE utf8mb4_bin".into(),
                ..Default::default()
            }
        );
        assert_eq!(cols["ts"].default_sql, "CURRENT_TIMESTAMP(3)");
        assert_eq!(cols["ts"].attributes, "ON UPDATE CURRENT_TIMESTAMP(3)");
        assert_eq!(
            cols["total"].generated,
            "GENERATED ALWAYS AS ((`id` * 2)) STORED"
        );
        assert_eq!(cols["u"].default_sql, "(uuid())");
        assert_eq!(cols["u"].attributes, "/*!80023 INVISIBLE */");
        assert_eq!(cols["we`ird"].default_sql, "");
    }

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

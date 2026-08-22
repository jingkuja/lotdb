//! Object management commands: view / function DDL, triggers, PG sequences
//! and PG enum types.

use crate::db::pool::{DbPool, PoolManager};
use crate::utils::sql::{
    pg_string_literal, qualified_mysql, qualified_pg, quote_ident_mysql, quote_ident_pg,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;

// ─── View / function DDL ──────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDdl {
    /// "view" | "function" | "procedure" | "trigger"
    pub object_type: String,
    pub name: String,
    pub ddl: String,
}

/// Return the CREATE statement of a view.
/// MySQL: `SHOW CREATE VIEW`; PG: `pg_get_viewdef` wrapped in CREATE OR REPLACE.
#[tauri::command]
pub async fn get_view_ddl(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    name: String,
) -> Result<ObjectDdl, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let sql = format!("SHOW CREATE VIEW {}", qualified_mysql(&database, &name));
            let row = sqlx::query(&sql)
                .fetch_one(pool)
                .await
                .map_err(|e| format!("获取视图定义失败: {e}"))?;
            // Columns: View, Create View, character_set_client, collation_connection
            let ddl: String = row
                .try_get(1)
                .map_err(|e| format!("读取视图定义失败: {e}"))?;
            Ok(ObjectDdl {
                object_type: "view".into(),
                name,
                ddl,
            })
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = pools
                .pg_pool_for_database(&connection_id, &database)
                .await?;
            let schema_name = schema.unwrap_or_else(|| "public".into());
            let def: String = sqlx::query_scalar(
                "SELECT pg_get_viewdef(format('%I.%I', $1, $2)::regclass, true)",
            )
            .bind(&schema_name)
            .bind(&name)
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("获取视图定义失败: {e}"))?;
            let ddl = format!(
                "CREATE OR REPLACE VIEW {}.{} AS\n{def}",
                quote_ident_pg(&schema_name),
                quote_ident_pg(&name)
            );
            Ok(ObjectDdl {
                object_type: "view".into(),
                name,
                ddl,
            })
        }
    }
}

/// Return the CREATE statement of a function or stored procedure.
/// MySQL tries FUNCTION first, then PROCEDURE (routines list merges both).
/// PG concatenates all overloads sharing the name.
#[tauri::command]
pub async fn get_function_ddl(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    name: String,
) -> Result<ObjectDdl, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            // Figure out whether this routine is a FUNCTION or a PROCEDURE.
            let routine_type: Option<String> = sqlx::query_scalar(
                "SELECT ROUTINE_TYPE FROM information_schema.ROUTINES \
                     WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? LIMIT 1",
            )
            .bind(&database)
            .bind(&name)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("查询例程类型失败: {e}"))?;
            let Some(routine_type) = routine_type else {
                return Err(format!("找不到例程 {name}"));
            };

            let show_sql = if routine_type == "FUNCTION" {
                format!("SHOW CREATE FUNCTION {}", qualified_mysql(&database, &name))
            } else {
                format!(
                    "SHOW CREATE PROCEDURE {}",
                    qualified_mysql(&database, &name)
                )
            };
            let row = sqlx::query(&show_sql)
                .fetch_one(pool)
                .await
                .map_err(|e| format!("获取例程定义失败: {e}"))?;
            // Columns: Name, sql_mode, Create Function/Procedure, …
            let ddl: String = row
                .try_get(2)
                .map_err(|e| format!("读取例程定义失败: {e}"))?;
            Ok(ObjectDdl {
                object_type: if routine_type == "FUNCTION" {
                    "function".into()
                } else {
                    "procedure".into()
                },
                name,
                ddl,
            })
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = pools
                .pg_pool_for_database(&connection_id, &database)
                .await?;
            let schema_name = schema.unwrap_or_else(|| "public".into());
            let defs: Vec<String> = sqlx::query_scalar(
                "SELECT pg_get_functiondef(p.oid) \
                 FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2 \
                 ORDER BY p.oid",
            )
            .bind(&schema_name)
            .bind(&name)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("获取函数定义失败: {e}"))?;
            if defs.is_empty() {
                return Err(format!("找不到函数 {schema_name}.{name}"));
            }
            Ok(ObjectDdl {
                object_type: "function".into(),
                name,
                ddl: defs.join(";\n\n"),
            })
        }
    }
}

// ─── Triggers ─────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    /// Table the trigger is attached to.
    pub table: String,
    /// MySQL: "BEFORE" | "AFTER"; PG: full timing from pg_get_triggerdef
    /// ("BEFORE" / "AFTER" / "INSTEAD OF").
    pub timing: String,
    /// INSERT / UPDATE / DELETE (PG may list several).
    pub event: String,
    pub ddl: String,
}

/// List triggers in a database (optionally filtered to one table).
#[tauri::command]
pub async fn list_triggers(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: Option<String>,
) -> Result<Vec<TriggerInfo>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            #[derive(sqlx::FromRow)]
            struct Row {
                trigger_name: String,
                event_manipulation: String,
                event_object_table: String,
                action_timing: String,
                action_statement: String,
            }
            let mut sql = String::from(
                "SELECT TRIGGER_NAME as trigger_name, \
                        EVENT_MANIPULATION as event_manipulation, \
                        EVENT_OBJECT_TABLE as event_object_table, \
                        ACTION_TIMING as action_timing, \
                        ACTION_STATEMENT as action_statement \
                 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?",
            );
            let table_filter = table.clone();
            if table_filter.is_some() {
                sql.push_str(" AND EVENT_OBJECT_TABLE = ?");
            }
            sql.push_str(" ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME");

            let mut q = sqlx::query_as::<_, Row>(&sql).bind(&database);
            if let Some(t) = &table_filter {
                q = q.bind(t);
            }
            let rows = q
                .fetch_all(pool)
                .await
                .map_err(|e| format!("查询触发器失败: {e}"))?;

            Ok(rows
                .into_iter()
                .map(|r| TriggerInfo {
                    ddl: format!(
                        "CREATE TRIGGER {} {} {} ON {} FOR EACH ROW {}",
                        quote_ident_mysql(&r.trigger_name),
                        r.action_timing,
                        r.event_manipulation,
                        quote_ident_mysql(&r.event_object_table),
                        r.action_statement
                    ),
                    name: r.trigger_name,
                    table: r.event_object_table,
                    timing: r.action_timing,
                    event: r.event_manipulation,
                })
                .collect())
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = pools
                .pg_pool_for_database(&connection_id, &database)
                .await?;
            let schema_name = schema.unwrap_or_else(|| "public".into());

            #[derive(sqlx::FromRow)]
            struct Row {
                tgname: String,
                table_name: String,
                ddl: String,
            }
            let sql = match &table {
                Some(_) => {
                    "SELECT t.tgname, c.relname AS table_name, \
                            pg_get_triggerdef(t.oid, true) AS ddl \
                     FROM pg_trigger t \
                     JOIN pg_class c ON c.oid = t.tgrelid \
                     JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2 \
                     ORDER BY c.relname, t.tgname"
                }
                None => {
                    "SELECT t.tgname, c.relname AS table_name, \
                            pg_get_triggerdef(t.oid, true) AS ddl \
                     FROM pg_trigger t \
                     JOIN pg_class c ON c.oid = t.tgrelid \
                     JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE NOT t.tgisinternal AND n.nspname = $1 \
                     ORDER BY c.relname, t.tgname"
                }
            };
            let mut q = sqlx::query_as::<_, Row>(sql).bind(&schema_name);
            if let Some(t) = &table {
                q = q.bind(t);
            }
            let rows = q
                .fetch_all(&pool)
                .await
                .map_err(|e| format!("查询触发器失败: {e}"))?;

            Ok(rows
                .into_iter()
                .map(|r| {
                    // pg_get_triggerdef: CREATE TRIGGER name {timing} {event} ON …
                    let after_name = r.ddl.strip_prefix(&format!("CREATE TRIGGER {}", r.tgname));
                    let mut timing = String::new();
                    let mut event = String::new();
                    if let Some(rest) = after_name {
                        // rest = " BEFORE INSERT ON ..." / " AFTER UPDATE OF x ON ..."
                        let words: Vec<&str> = rest.split_whitespace().collect();
                        if let Some(t) = words.first() {
                            timing = t.to_string();
                        }
                        if let Some(ev) = words.get(1) {
                            event = ev.to_string();
                        }
                    }
                    TriggerInfo {
                        name: r.tgname,
                        table: r.table_name,
                        timing,
                        event,
                        ddl: r.ddl,
                    }
                })
                .collect())
        }
    }
}

/// Return the full CREATE TRIGGER statement for one trigger.
#[tauri::command]
pub async fn get_trigger_ddl(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: Option<String>,
    name: String,
) -> Result<ObjectDdl, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            #[derive(sqlx::FromRow)]
            struct Row {
                event_manipulation: String,
                event_object_table: String,
                action_timing: String,
                action_statement: String,
            }
            let row = sqlx::query_as::<_, Row>(
                "SELECT EVENT_MANIPULATION as event_manipulation, \
                        EVENT_OBJECT_TABLE as event_object_table, \
                        ACTION_TIMING as action_timing, \
                        ACTION_STATEMENT as action_statement \
                 FROM information_schema.TRIGGERS \
                 WHERE TRIGGER_SCHEMA = ? AND TRIGGER_NAME = ? LIMIT 1",
            )
            .bind(&database)
            .bind(&name)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("查询触发器失败: {e}"))?;
            let Some(r) = row else {
                return Err(format!("找不到触发器 {name}"));
            };
            let ddl = format!(
                "CREATE TRIGGER {} {} {} ON {} FOR EACH ROW {}",
                quote_ident_mysql(&name),
                r.action_timing,
                r.event_manipulation,
                quote_ident_mysql(&r.event_object_table),
                r.action_statement
            );
            Ok(ObjectDdl {
                object_type: "trigger".into(),
                name,
                ddl,
            })
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = pools
                .pg_pool_for_database(&connection_id, &database)
                .await?;
            let schema_name = schema.unwrap_or_else(|| "public".into());
            let ddl: String = sqlx::query_scalar(
                "SELECT pg_get_triggerdef(t.oid, true) \
                 FROM pg_trigger t \
                 JOIN pg_class c ON c.oid = t.tgrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE NOT t.tgisinternal AND n.nspname = $1 AND t.tgname = $2 \
                   AND ($3::text = '' OR c.relname = $3) \
                 LIMIT 1",
            )
            .bind(&schema_name)
            .bind(&name)
            .bind(table.as_deref().unwrap_or(""))
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("查询触发器失败: {e}"))?;
            Ok(ObjectDdl {
                object_type: "trigger".into(),
                name,
                ddl,
            })
        }
    }
}

/// Drop a trigger.
#[tauri::command]
pub async fn drop_trigger(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    name: String,
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    match &entry.pool {
        DbPool::MySQL(pool) => {
            let sql = format!("DROP TRIGGER {}", qualified_mysql(&database, &name));
            sqlx::query(&sql)
                .execute(pool)
                .await
                .map_err(|e| format!("删除触发器失败: {e}"))?;
        }
        DbPool::Postgres(_) => {
            drop(entry);
            let pool = pools
                .pg_pool_for_database(&connection_id, &database)
                .await?;
            let schema_name = schema.unwrap_or_else(|| "public".into());
            let sql = format!(
                "DROP TRIGGER {} ON {}",
                quote_ident_pg(&name),
                qualified_pg(&schema_name, &table)
            );
            sqlx::query(&sql)
                .execute(&pool)
                .await
                .map_err(|e| format!("删除触发器失败: {e}"))?;
        }
    }
    Ok(())
}

// ─── PG sequences ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceInfo {
    pub name: String,
    pub data_type: String,
    pub start_value: i64,
    pub min_value: i64,
    pub max_value: i64,
    pub increment_by: i64,
    pub cycle: bool,
    /// Last value obtained; None when the sequence was never used.
    pub last_value: Option<i64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SequenceOptions {
    pub start: Option<i64>,
    pub increment: Option<i64>,
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub cycle: bool,
}

/// List sequences in a PG schema.
#[tauri::command]
pub async fn list_sequences(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
) -> Result<Vec<SequenceInfo>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let DbPool::Postgres(_) = &entry.pool else {
        return Err("序列仅支持 PostgreSQL".into());
    };
    drop(entry);
    let pool = pools
        .pg_pool_for_database(&connection_id, &database)
        .await?;
    let schema_name = schema.unwrap_or_else(|| "public".into());

    #[derive(sqlx::FromRow)]
    struct Row {
        sequencename: String,
        data_type: String,
        start_value: i64,
        min_value: i64,
        max_value: i64,
        increment_by: i64,
        cycle: bool,
        last_value: Option<i64>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT sequencename, \
                data_type::text AS data_type, \
                start_value::bigint, min_value::bigint, max_value::bigint, \
                increment_by::bigint, cycle, last_value::bigint \
         FROM pg_sequences WHERE schemaname = $1 \
         ORDER BY sequencename",
    )
    .bind(&schema_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询序列失败: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|r| SequenceInfo {
            name: r.sequencename,
            data_type: r.data_type,
            start_value: r.start_value,
            min_value: r.min_value,
            max_value: r.max_value,
            increment_by: r.increment_by,
            cycle: r.cycle,
            last_value: r.last_value,
        })
        .collect())
}

/// Create a sequence in a PG schema.
#[tauri::command]
pub async fn create_sequence(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    name: String,
    options: SequenceOptions,
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let DbPool::Postgres(_) = &entry.pool else {
        return Err("序列仅支持 PostgreSQL".into());
    };
    drop(entry);
    let pool = pools
        .pg_pool_for_database(&connection_id, &database)
        .await?;
    let schema_name = schema.unwrap_or_else(|| "public".into());

    let mut sql = format!("CREATE SEQUENCE {}", qualified_pg(&schema_name, &name));
    if let Some(v) = options.increment {
        sql.push_str(&format!(" INCREMENT BY {v}"));
    }
    if let Some(v) = options.min {
        sql.push_str(&format!(" MINVALUE {v}"));
    }
    if let Some(v) = options.max {
        sql.push_str(&format!(" MAXVALUE {v}"));
    }
    if let Some(v) = options.start {
        sql.push_str(&format!(" START WITH {v}"));
    }
    sql.push_str(if options.cycle { " CYCLE" } else { " NO CYCLE" });

    sqlx::query(&sql)
        .execute(&pool)
        .await
        .map_err(|e| format!("创建序列失败: {e}"))?;
    Ok(())
}

/// Restart a sequence, optionally at a specific value.
#[tauri::command]
pub async fn restart_sequence(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    name: String,
    value: Option<i64>,
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let DbPool::Postgres(_) = &entry.pool else {
        return Err("序列仅支持 PostgreSQL".into());
    };
    drop(entry);
    let pool = pools
        .pg_pool_for_database(&connection_id, &database)
        .await?;
    let schema_name = schema.unwrap_or_else(|| "public".into());

    let mut sql = format!(
        "ALTER SEQUENCE {} RESTART",
        qualified_pg(&schema_name, &name)
    );
    if let Some(v) = value {
        sql.push_str(&format!(" WITH {v}"));
    }
    sqlx::query(&sql)
        .execute(&pool)
        .await
        .map_err(|e| format!("重置序列失败: {e}"))?;
    Ok(())
}

/// Drop a sequence.
#[tauri::command]
pub async fn drop_sequence(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    name: String,
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let DbPool::Postgres(_) = &entry.pool else {
        return Err("序列仅支持 PostgreSQL".into());
    };
    drop(entry);
    let pool = pools
        .pg_pool_for_database(&connection_id, &database)
        .await?;
    let schema_name = schema.unwrap_or_else(|| "public".into());

    let sql = format!("DROP SEQUENCE {}", qualified_pg(&schema_name, &name));
    sqlx::query(&sql)
        .execute(&pool)
        .await
        .map_err(|e| format!("删除序列失败: {e}"))?;
    Ok(())
}

// ─── PG enum types ────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumTypeInfo {
    pub name: String,
    pub labels: Vec<String>,
}

/// List enum types in a PG schema.
#[tauri::command]
pub async fn list_enums(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
) -> Result<Vec<EnumTypeInfo>, String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let DbPool::Postgres(_) = &entry.pool else {
        return Err("枚举类型仅支持 PostgreSQL".into());
    };
    drop(entry);
    let pool = pools
        .pg_pool_for_database(&connection_id, &database)
        .await?;
    let schema_name = schema.unwrap_or_else(|| "public".into());

    #[derive(sqlx::FromRow)]
    struct Row {
        name: String,
        labels: Vec<String>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT t.typname AS name, \
                COALESCE(array_agg(e.enumlabel ORDER BY e.enumsortorder), ARRAY[]::text[])::text[] AS labels \
         FROM pg_type t \
         JOIN pg_namespace n ON n.oid = t.typnamespace \
         LEFT JOIN pg_enum e ON e.enumtypid = t.oid \
         WHERE t.typtype = 'e' AND n.nspname = $1 \
         GROUP BY t.typname \
         ORDER BY t.typname",
    )
    .bind(&schema_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询枚举类型失败: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|r| EnumTypeInfo {
            name: r.name,
            labels: r.labels,
        })
        .collect())
}

/// Create an enum type.
#[tauri::command]
pub async fn create_enum_type(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    name: String,
    labels: Vec<String>,
) -> Result<(), String> {
    if labels.is_empty() {
        return Err("枚举至少需要一个值".into());
    }
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let DbPool::Postgres(_) = &entry.pool else {
        return Err("枚举类型仅支持 PostgreSQL".into());
    };
    drop(entry);
    let pool = pools
        .pg_pool_for_database(&connection_id, &database)
        .await?;
    let schema_name = schema.unwrap_or_else(|| "public".into());

    let values = labels
        .iter()
        .map(|l| pg_string_literal(l))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "CREATE TYPE {} AS ENUM ({values})",
        qualified_pg(&schema_name, &name)
    );
    sqlx::query(&sql)
        .execute(&pool)
        .await
        .map_err(|e| format!("创建枚举类型失败: {e}"))?;
    Ok(())
}

/// Append a value to an enum type.
#[tauri::command]
pub async fn add_enum_value(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    name: String,
    label: String,
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let DbPool::Postgres(_) = &entry.pool else {
        return Err("枚举类型仅支持 PostgreSQL".into());
    };
    drop(entry);
    let pool = pools
        .pg_pool_for_database(&connection_id, &database)
        .await?;
    let schema_name = schema.unwrap_or_else(|| "public".into());

    let sql = format!(
        "ALTER TYPE {} ADD VALUE {}",
        qualified_pg(&schema_name, &name),
        pg_string_literal(&label)
    );
    sqlx::query(&sql)
        .execute(&pool)
        .await
        .map_err(|e| format!("添加枚举值失败: {e}"))?;
    Ok(())
}

/// Drop an enum type. `cascade` also drops dependent columns (DESTRUCTIVE).
#[tauri::command]
pub async fn drop_enum_type(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    name: String,
    cascade: bool,
) -> Result<(), String> {
    let entry = pools
        .pools
        .get(&connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;

    let DbPool::Postgres(_) = &entry.pool else {
        return Err("枚举类型仅支持 PostgreSQL".into());
    };
    drop(entry);
    let pool = pools
        .pg_pool_for_database(&connection_id, &database)
        .await?;
    let schema_name = schema.unwrap_or_else(|| "public".into());

    let sql = format!(
        "DROP TYPE {}{}",
        qualified_pg(&schema_name, &name),
        if cascade { " CASCADE" } else { "" }
    );
    sqlx::query(&sql)
        .execute(&pool)
        .await
        .map_err(|e| format!("删除枚举类型失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_idents() {
        assert_eq!(quote_ident_mysql("we`ird"), "`we``ird`");
        assert_eq!(quote_ident_pg("q\"uote"), "\"q\"\"uote\"");
    }

    #[test]
    fn string_literals_doubling() {
        assert_eq!(pg_string_literal("it's"), "'it''s'");
    }
}

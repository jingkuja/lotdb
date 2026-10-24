//! Object-tree maintenance: drop / truncate / rename / copy tables, and drop
//! views and routines.

use crate::db::pool::{DbPool, PoolManager};
use crate::error::{AppError, ResultExt};
use crate::utils::sql::{qualified_mysql, qualified_pg};
use tauri::State;

/// Drop a table, view or routine. `kind`: "table" | "view" | "function".
#[tauri::command]
pub async fn drop_object(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    kind: String,
    name: String,
) -> Result<(), AppError> {
    drop_object_impl(
        &pools,
        &connection_id,
        &database,
        schema.as_deref(),
        &kind,
        &name,
    )
    .await
}

pub async fn drop_object_impl(
    pools: &PoolManager,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
    kind: &str,
    name: &str,
) -> Result<(), AppError> {
    pools.ensure_writable(connection_id)?;
    let pool = pools.pool_for(connection_id, database).await?;
    let object_ref = pool.dialect().table_ref(database, schema, name);
    let sql = match kind {
        "table" => format!("DROP TABLE {object_ref}"),
        "view" => format!("DROP VIEW {object_ref}"),
        "function" => drop_routine_sql(&pool, database, schema, name).await?,
        other => return Err(format!("不支持删除的对象类型: {other}").into()),
    };
    pool.execute(&sql).await.ctx("删除失败")?;
    Ok(())
}

/// The object tree lists routines by name only. MySQL keeps functions and
/// procedures in separate namespaces; PostgreSQL needs the argument types,
/// and an overloaded name is ambiguous.
async fn drop_routine_sql(
    pool: &DbPool,
    database: &str,
    schema: Option<&str>,
    name: &str,
) -> Result<String, AppError> {
    match pool {
        DbPool::MySQL(p) => {
            let kinds: Vec<String> = sqlx::query_scalar(
                "SELECT CAST(ROUTINE_TYPE AS CHAR) FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?",
            )
            .bind(database)
            .bind(name)
            .fetch_all(p)
            .await
            .ctx("查询例程失败")?;
            match kinds.as_slice() {
                [kind] => Ok(format!("DROP {kind} {}", qualified_mysql(database, name))),
                [] => Err(format!("找不到例程 {name}").into()),
                _ => Err(format!(
                    "{name} 同时是函数和存储过程，请在查询中用 DROP FUNCTION / DROP PROCEDURE 删除"
                )
                .into()),
            }
        }
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or("public");
            let overloads: Vec<(String, String)> = sqlx::query_as(
                "SELECT pg_get_function_identity_arguments(p.oid), p.prokind::text \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2",
            )
            .bind(schema)
            .bind(name)
            .fetch_all(p)
            .await
            .ctx("查询函数失败")?;
            match overloads.as_slice() {
                [(args, kind)] => {
                    let keyword = match kind.as_str() {
                        "p" => "PROCEDURE",
                        "a" => "AGGREGATE",
                        _ => "FUNCTION",
                    };
                    Ok(format!(
                        "DROP {keyword} {}({args})",
                        qualified_pg(schema, name)
                    ))
                }
                [] => Err(format!("找不到函数 {schema}.{name}").into()),
                many => Err(format!(
                    "{name} 有 {} 个重载版本，请在查询中指定参数类型删除",
                    many.len()
                )
                .into()),
            }
        }
    }
}

/// Remove every row of a table (TRUNCATE).
#[tauri::command]
pub async fn truncate_table(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> Result<(), AppError> {
    pools.ensure_writable(&connection_id)?;
    let pool = pools.pool_for(&connection_id, &database).await?;
    let table_ref = pool
        .dialect()
        .table_ref(&database, schema.as_deref(), &table);
    pool.execute(&format!("TRUNCATE TABLE {table_ref}"))
        .await
        .ctx("清空表失败")?;
    Ok(())
}

/// Rename a table within its database / schema.
#[tauri::command]
pub async fn rename_table(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    new_name: String,
) -> Result<(), AppError> {
    rename_table_impl(
        &pools,
        &connection_id,
        &database,
        schema.as_deref(),
        &table,
        &new_name,
    )
    .await
}

pub async fn rename_table_impl(
    pools: &PoolManager,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
    table: &str,
    new_name: &str,
) -> Result<(), AppError> {
    pools.ensure_writable(connection_id)?;
    if new_name.trim().is_empty() {
        return Err("表名不能为空".into());
    }
    let pool = pools.pool_for(connection_id, database).await?;
    let dialect = pool.dialect();
    let old_ref = dialect.table_ref(database, schema, table);
    let sql = if dialect.is_mysql() {
        format!(
            "RENAME TABLE {old_ref} TO {}",
            dialect.table_ref(database, schema, new_name)
        )
    } else {
        format!(
            "ALTER TABLE {old_ref} RENAME TO {}",
            dialect.quote_ident(new_name)
        )
    };
    pool.execute(&sql).await.ctx("重命名表失败")?;
    Ok(())
}

/// Create `new_name` with the structure of `table` (columns, defaults,
/// indexes; not foreign keys), optionally copying its rows too.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn copy_table(
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    new_name: String,
    with_data: bool,
) -> Result<(), AppError> {
    copy_table_impl(
        &pools,
        &connection_id,
        &database,
        schema.as_deref(),
        &table,
        &new_name,
        with_data,
    )
    .await
}

pub async fn copy_table_impl(
    pools: &PoolManager,
    connection_id: &str,
    database: &str,
    schema: Option<&str>,
    table: &str,
    new_name: &str,
    with_data: bool,
) -> Result<(), AppError> {
    pools.ensure_writable(connection_id)?;
    if new_name.trim().is_empty() {
        return Err("表名不能为空".into());
    }
    let pool = pools.pool_for(connection_id, database).await?;
    let dialect = pool.dialect();
    let source = dialect.table_ref(database, schema, table);
    let target = dialect.table_ref(database, schema, new_name);
    let create = if dialect.is_mysql() {
        format!("CREATE TABLE {target} LIKE {source}")
    } else {
        format!("CREATE TABLE {target} (LIKE {source} INCLUDING ALL)")
    };
    pool.execute(&create).await.ctx("复制表结构失败")?;
    if !with_data {
        return Ok(());
    }

    // Generated columns can't be written, so name the others explicitly.
    let columns: Vec<String> = match &pool {
        DbPool::MySQL(p) => {
            sqlx::query_scalar(
                "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%' \
             ORDER BY ORDINAL_POSITION",
            )
            .bind(database)
            .bind(table)
            .fetch_all(p)
            .await
        }
        DbPool::Postgres(p) => {
            sqlx::query_scalar(
                "SELECT column_name::text FROM information_schema.columns \
             WHERE table_schema = $1 AND table_name = $2 AND is_generated = 'NEVER' \
             ORDER BY ordinal_position",
            )
            .bind(schema.unwrap_or("public"))
            .bind(table)
            .fetch_all(p)
            .await
        }
    }
    .ctx("读取列失败")?;
    let list = dialect.column_list(&columns);
    // Identity columns declared GENERATED ALWAYS refuse explicit values
    // unless told otherwise.
    let overriding = if dialect.is_mysql() {
        ""
    } else {
        " OVERRIDING SYSTEM VALUE"
    };
    let copy = format!("INSERT INTO {target} ({list}){overriding} SELECT {list} FROM {source}");
    if let Err(e) = pool.execute(&copy).await {
        // Don't leave a half-done copy behind.
        let _ = pool.execute(&format!("DROP TABLE {target}")).await;
        return Err(AppError::from_sqlx("复制数据失败（已删除新建的表）", e));
    }
    Ok(())
}

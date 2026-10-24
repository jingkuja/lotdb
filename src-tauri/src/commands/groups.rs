//! Connection group CRUD backed by the local SQLite store.

use crate::error::{local_store, AppError};
use crate::models::connection::ConnectionGroup;
use sqlx::SqlitePool;
use tauri::State;

type DbPool = SqlitePool;

#[tauri::command]
pub async fn list_groups(pool: State<'_, DbPool>) -> Result<Vec<ConnectionGroup>, AppError> {
    let rows = sqlx::query_as::<_, GroupRow>(
        "SELECT id, name, parent_id FROM connection_groups ORDER BY name",
    )
    .fetch_all(pool.inner())
    .await
    .map_err(local_store("保存分组失败"))?;

    Ok(rows
        .into_iter()
        .map(|r| ConnectionGroup {
            id: r.id,
            name: r.name,
            parent_id: r.parent_id,
        })
        .collect())
}

#[tauri::command]
pub async fn create_group(
    pool: State<'_, DbPool>,
    name: String,
    parent_id: Option<String>,
) -> Result<ConnectionGroup, AppError> {
    if name.trim().is_empty() {
        return Err("分组名称不能为空".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO connection_groups (id, name, parent_id) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(name.trim())
        .bind(&parent_id)
        .execute(pool.inner())
        .await
        .map_err(local_store("保存分组失败"))?;

    Ok(ConnectionGroup {
        id,
        name: name.trim().to_string(),
        parent_id,
    })
}

#[tauri::command]
pub async fn rename_group(
    pool: State<'_, DbPool>,
    id: String,
    name: String,
) -> Result<(), AppError> {
    if name.trim().is_empty() {
        return Err("分组名称不能为空".into());
    }
    sqlx::query("UPDATE connection_groups SET name = ? WHERE id = ?")
        .bind(name.trim())
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(local_store("保存分组失败"))?;
    Ok(())
}

/// Delete a group. Member connections are moved to "ungrouped" (group_id
/// nulled), never deleted.
#[tauri::command]
pub async fn delete_group(pool: State<'_, DbPool>, id: String) -> Result<(), AppError> {
    sqlx::query("UPDATE connections SET group_id = NULL WHERE group_id = ?")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(local_store("保存分组失败"))?;
    sqlx::query("DELETE FROM connection_groups WHERE id = ?")
        .bind(&id)
        .execute(pool.inner())
        .await
        .map_err(local_store("保存分组失败"))?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct GroupRow {
    id: String,
    name: String,
    parent_id: Option<String>,
}

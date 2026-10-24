use crate::error::{local_store, AppError};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;

type LocalDb = SqlitePool;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SnippetEntry {
    pub id: i64,
    pub name: String,
    pub sql: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// List all snippets, optionally filtering by name/description/sql.
#[tauri::command]
pub async fn get_snippets(
    db: State<'_, LocalDb>,
    search: Option<String>,
) -> Result<Vec<SnippetEntry>, AppError> {
    let rows = if let Some(q) = search.filter(|s| !s.is_empty()) {
        let pattern = format!("%{q}%");
        sqlx::query_as::<_, SnippetEntry>(
            "SELECT * FROM snippets \
             WHERE name LIKE ? OR description LIKE ? OR sql LIKE ? \
             ORDER BY updated_at DESC",
        )
        .bind(&pattern)
        .bind(&pattern)
        .bind(&pattern)
        .fetch_all(db.inner())
        .await
    } else {
        sqlx::query_as::<_, SnippetEntry>("SELECT * FROM snippets ORDER BY updated_at DESC")
            .fetch_all(db.inner())
            .await
    }
    .map_err(local_store("查询片段失败"))?;

    Ok(rows)
}

/// Create a new snippet.
#[tauri::command]
pub async fn create_snippet(
    db: State<'_, LocalDb>,
    name: String,
    sql: String,
    description: Option<String>,
) -> Result<SnippetEntry, AppError> {
    let result = sqlx::query("INSERT INTO snippets (name, sql, description) VALUES (?, ?, ?)")
        .bind(&name)
        .bind(&sql)
        .bind(&description)
        .execute(db.inner())
        .await
        .map_err(local_store("创建片段失败"))?;

    let id = result.last_insert_rowid();
    sqlx::query_as::<_, SnippetEntry>("SELECT * FROM snippets WHERE id = ?")
        .bind(id)
        .fetch_one(db.inner())
        .await
        .map_err(local_store("读取新片段失败"))
}

/// Update an existing snippet.
#[tauri::command]
pub async fn update_snippet(
    db: State<'_, LocalDb>,
    id: i64,
    name: String,
    sql: String,
    description: Option<String>,
) -> Result<SnippetEntry, AppError> {
    sqlx::query(
        "UPDATE snippets SET name=?, sql=?, description=?, \
         updated_at=datetime('now') WHERE id=?",
    )
    .bind(&name)
    .bind(&sql)
    .bind(&description)
    .bind(id)
    .execute(db.inner())
    .await
    .map_err(local_store("更新片段失败"))?;

    sqlx::query_as::<_, SnippetEntry>("SELECT * FROM snippets WHERE id = ?")
        .bind(id)
        .fetch_one(db.inner())
        .await
        .map_err(local_store("读取片段失败"))
}

/// Delete a snippet by id.
#[tauri::command]
pub async fn delete_snippet(db: State<'_, LocalDb>, id: i64) -> Result<(), AppError> {
    sqlx::query("DELETE FROM snippets WHERE id = ?")
        .bind(id)
        .execute(db.inner())
        .await
        .map_err(local_store("删除片段失败"))?;
    Ok(())
}

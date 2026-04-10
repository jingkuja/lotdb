use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;

type LocalDb = SqlitePool;

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub connection_name: String,
    pub sql: String,
    pub status: String,
    pub rows_affected: Option<i64>,
    pub execution_ms: Option<i64>,
    pub error_message: Option<String>,
    pub executed_at: String,
}

/// Persist a query execution to history.
#[tauri::command]
pub async fn save_history(
    db: State<'_, LocalDb>,
    connection_id: String,
    connection_name: String,
    sql: String,
    status: String,
    rows_affected: Option<i64>,
    execution_ms: Option<i64>,
    error_message: Option<String>,
) -> Result<i64, String> {
    let result = sqlx::query(
        "INSERT INTO query_history \
         (connection_id, connection_name, sql, status, rows_affected, execution_ms, error_message) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&connection_id)
    .bind(&connection_name)
    .bind(&sql)
    .bind(&status)
    .bind(rows_affected)
    .bind(execution_ms)
    .bind(&error_message)
    .execute(db.inner())
    .await
    .map_err(|e| format!("保存历史失败: {e}"))?;

    Ok(result.last_insert_rowid())
}

/// Fetch recent history entries, optionally filtered by connection.
#[tauri::command]
pub async fn get_history(
    db: State<'_, LocalDb>,
    connection_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<HistoryEntry>, String> {
    let max = limit.unwrap_or(200);

    let rows = if let Some(conn_id) = connection_id {
        sqlx::query_as::<_, HistoryEntry>(
            "SELECT * FROM query_history WHERE connection_id = ? \
             ORDER BY executed_at DESC LIMIT ?",
        )
        .bind(conn_id)
        .bind(max)
        .fetch_all(db.inner())
        .await
    } else {
        sqlx::query_as::<_, HistoryEntry>(
            "SELECT * FROM query_history ORDER BY executed_at DESC LIMIT ?",
        )
        .bind(max)
        .fetch_all(db.inner())
        .await
    }
    .map_err(|e| format!("查询历史失败: {e}"))?;

    Ok(rows)
}

/// Delete a single history entry by id.
#[tauri::command]
pub async fn delete_history(db: State<'_, LocalDb>, id: i64) -> Result<(), String> {
    sqlx::query("DELETE FROM query_history WHERE id = ?")
        .bind(id)
        .execute(db.inner())
        .await
        .map_err(|e| format!("删除历史失败: {e}"))?;
    Ok(())
}

/// Clear all history, optionally for a specific connection.
#[tauri::command]
pub async fn clear_history(
    db: State<'_, LocalDb>,
    connection_id: Option<String>,
) -> Result<(), String> {
    if let Some(conn_id) = connection_id {
        sqlx::query("DELETE FROM query_history WHERE connection_id = ?")
            .bind(conn_id)
            .execute(db.inner())
            .await
    } else {
        sqlx::query("DELETE FROM query_history")
            .execute(db.inner())
            .await
    }
    .map_err(|e| format!("清空历史失败: {e}"))?;

    Ok(())
}

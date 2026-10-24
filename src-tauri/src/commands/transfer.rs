use crate::db::pool::{DbPool, PoolManager};
use dashmap::DashMap;
use futures::{stream::BoxStream, StreamExt};
use rust_xlsxwriter::{Color, Format, Workbook};
use serde::{Deserialize, Serialize};
use sqlx::{Column, Row};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Instant;
use tauri::{Emitter, State};

// ─── Result types ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub rows_exported: u64,
    pub file_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub rows_imported: u64,
    pub rows_failed: u64,
    pub error_message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    current: u64,
    rows_per_sec: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    current: u64,
    total: u64,
    rows_per_sec: f64,
    eta_sec: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchExportProgress {
    table_index: usize,
    total_tables: usize,
    table: String,
}

// ─── Value → export string helpers ───────────────────────────────

/// Format a JSON value for CSV: wrap strings in quotes, numbers raw, null as empty.
fn csv_cell(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => {
            // RFC 4180: wrap in quotes, escape internal quotes by doubling
            let escaped = s.replace('"', "\"\"");
            format!("\"{escaped}\"")
        }
        other => {
            let s = other.to_string();
            let escaped = s.replace('"', "\"\"");
            format!("\"{escaped}\"")
        }
    }
}

/// Format a JSON value for SQL INSERT: NULL, numbers raw, everything else quoted.
fn sql_val(v: &serde_json::Value, mysql: bool) -> String {
    if let Some(hex) = v.get("$lotdbBinary").and_then(|v| v.as_str()) {
        // Type tags only come from our row converter, or validated imports.
        if hex.len() % 2 == 0 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return if mysql {
                format!("X'{hex}'")
            } else {
                format!("decode('{hex}', 'hex')")
            };
        }
    }
    match v {
        serde_json::Value::Null => "NULL".into(),
        serde_json::Value::Bool(b) => {
            if *b {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => crate::utils::sql::string_literal(s, mysql),
        other => crate::utils::sql::string_literal(&other.to_string(), mysql),
    }
}

fn import_literal(value: Option<&str>, binary: bool, boolean: bool, mysql: bool) -> String {
    let Some(s) = value else {
        return "NULL".into();
    };
    if boolean {
        if s.eq_ignore_ascii_case("true") {
            return "TRUE".into();
        }
        if s.eq_ignore_ascii_case("false") {
            return "FALSE".into();
        }
    }
    if binary {
        if let Some(hex) = s.strip_prefix("\\x") {
            return sql_val(&serde_json::json!({"$lotdbBinary": hex}), mysql);
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
            if v.get("$lotdbBinary").is_some() {
                return sql_val(&v, mysql);
            }
        }
    }
    crate::utils::sql::string_literal(s, mysql)
}

struct ImportColumnKinds {
    all: std::collections::HashSet<String>,
    binary: std::collections::HashSet<String>,
    boolean: std::collections::HashSet<String>,
}

async fn import_column_kinds(
    pool: &DbPool,
    database: &str,
    schema: Option<&str>,
    table: &str,
) -> Result<ImportColumnKinds, String> {
    let columns: Vec<(String, String)> = match pool {
        DbPool::MySQL(p) => sqlx::query_as("SELECT COLUMN_NAME, CAST(COLUMN_TYPE AS CHAR) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")
            .bind(database).bind(table).fetch_all(p).await,
        DbPool::Postgres(p) => sqlx::query_as("SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2")
            .bind(schema.unwrap_or("public")).bind(table).fetch_all(p).await,
    }.map_err(|e| format!("获取导入列类型失败: {e}"))?;
    let mut kinds = ImportColumnKinds {
        all: columns.iter().map(|(name, _)| name.clone()).collect(),
        binary: Default::default(),
        boolean: Default::default(),
    };
    for (name, kind) in columns {
        let kind = kind.to_ascii_lowercase();
        if kind.contains("blob")
            || kind.starts_with("binary")
            || kind.starts_with("varbinary")
            || kind == "bytea"
        {
            kinds.binary.insert(name.clone());
        }
        if kind == "bool" || kind.starts_with("tinyint(1)") {
            kinds.boolean.insert(name);
        }
    }
    Ok(kinds)
}

// ─── Value extractors ─────────────────────────────────────────────
// Shared with query.rs / data.rs — see db::value.

use crate::db::value::{mysql_export_value as mysql_val, pg_export_value as pg_val};

/// Export / transfer reads use the text protocol (`raw_sql`) so every column
/// arrives in the server's own text form — PG enums, inet, ranges, geometry
/// etc. all survive. `raw_sql` accepts multiple statements, so the raw WHERE
/// fragment must not smuggle in a second one.
fn ensure_single_statement(sql: &str, mysql: bool) -> Result<(), String> {
    if crate::utils::sql::split_sql(sql, mysql)?.len() != 1 {
        return Err("筛选条件只能是单个 WHERE 表达式，不能包含多条语句".into());
    }
    Ok(())
}

fn row_values<R: Row>(
    row: &R,
    convert: impl Fn(&R, usize) -> Result<serde_json::Value, String>,
) -> Result<Vec<serde_json::Value>, String> {
    (0..row.columns().len()).map(|i| convert(row, i)).collect()
}

/// Resolve the pool a data command must query through.
/// MySQL: the main pool (the database is qualified inside the SQL).
/// PostgreSQL: routed through `pg_pool_for_database` so the command runs in
/// the database the user selected, not the connection's default database.
async fn resolve_pool(
    pools: &PoolManager,
    connection_id: &str,
    database: &str,
) -> Result<DbPool, String> {
    let entry = pools
        .pools
        .get(connection_id)
        .ok_or_else(|| format!("连接 {connection_id} 未打开"))?;
    match &entry.pool {
        DbPool::MySQL(p) => Ok(DbPool::MySQL(p.clone())),
        DbPool::Postgres(_) => {
            drop(entry);
            Ok(DbPool::Postgres(
                pools.pg_pool_for_database(connection_id, database).await?,
            ))
        }
    }
}

// ─── File writers ─────────────────────────────────────────────────

fn write_excel(
    file_path: &str,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();

    // Header style: bold + light blue background
    let header_fmt = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xD9E1F2))
        .set_border(rust_xlsxwriter::FormatBorder::Thin);

    // Write headers
    for (col_idx, col_name) in columns.iter().enumerate() {
        worksheet
            .write_string_with_format(0, col_idx as u16, col_name, &header_fmt)
            .map_err(|e| format!("写入标题失败: {e}"))?;
    }

    // Freeze header row
    worksheet
        .set_freeze_panes(1, 0)
        .map_err(|e| format!("冻结行失败: {e}"))?;

    // Write data rows
    for (row_idx, row) in rows.iter().enumerate() {
        let row_num = (row_idx + 1) as u32;
        for (col_idx, val) in row.iter().enumerate() {
            let col_num = col_idx as u16;
            match val {
                serde_json::Value::Null => {} // leave cell empty
                serde_json::Value::Bool(b) => {
                    worksheet
                        .write_boolean(row_num, col_num, *b)
                        .map_err(|e| format!("写入布尔失败: {e}"))?;
                }
                serde_json::Value::Number(n) => {
                    if let Some(f) = n.as_f64() {
                        worksheet
                            .write_number(row_num, col_num, f)
                            .map_err(|e| format!("写入数字失败: {e}"))?;
                    }
                }
                serde_json::Value::String(s) => {
                    worksheet
                        .write_string(row_num, col_num, s)
                        .map_err(|e| format!("写入字符串失败: {e}"))?;
                }
                other => {
                    worksheet
                        .write_string(row_num, col_num, other.to_string())
                        .map_err(|e| format!("写入值失败: {e}"))?;
                }
            }
        }
    }

    // Auto-fit column widths (estimate: max of header length and 12)
    for (col_idx, col_name) in columns.iter().enumerate() {
        let width = (col_name.len() as f64 + 2.0).clamp(12.0, 40.0);
        worksheet
            .set_column_width(col_idx as u16, width)
            .map_err(|e| format!("设置列宽失败: {e}"))?;
    }

    workbook
        .save(file_path)
        .map_err(|e| format!("保存 Excel 文件失败: {e}"))?;

    Ok(())
}

// ─── Export command ───────────────────────────────────────────────

fn build_select_sql(
    q_table: &str,
    col_select: &str,
    where_clause: Option<&str>,
    limit: u64,
) -> String {
    let where_part = where_clause
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!(" WHERE {s}"))
        .unwrap_or_default();
    let limit_part = if limit > 0 {
        format!(" LIMIT {limit}")
    } else {
        String::new()
    };
    format!("SELECT {col_select} FROM {q_table}{where_part}{limit_part}")
}

/// Export table data to a file, streaming rows to avoid loading everything into memory.
///
/// - `format`: "csv" | "json" | "sql_insert" | "excel"
/// - `columns`: selected column names; empty = all columns
/// - `where_clause`: raw SQL WHERE expression (without the WHERE keyword), optional
/// - `limit`: max rows to export; 0 = no limit
/// - `file_path`: absolute path to the output file
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_table_data(
    app: tauri::AppHandle,
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    format: String,
    columns: Vec<String>,
    where_clause: Option<String>,
    limit: u64,
    file_path: String,
) -> Result<ExportResult, String> {
    export_table_data_impl(
        Some(&app),
        &pools,
        connection_id,
        database,
        schema,
        table,
        format,
        columns,
        where_clause,
        limit,
        file_path,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn export_table_data_impl(
    app: Option<&tauri::AppHandle>,
    pools: &PoolManager,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    format: String,
    columns: Vec<String>,
    where_clause: Option<String>,
    limit: u64,
    file_path: String,
) -> Result<ExportResult, String> {
    // Route PG queries to the selected database (not the connection default).
    let pool = resolve_pool(pools, &connection_id, &database).await?;

    // Excel needs all rows in memory (rust_xlsxwriter builds the file in-memory)
    // Use fetch_all for excel; stream for everything else.
    if format == "excel" {
        let (col_names, rows) = fetch_all_as_json(
            &pool,
            &database,
            schema.as_deref(),
            &table,
            &columns,
            where_clause.as_deref(),
            limit,
        )
        .await?;
        write_excel(&file_path, &col_names, &rows)?;
        return Ok(ExportResult {
            rows_exported: rows.len() as u64,
            file_path,
        });
    }

    // Build SQL and open output file
    let (table_ref, col_select, db_quote): (String, String, fn(&str) -> String) = match &pool {
        DbPool::MySQL(_) => {
            let tr = crate::utils::sql::qualified_mysql(&database, &table);
            let cs = if columns.is_empty() {
                "*".to_string()
            } else {
                columns
                    .iter()
                    .map(|c| crate::utils::sql::quote_ident_mysql(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            (tr, cs, |c| crate::utils::sql::quote_ident_mysql(c))
        }
        DbPool::Postgres(_) => {
            let sn = schema.as_deref().unwrap_or("public");
            let tr = crate::utils::sql::qualified_pg(sn, &table);
            let cs = if columns.is_empty() {
                "*".to_string()
            } else {
                columns
                    .iter()
                    .map(|c| crate::utils::sql::quote_ident_pg(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            (tr, cs, |c| crate::utils::sql::quote_ident_pg(c))
        }
    };

    let sql = build_select_sql(&table_ref, &col_select, where_clause.as_deref(), limit);
    ensure_single_statement(&sql, matches!(&pool, DbPool::MySQL(_)))?;

    let file = File::create(&file_path).map_err(|e| format!("创建文件失败: {e}"))?;
    let mut writer = BufWriter::new(file);

    let start = Instant::now();
    let mut rows_exported: u64 = 0;
    let mut col_names: Vec<String> = vec![];

    macro_rules! emit_export_progress {
        () => {
            if rows_exported % 500 == 0 {
                let elapsed = start.elapsed().as_secs_f64().max(0.001);
                if let Some(app) = app {
                    app.emit(
                        "export-progress",
                        ExportProgress {
                            current: rows_exported,
                            rows_per_sec: rows_exported as f64 / elapsed,
                        },
                    )
                    .ok();
                }
            }
        };
    }

    match format.as_str() {
        "json" => {
            write!(writer, "[").map_err(|e| format!("写入失败: {e}"))?;
            match &pool {
                DbPool::MySQL(pool) => {
                    let mut stream = sqlx::raw_sql(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        let vals = row_values(&row, mysql_val)?;
                        let obj: serde_json::Map<String, serde_json::Value> =
                            col_names.iter().cloned().zip(vals).collect();
                        if rows_exported > 0 {
                            write!(writer, ",").map_err(|e| format!("写入失败: {e}"))?;
                        }
                        let s = serde_json::to_string(&serde_json::Value::Object(obj))
                            .map_err(|e| format!("序列化失败: {e}"))?;
                        write!(writer, "\n  {s}").map_err(|e| format!("写入失败: {e}"))?;
                        rows_exported += 1;
                        emit_export_progress!();
                    }
                }
                DbPool::Postgres(pool) => {
                    let mut stream = sqlx::raw_sql(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        let vals = row_values(&row, pg_val)?;
                        let obj: serde_json::Map<String, serde_json::Value> =
                            col_names.iter().cloned().zip(vals).collect();
                        if rows_exported > 0 {
                            write!(writer, ",").map_err(|e| format!("写入失败: {e}"))?;
                        }
                        let s = serde_json::to_string(&serde_json::Value::Object(obj))
                            .map_err(|e| format!("序列化失败: {e}"))?;
                        write!(writer, "\n  {s}").map_err(|e| format!("写入失败: {e}"))?;
                        rows_exported += 1;
                        emit_export_progress!();
                    }
                }
            }
            writeln!(writer, "\n]").map_err(|e| format!("写入失败: {e}"))?;
        }
        "sql_insert" => {
            writeln!(writer, "-- Generated by LotDB").map_err(|e| format!("写入失败: {e}"))?;
            match &pool {
                DbPool::MySQL(pool) => {
                    let mut stream = sqlx::raw_sql(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        let vals = row_values(&row, mysql_val)?;
                        let col_list = col_names
                            .iter()
                            .map(|c| db_quote(c))
                            .collect::<Vec<_>>()
                            .join(", ");
                        let val_list = vals
                            .iter()
                            .map(|v| sql_val(v, true))
                            .collect::<Vec<_>>()
                            .join(", ");
                        writeln!(
                            writer,
                            "INSERT INTO {table_ref} ({col_list}) VALUES ({val_list});"
                        )
                        .map_err(|e| format!("写入失败: {e}"))?;
                        rows_exported += 1;
                        emit_export_progress!();
                    }
                }
                DbPool::Postgres(pool) => {
                    let mut stream = sqlx::raw_sql(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        let vals = row_values(&row, pg_val)?;
                        let col_list = col_names
                            .iter()
                            .map(|c| db_quote(c))
                            .collect::<Vec<_>>()
                            .join(", ");
                        let val_list = vals
                            .iter()
                            .map(|v| sql_val(v, false))
                            .collect::<Vec<_>>()
                            .join(", ");
                        writeln!(
                            writer,
                            "INSERT INTO {table_ref} ({col_list}) VALUES ({val_list});"
                        )
                        .map_err(|e| format!("写入失败: {e}"))?;
                        rows_exported += 1;
                        emit_export_progress!();
                    }
                }
            }
        }
        _ => {
            // CSV (default)
            match &pool {
                DbPool::MySQL(pool) => {
                    let mut stream = sqlx::raw_sql(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                            writeln!(writer, "{}", col_names.join(","))
                                .map_err(|e| format!("写入失败: {e}"))?;
                        }
                        let vals: Vec<String> =
                            row_values(&row, mysql_val)?.iter().map(csv_cell).collect();
                        writeln!(writer, "{}", vals.join(","))
                            .map_err(|e| format!("写入失败: {e}"))?;
                        rows_exported += 1;
                        emit_export_progress!();
                    }
                }
                DbPool::Postgres(pool) => {
                    let mut stream = sqlx::raw_sql(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                            writeln!(writer, "{}", col_names.join(","))
                                .map_err(|e| format!("写入失败: {e}"))?;
                        }
                        let vals: Vec<String> =
                            row_values(&row, pg_val)?.iter().map(csv_cell).collect();
                        writeln!(writer, "{}", vals.join(","))
                            .map_err(|e| format!("写入失败: {e}"))?;
                        rows_exported += 1;
                        emit_export_progress!();
                    }
                }
            }
        }
    }

    writer.flush().map_err(|e| format!("刷新缓冲区失败: {e}"))?;

    // Final progress event
    if let Some(app) = app {
        app.emit(
            "export-progress",
            ExportProgress {
                current: rows_exported,
                rows_per_sec: rows_exported as f64 / start.elapsed().as_secs_f64().max(0.001),
            },
        )
        .ok();
    }

    Ok(ExportResult {
        rows_exported,
        file_path,
    })
}

// Helper: fetch all rows as JSON values (used for Excel which can't stream)
async fn fetch_all_as_json(
    pool: &DbPool,
    database: &str,
    schema: Option<&str>,
    table: &str,
    columns: &[String],
    where_clause: Option<&str>,
    limit: u64,
) -> Result<(Vec<String>, Vec<Vec<serde_json::Value>>), String> {
    let (q_table, col_select) = match pool {
        DbPool::MySQL(_) => {
            let tr = crate::utils::sql::qualified_mysql(database, table);
            let cs = if columns.is_empty() {
                "*".to_string()
            } else {
                columns
                    .iter()
                    .map(|c| crate::utils::sql::quote_ident_mysql(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            (tr, cs)
        }
        DbPool::Postgres(_) => {
            let sn = schema.unwrap_or("public");
            let tr = crate::utils::sql::qualified_pg(sn, table);
            let cs = if columns.is_empty() {
                "*".to_string()
            } else {
                columns
                    .iter()
                    .map(|c| crate::utils::sql::quote_ident_pg(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            (tr, cs)
        }
    };
    let sql = build_select_sql(&q_table, &col_select, where_clause, limit);
    ensure_single_statement(&sql, matches!(pool, DbPool::MySQL(_)))?;

    match pool {
        DbPool::MySQL(p) => {
            let db_rows = sqlx::raw_sql(&sql)
                .fetch_all(p)
                .await
                .map_err(|e| format!("查询失败: {e}"))?;
            let col_names = db_rows
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let rows = db_rows
                .iter()
                .map(|r| row_values(r, mysql_val))
                .collect::<Result<_, _>>()?;
            Ok((col_names, rows))
        }
        DbPool::Postgres(p) => {
            let db_rows = sqlx::raw_sql(&sql)
                .fetch_all(p)
                .await
                .map_err(|e| format!("查询失败: {e}"))?;
            let col_names = db_rows
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let rows = db_rows
                .iter()
                .map(|r| row_values(r, pg_val))
                .collect::<Result<_, _>>()?;
            Ok((col_names, rows))
        }
    }
}

// ─── Batch export ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableExportStatus {
    pub table: String,
    pub rows_exported: u64,
    pub file_path: String,
    pub error: Option<String>,
}

fn ext_for_format(format: &str) -> &'static str {
    match format {
        "json" => "json",
        "sql_insert" => "sql",
        "excel" => "xlsx",
        _ => "csv",
    }
}

/// Export multiple tables to a directory, one file per table.
///
/// - `format`: "csv" | "json" | "sql_insert" | "excel"
/// - `limit`: max rows per table; 0 = no limit
/// - `output_dir`: directory to write files into
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn batch_export_tables(
    app: tauri::AppHandle,
    pools: State<'_, PoolManager>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    tables: Vec<String>,
    format: String,
    limit: u64,
    output_dir: String,
) -> Result<Vec<TableExportStatus>, String> {
    let ext = ext_for_format(&format);
    let total_tables = tables.len();
    let mut results: Vec<TableExportStatus> = Vec::new();

    for (table_index, table) in tables.iter().enumerate() {
        app.emit(
            "export-batch-progress",
            BatchExportProgress {
                table_index,
                total_tables,
                table: table.clone(),
            },
        )
        .ok();

        let file_path = format!("{output_dir}/{table}.{ext}");
        // Same streaming path as single-table export, so a large table never
        // has to fit in memory (Excel aside: the workbook is built in memory).
        let result = export_table_data_impl(
            None,
            &pools,
            connection_id.clone(),
            database.clone(),
            schema.clone(),
            table.clone(),
            format.clone(),
            vec![],
            None,
            limit,
            file_path.clone(),
        )
        .await;
        results.push(match result {
            Ok(done) => TableExportStatus {
                table: table.clone(),
                rows_exported: done.rows_exported,
                file_path,
                error: None,
            },
            Err(e) => TableExportStatus {
                table: table.clone(),
                rows_exported: 0,
                file_path,
                error: Some(format!("{table}: {e}")),
            },
        });
    }

    Ok(results)
}

// ─── Preview command ──────────────────────────────────────────────

/// Return the first `preview_rows` rows of a CSV or JSON file without touching the DB.
#[tauri::command]
pub async fn preview_import_file(
    file_path: String,
    format: String,
    has_header: bool,
    preview_rows: usize,
) -> Result<FilePreview, String> {
    let (columns, mut rows): (Vec<String>, Vec<Vec<Option<String>>>) = match format.as_str() {
        "csv" => parse_csv(&file_path, has_header)?,
        "json" => parse_json(&file_path)?,
        _ => return Err("SQL 文件无需预览".to_string()),
    };
    rows.truncate(preview_rows);
    Ok(FilePreview { columns, rows })
}

// ─── Import command ───────────────────────────────────────────────

/// Parse a CSV/JSON/SQL file and INSERT rows into a table.
///
/// - `format`: "csv" | "json" | "sql"
/// - `has_header`: (CSV only) whether the first row is a header
/// - `truncate_first`: run TRUNCATE TABLE before inserting
/// - `column_mapping`: per-source-column target name (None = skip that column)
///   Length must match the number of source columns; for SQL format it is ignored.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_table_data(
    app: tauri::AppHandle,
    pools: State<'_, PoolManager>,
    registry: State<'_, TransferRegistry>,
    import_id: Option<String>,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    file_path: String,
    format: String,
    has_header: bool,
    truncate_first: bool,
    column_mapping: Vec<Option<String>>,
) -> Result<ImportResult, String> {
    let import_id = import_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let control = registry.register(&import_id)?;
    let result = import_impl(
        Some(&app),
        &pools,
        connection_id,
        database,
        schema,
        table,
        file_path,
        format,
        has_header,
        truncate_first,
        column_mapping,
        &control,
    )
    .await;
    registry.finish(&import_id);
    result
}

#[allow(clippy::too_many_arguments)]
pub async fn import_table_data_impl(
    app: Option<&tauri::AppHandle>,
    pools: &PoolManager,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    file_path: String,
    format: String,
    has_header: bool,
    truncate_first: bool,
    column_mapping: Vec<Option<String>>,
) -> Result<ImportResult, String> {
    import_impl(
        app,
        pools,
        connection_id,
        database,
        schema,
        table,
        file_path,
        format,
        has_header,
        truncate_first,
        column_mapping,
        &TransferControl::default(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn import_impl(
    app: Option<&tauri::AppHandle>,
    pools: &PoolManager,
    connection_id: String,
    database: String,
    schema: Option<String>,
    table: String,
    file_path: String,
    format: String,
    has_header: bool,
    truncate_first: bool,
    column_mapping: Vec<Option<String>>,
    control: &TransferControl,
) -> Result<ImportResult, String> {
    pools.ensure_writable(&connection_id)?;
    // Route PG queries to the selected database (not the connection default).
    let pool = resolve_pool(pools, &connection_id, &database).await?;

    // ── SQL: execute statements directly ──────────────────────────
    if format == "sql" {
        let content =
            std::fs::read_to_string(&file_path).map_err(|e| format!("读取文件失败: {e}"))?;

        let stmts = crate::utils::sql::split_sql(&content, matches!(&pool, DbPool::MySQL(_)))?;
        let mut mysql_conn = if let DbPool::MySQL(p) = &pool {
            let mut conn = p.acquire().await.map_err(|e| e.to_string())?.detach();
            sqlx::Executor::execute(
                &mut conn,
                format!("USE {}", crate::utils::sql::quote_ident_mysql(&database)).as_str(),
            )
            .await
            .map_err(|e| e.to_string())?;
            Some(conn)
        } else {
            None
        };
        let mut pg_conn = if let DbPool::Postgres(p) = &pool {
            Some(p.acquire().await.map_err(|e| e.to_string())?.detach())
        } else {
            None
        };
        if truncate_first {
            run_truncate(&pool, &database, schema.as_deref(), &table).await?;
        }

        let total = stmts.len() as u64;
        let mut rows_imported: u64 = 0;
        let mut rows_failed: u64 = 0;
        let mut first_error: Option<String> = None;
        let start = Instant::now();

        for (idx, stmt) in stmts.iter().enumerate() {
            if control.cancelled.load(Ordering::Acquire) {
                first_error = Some(format!("已取消：已执行 {idx} / {total} 条语句"));
                break;
            }
            let res = if let Some(conn) = &mut mysql_conn {
                sqlx::Executor::execute(&mut *conn, stmt.as_str())
                    .await
                    .map(|r| r.rows_affected())
            } else {
                sqlx::Executor::execute(pg_conn.as_mut().unwrap(), stmt.as_str())
                    .await
                    .map(|r| r.rows_affected())
            };
            match res {
                Ok(n) => rows_imported += n,
                Err(e) => {
                    rows_failed += 1;
                    if first_error.is_none() {
                        first_error = Some(e.to_string());
                    }
                }
            }
            let current = (idx + 1) as u64;
            if current.is_multiple_of(50) || current == total {
                let elapsed = start.elapsed().as_secs_f64().max(0.001);
                let rps = current as f64 / elapsed;
                let eta = if rps > 0.0 {
                    (total - current) as f64 / rps
                } else {
                    0.0
                };
                if let Some(app) = app {
                    app.emit(
                        "import-progress",
                        ImportProgress {
                            current,
                            total,
                            rows_per_sec: rps,
                            eta_sec: eta,
                        },
                    )
                    .ok();
                }
            }
        }

        let error_message = match first_error {
            Some(e) if rows_failed > 0 => Some(format!("{rows_failed} 条语句失败: {e}")),
            other => other,
        };
        return Ok(ImportResult {
            rows_imported,
            rows_failed,
            error_message,
        });
    }

    let mysql = matches!(&pool, DbPool::MySQL(_));
    let (col_names, rows, total): (Vec<String>, ImportRowIter, u64) = match format.as_str() {
        // JSON arrays aren't streamable; parse into memory.
        "json" => {
            let (cols, rows) = parse_json(&file_path)?;
            let total = rows.len() as u64;
            (cols, Box::new(rows.into_iter().map(Ok)), total)
        }
        "csv" => open_csv_rows(&file_path, has_header)?,
        _ => return Err(format!("不支持的格式: {format}")),
    };
    if total == 0 {
        return Ok(ImportResult {
            rows_imported: 0,
            rows_failed: 0,
            error_message: None,
        });
    }

    // Validate the mapping before anything touches the table.
    let column_kinds = import_column_kinds(&pool, &database, schema.as_deref(), &table).await?;
    let effective_mapping: Vec<Option<String>> = if column_mapping.is_empty() {
        col_names.iter().map(|n| Some(n.clone())).collect()
    } else {
        column_mapping
    };
    let mut seen = std::collections::HashSet::new();
    let mut mapped = vec![];
    for (index, target) in effective_mapping.into_iter().enumerate() {
        let Some(target) = target else { continue };
        if !column_kinds.all.contains(&target) {
            return Err(format!("目标表 {table} 中没有列 {target}"));
        }
        if !seen.insert(target.clone()) {
            return Err(format!("目标列 {target} 重复映射"));
        }
        mapped.push((index, target));
    }
    if mapped.is_empty() {
        return Err("至少需要映射一列".to_string());
    }

    let table_ref = table_ref(&pool, &database, schema.as_deref(), &table);
    let col_list = mapped
        .iter()
        .map(|(_, c)| {
            if mysql {
                crate::utils::sql::quote_ident_mysql(c)
            } else {
                crate::utils::sql::quote_ident_pg(c)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let formatter = ImportRowFormatter {
        mapped,
        kinds: column_kinds,
        mysql,
    };

    let mut conn = ImportConn::acquire(&pool).await?;
    let result = insert_import_rows(
        app,
        &mut conn,
        &format!("INSERT INTO {table_ref} ({col_list}) VALUES "),
        truncate_first.then(|| clear_table_sql(mysql, &table_ref)),
        rows,
        total,
        &formatter,
        control,
    )
    .await;
    conn.close().await;
    result
}

/// Turns a parsed file row into a `(v1, v2, …)` VALUES tuple.
struct ImportRowFormatter {
    /// (source column index, target column name)
    mapped: Vec<(usize, String)>,
    kinds: ImportColumnKinds,
    mysql: bool,
}

impl ImportRowFormatter {
    fn values(&self, row: &[Option<String>]) -> String {
        let values = self
            .mapped
            .iter()
            .map(|(src_idx, target)| {
                import_literal(
                    row.get(*src_idx).and_then(|o| o.as_deref()),
                    self.kinds.binary.contains(target),
                    self.kinds.boolean.contains(target),
                    self.mysql,
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("({values})")
    }
}

type ImportRowIter = Box<dyn Iterator<Item = Result<Vec<Option<String>>, String>> + Send>;

/// Stream CSV records from disk. A first pass counts rows for progress.
fn open_csv_rows(
    file_path: &str,
    has_header: bool,
) -> Result<(Vec<String>, ImportRowIter, u64), String> {
    let reader = || {
        csv::ReaderBuilder::new()
            .has_headers(has_header)
            .flexible(true)
            .from_path(file_path)
            .map_err(|e| format!("CSV 读取失败: {e}"))
    };
    let mut counter = reader()?;
    let total = counter.records().count() as u64;
    let mut rdr = reader()?;
    let col_names: Vec<String> = if has_header {
        rdr.headers()
            .map_err(|e| format!("读取标题失败: {e}"))?
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        // Column count comes from the first record; `reader()` starts over.
        let width = first_record_width(reader()?)?;
        (1..=width).map(|i| format!("col{i}")).collect()
    };
    let rows = rdr.into_records().map(|record| {
        record
            .map(|r| {
                r.iter()
                    .map(|s| (!s.is_empty()).then(|| s.to_string()))
                    .collect()
            })
            .map_err(|e| format!("CSV 行解析失败: {e}"))
    });
    Ok((col_names, Box::new(rows), total))
}

fn first_record_width(mut rdr: csv::Reader<File>) -> Result<usize, String> {
    Ok(rdr
        .records()
        .next()
        .transpose()
        .map_err(|e| format!("CSV 行解析失败: {e}"))?
        .map_or(0, |r| r.len()))
}

/// Rows per INSERT, and a byte cap that keeps statements well under the
/// default MySQL max_allowed_packet (same limits as table transfer).
const IMPORT_BATCH_ROWS: usize = 500;
const IMPORT_BATCH_BYTES: usize = 512 * 1024;

/// Insert rows in multi-row batches on one dedicated connection.
///
/// With `clear_sql` (the "empty table first" option) the clear and every
/// batch run in a single transaction: any failure or a cancel rolls back and
/// the table keeps its original rows. Without it, each batch commits on its
/// own; a failing batch is retried row by row so good rows still land and
/// bad ones are counted.
#[allow(clippy::too_many_arguments)]
async fn insert_import_rows(
    app: Option<&tauri::AppHandle>,
    conn: &mut ImportConn,
    prefix: &str,
    clear_sql: Option<String>,
    mut rows: ImportRowIter,
    total: u64,
    formatter: &ImportRowFormatter,
    control: &TransferControl,
) -> Result<ImportResult, String> {
    let atomic = clear_sql.is_some();
    let db_err = |e: sqlx::Error| e.to_string();
    if let Some(clear_sql) = clear_sql {
        conn.exec("BEGIN").await.map_err(db_err)?;
        if let Err(e) = conn.exec(&clear_sql).await {
            conn.rollback().await;
            return Err(format!("清空表失败: {e}"));
        }
    }

    let start = Instant::now();
    let mut rows_imported = 0u64;
    let mut rows_failed = 0u64;
    let mut first_error: Option<String> = None;
    let mut line = 0u64;
    let mut cancelled = false;
    loop {
        if control.cancelled.load(Ordering::Acquire) {
            cancelled = true;
            break;
        }
        // Collect the next batch.
        let batch_start = line + 1;
        let mut batch: Vec<String> = vec![];
        let mut bytes = 0;
        let mut parse_error = None;
        for row in rows.by_ref() {
            line += 1;
            match row {
                Ok(row) => {
                    let values = formatter.values(&row);
                    bytes += values.len();
                    batch.push(values);
                }
                Err(e) if atomic => {
                    parse_error = Some(e);
                    break;
                }
                Err(e) => {
                    rows_failed += 1;
                    first_error.get_or_insert(format!("第 {line} 行：{e}"));
                }
            }
            if batch.len() >= IMPORT_BATCH_ROWS || bytes >= IMPORT_BATCH_BYTES {
                break;
            }
        }
        if let Some(e) = parse_error {
            conn.rollback().await;
            return Err(format!("第 {line} 行：{e}。已回滚，表数据未改动"));
        }
        if batch.is_empty() {
            break;
        }

        let sql = format!("{prefix}{}", batch.join(","));
        if atomic {
            if let Err(e) = conn.exec(&sql).await {
                conn.rollback().await;
                return Err(format!(
                    "第 {batch_start}–{line} 行导入失败：{e}。已回滚，表数据未改动"
                ));
            }
            rows_imported += batch.len() as u64;
        } else {
            match conn.exec_in_transaction(&sql).await {
                Ok(n) => rows_imported += n,
                Err(_) => {
                    // Find the offending rows; the rest still go in.
                    for (offset, values) in batch.iter().enumerate() {
                        match conn.exec(&format!("{prefix}{values}")).await {
                            Ok(n) => rows_imported += n,
                            Err(e) => {
                                rows_failed += 1;
                                let row_no = batch_start + offset as u64;
                                first_error.get_or_insert(format!("第 {row_no} 行：{e}"));
                            }
                        }
                    }
                }
            }
        }

        if let Some(app) = app {
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            let rps = line as f64 / elapsed;
            app.emit(
                "import-progress",
                ImportProgress {
                    current: line,
                    total,
                    rows_per_sec: rps,
                    eta_sec: if rps > 0.0 {
                        total.saturating_sub(line) as f64 / rps
                    } else {
                        0.0
                    },
                },
            )
            .ok();
        }
    }

    if atomic {
        if cancelled {
            conn.rollback().await;
            return Err("已取消，已回滚，表数据未改动".into());
        }
        conn.exec("COMMIT").await.map_err(db_err)?;
    }
    let error_message = if cancelled {
        Some(format!("已取消：已导入 {rows_imported} 行，其余未导入"))
    } else {
        first_error.map(|e| format!("{rows_failed} 行失败，{e}"))
    };
    Ok(ImportResult {
        rows_imported,
        rows_failed,
        error_message,
    })
}

/// A connection detached from the pool: if the import is interrupted while a
/// transaction is open, dropping it closes the socket and the server rolls
/// back, instead of a pooled connection coming back mid-transaction.
enum ImportConn {
    MySql(sqlx::MySqlConnection),
    Pg(sqlx::PgConnection),
}

impl ImportConn {
    async fn acquire(pool: &DbPool) -> Result<Self, String> {
        Ok(match pool {
            DbPool::MySQL(p) => {
                ImportConn::MySql(p.acquire().await.map_err(|e| e.to_string())?.detach())
            }
            DbPool::Postgres(p) => {
                ImportConn::Pg(p.acquire().await.map_err(|e| e.to_string())?.detach())
            }
        })
    }

    /// A bare `&str` has no arguments, so sqlx sends it over the text
    /// protocol: every batch is a different statement, and preparing them
    /// would only cost a round trip and fill the statement cache.
    async fn exec(&mut self, sql: &str) -> Result<u64, sqlx::Error> {
        match self {
            ImportConn::MySql(c) => sqlx::Executor::execute(&mut *c, sql)
                .await
                .map(|r| r.rows_affected()),
            ImportConn::Pg(c) => sqlx::Executor::execute(&mut *c, sql)
                .await
                .map(|r| r.rows_affected()),
        }
    }

    async fn exec_in_transaction(&mut self, sql: &str) -> Result<u64, sqlx::Error> {
        self.exec("BEGIN").await?;
        match self.exec(sql).await {
            Ok(n) => {
                self.exec("COMMIT").await?;
                Ok(n)
            }
            Err(e) => {
                self.rollback().await;
                Err(e)
            }
        }
    }

    async fn rollback(&mut self) {
        let _ = self.exec("ROLLBACK").await;
    }

    async fn close(self) {
        let _ = match self {
            ImportConn::MySql(c) => sqlx::Connection::close(c).await,
            ImportConn::Pg(c) => sqlx::Connection::close(c).await,
        };
    }
}

// ─── Import helpers ───────────────────────────────────────────────

async fn run_truncate(
    pool: &DbPool,
    database: &str,
    schema: Option<&str>,
    table: &str,
) -> Result<(), String> {
    let sql = format!(
        "TRUNCATE TABLE {}",
        table_ref(pool, database, schema, table)
    );
    match pool {
        DbPool::MySQL(p) => {
            sqlx::query(&sql)
                .execute(p)
                .await
                .map_err(|e| format!("清空表失败: {e}"))?;
        }
        DbPool::Postgres(p) => {
            sqlx::query(&sql)
                .execute(p)
                .await
                .map_err(|e| format!("清空表失败: {e}"))?;
        }
    }
    Ok(())
}

fn table_ref(pool: &DbPool, database: &str, schema: Option<&str>, table: &str) -> String {
    match pool {
        DbPool::MySQL(_) => crate::utils::sql::qualified_mysql(database, table),
        DbPool::Postgres(_) => crate::utils::sql::qualified_pg(schema.unwrap_or("public"), table),
    }
}

/// Empties a table inside a transaction. MySQL's TRUNCATE commits implicitly,
/// so it has to be DELETE there; PostgreSQL's TRUNCATE is transactional.
fn clear_table_sql(mysql: bool, table_ref: &str) -> String {
    if mysql {
        format!("DELETE FROM {table_ref}")
    } else {
        format!("TRUNCATE TABLE {table_ref}")
    }
}

/// Parsed import file: (columns, rows of optional cell strings)
type ParsedTable = (Vec<String>, Vec<Vec<Option<String>>>);

fn parse_csv(file_path: &str, has_header: bool) -> Result<ParsedTable, String> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(has_header)
        .flexible(true)
        .from_path(file_path)
        .map_err(|e| format!("CSV 读取失败: {e}"))?;

    let col_names: Vec<String> = if has_header {
        rdr.headers()
            .map_err(|e| format!("读取标题失败: {e}"))?
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![]
    };

    let mut records: Vec<csv::StringRecord> = Vec::new();
    for res in rdr.records() {
        records.push(res.map_err(|e| format!("CSV 行解析失败: {e}"))?);
    }

    if records.is_empty() {
        return Ok((vec![], vec![]));
    }

    let cols = if col_names.is_empty() {
        (1..=records[0].len()).map(|i| format!("col{i}")).collect()
    } else {
        col_names
    };

    let rows = records
        .iter()
        .map(|r| {
            r.iter()
                .map(|s| {
                    if s.is_empty() {
                        None
                    } else {
                        Some(s.to_string())
                    }
                })
                .collect()
        })
        .collect();

    Ok((cols, rows))
}

// ─── Cross-connection transfer ────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMap {
    pub src: String,
    pub tgt: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResult {
    pub rows_transferred: u64,
    pub rows_failed: u64,
    pub error_message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    transfer_id: String,
    current: u64,
    total: u64,
    rows_per_sec: f64,
    eta_sec: f64,
}

/// Transfer rows from one connection/table to another.
///
/// - `column_mapping`: list of {src, tgt} pairs; empty = match by same name
/// - `truncate_first`: TRUNCATE the target table before inserting
/// - `where_clause`: filter on source (without WHERE keyword)
/// - `limit`: max rows to transfer; 0 = no limit
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_table_data(
    app: tauri::AppHandle,
    pools: State<'_, PoolManager>,
    registry: State<'_, TransferRegistry>,
    transfer_id: Option<String>,
    src_connection_id: String,
    src_database: String,
    src_schema: Option<String>,
    src_table: String,
    tgt_connection_id: String,
    tgt_database: String,
    tgt_schema: Option<String>,
    tgt_table: String,
    column_mapping: Vec<ColumnMap>,
    truncate_first: bool,
    where_clause: Option<String>,
    limit: u64,
) -> Result<TransferResult, String> {
    let transfer_id = transfer_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let control = registry.register(&transfer_id)?;
    let result = transfer_stream_impl(
        Some(&app),
        &pools,
        src_connection_id,
        src_database,
        src_schema,
        src_table,
        tgt_connection_id,
        tgt_database,
        tgt_schema,
        tgt_table,
        column_mapping,
        truncate_first,
        where_clause,
        limit,
        &transfer_id,
        &control,
    )
    .await;
    registry.finish(&transfer_id);
    result
}

#[allow(clippy::too_many_arguments)]
pub async fn transfer_table_data_impl(
    app: Option<&tauri::AppHandle>,
    pools: &PoolManager,
    src_connection_id: String,
    src_database: String,
    src_schema: Option<String>,
    src_table: String,
    tgt_connection_id: String,
    tgt_database: String,
    tgt_schema: Option<String>,
    tgt_table: String,
    column_mapping: Vec<ColumnMap>,
    truncate_first: bool,
    where_clause: Option<String>,
    limit: u64,
) -> Result<TransferResult, String> {
    transfer_stream_impl(
        app,
        pools,
        src_connection_id,
        src_database,
        src_schema,
        src_table,
        tgt_connection_id,
        tgt_database,
        tgt_schema,
        tgt_table,
        column_mapping,
        truncate_first,
        where_clause,
        limit,
        "test",
        &TransferControl::default(),
    )
    .await
}

#[derive(Default)]
pub(crate) struct TransferControl {
    pub(crate) cancelled: AtomicBool,
    pub(crate) notify: tokio::sync::Notify,
}
#[derive(Default)]
pub struct TransferRegistry(DashMap<String, Arc<TransferControl>>);

impl TransferRegistry {
    /// Claim `id` for a running task. A cancel that arrived before the task
    /// started has already created the entry; the task picks it up.
    pub(crate) fn register(&self, id: &str) -> Result<Arc<TransferControl>, String> {
        match self.0.entry(id.to_owned()) {
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                let control = Arc::new(TransferControl::default());
                entry.insert(control.clone());
                Ok(control)
            }
            dashmap::mapref::entry::Entry::Occupied(entry)
                if entry.get().cancelled.load(Ordering::Acquire) =>
            {
                Ok(entry.get().clone())
            }
            _ => Err("任务 ID 重复".into()),
        }
    }

    pub(crate) fn finish(&self, id: &str) {
        self.0.remove(id);
    }
}
#[tauri::command]
pub fn cancel_transfer(registry: State<'_, TransferRegistry>, transfer_id: String) {
    let control = registry
        .0
        .entry(transfer_id)
        .or_insert_with(|| Arc::new(TransferControl::default()));
    control.cancelled.store(true, Ordering::Release);
    control.notify.notify_one();
}

#[allow(clippy::too_many_arguments)]
async fn transfer_stream_impl(
    app: Option<&tauri::AppHandle>,
    pools: &PoolManager,
    src_connection_id: String,
    src_database: String,
    src_schema: Option<String>,
    src_table: String,
    tgt_connection_id: String,
    tgt_database: String,
    tgt_schema: Option<String>,
    tgt_table: String,
    column_mapping: Vec<ColumnMap>,
    truncate_first: bool,
    where_clause: Option<String>,
    limit: u64,
    transfer_id: &str,
    control: &TransferControl,
) -> Result<TransferResult, String> {
    pools.ensure_writable(&tgt_connection_id)?;
    if src_connection_id == tgt_connection_id
        && src_database == tgt_database
        && src_schema == tgt_schema
        && src_table == tgt_table
    {
        return Err("不能将表传输到自身".into());
    }
    let src_pool = resolve_pool(pools, &src_connection_id, &src_database).await?;
    let tgt_pool = resolve_pool(pools, &tgt_connection_id, &tgt_database).await?;
    let mysql_src = matches!(src_pool, DbPool::MySQL(_));
    let mysql_tgt = matches!(tgt_pool, DbPool::MySQL(_));
    let source = if mysql_src {
        crate::utils::sql::qualified_mysql(&src_database, &src_table)
    } else {
        format!(
            "{}.{}",
            crate::utils::sql::quote_ident_pg(src_schema.as_deref().unwrap_or("public")),
            crate::utils::sql::quote_ident_pg(&src_table)
        )
    };
    let target = if mysql_tgt {
        crate::utils::sql::qualified_mysql(&tgt_database, &tgt_table)
    } else {
        format!(
            "{}.{}",
            crate::utils::sql::quote_ident_pg(tgt_schema.as_deref().unwrap_or("public")),
            crate::utils::sql::quote_ident_pg(&tgt_table)
        )
    };
    let sql = build_select_sql(&source, "*", where_clause.as_deref(), limit);
    ensure_single_statement(&sql, mysql_src)?;
    let columns: Vec<String> = match &src_pool {
        DbPool::MySQL(p) => sqlx::Executor::describe(p, &sql)
            .await
            .map_err(|e| e.to_string())?
            .columns()
            .iter()
            .map(|c| c.name().to_owned())
            .collect(),
        DbPool::Postgres(p) => sqlx::Executor::describe(p, &sql)
            .await
            .map_err(|e| e.to_string())?
            .columns()
            .iter()
            .map(|c| c.name().to_owned())
            .collect(),
    };
    let mapping = if column_mapping.is_empty() {
        columns
            .iter()
            .map(|c| ColumnMap {
                src: c.clone(),
                tgt: c.clone(),
            })
            .collect()
    } else {
        column_mapping
    };
    let mut seen = std::collections::HashSet::new();
    let mut mapped = vec![];
    for item in mapping {
        let index = columns
            .iter()
            .position(|c| c == &item.src)
            .ok_or_else(|| format!("找不到源列 {}", item.src))?;
        if !seen.insert(item.tgt.clone()) {
            return Err(format!("目标列 {} 重复映射", item.tgt));
        }
        mapped.push((index, item.tgt));
    }
    if mapped.is_empty() {
        return Err("列映射为空".into());
    }
    let col_list = mapped
        .iter()
        .map(|(_, col)| {
            if mysql_tgt {
                crate::utils::sql::quote_ident_mysql(col)
            } else {
                crate::utils::sql::quote_ident_pg(col)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let prefix = format!("INSERT INTO {target} ({col_list}) VALUES ");
    if control.cancelled.load(Ordering::Acquire) {
        return Ok(TransferResult {
            rows_transferred: 0,
            rows_failed: 0,
            error_message: Some("已取消".into()),
        });
    }
    if truncate_first {
        run_truncate(&tgt_pool, &tgt_database, tgt_schema.as_deref(), &tgt_table).await?;
    }
    let mut stream: BoxStream<'_, Result<Vec<serde_json::Value>, String>> = match &src_pool {
        DbPool::MySQL(p) => sqlx::raw_sql(&sql)
            .fetch(p)
            .map(|r| {
                r.map_err(|e| e.to_string())
                    .and_then(|row| row_values(&row, mysql_val))
            })
            .boxed(),
        DbPool::Postgres(p) => sqlx::raw_sql(&sql)
            .fetch(p)
            .map(|r| {
                r.map_err(|e| e.to_string())
                    .and_then(|row| row_values(&row, pg_val))
            })
            .boxed(),
    };
    let start = Instant::now();
    let mut rows_transferred = 0;
    let mut rows_failed = 0;
    let mut error_message = None;
    let mut batch: Vec<String> = vec![];
    let mut bytes = 0;
    loop {
        if control.cancelled.load(Ordering::Acquire) {
            error_message = Some("已取消；已提交批次保留，未提交批次已丢弃".into());
            break;
        }
        let item = tokio::select! {
            _ = control.notify.notified() => { error_message = Some("已取消；已提交批次保留，未提交批次已丢弃".into()); break; }
            item = stream.next() => item,
        };
        let done = item.is_none();
        match item {
            Some(Ok(row)) => {
                let values = mapped
                    .iter()
                    .map(|(i, _)| sql_val(&row[*i], mysql_tgt))
                    .collect::<Vec<_>>()
                    .join(", ");
                bytes += values.len();
                batch.push(format!("({values})"));
            }
            Some(Err(error)) => {
                error_message = Some(format!("读取中断：{error}；已提交批次保留"));
                break;
            }
            None => {}
        }
        if !batch.is_empty() && (done || batch.len() >= 500 || bytes >= 512 * 1024) {
            match insert_transfer_batch(&tgt_pool, &format!("{prefix}{}", batch.join(","))).await {
                Ok(n) => rows_transferred += n,
                Err(error) => {
                    rows_failed = batch.len() as u64;
                    error_message = Some(format!(
                        "批次失败，已停止：{error}；之前已提交 {rows_transferred} 行"
                    ));
                    break;
                }
            }
            batch.clear();
            bytes = 0;
            if let Some(app) = app {
                let _ = app.emit(
                    "transfer-progress",
                    TransferProgress {
                        transfer_id: transfer_id.to_owned(),
                        current: rows_transferred,
                        total: 0,
                        rows_per_sec: rows_transferred as f64
                            / start.elapsed().as_secs_f64().max(0.001),
                        eta_sec: 0.0,
                    },
                );
            }
        }
        if done {
            break;
        }
    }
    Ok(TransferResult {
        rows_transferred,
        rows_failed,
        error_message,
    })
}

/// A failed statement is rolled back before retry. Only deadlocks and
/// serialization failures are retried; connection/commit errors are ambiguous.
async fn insert_transfer_batch(pool: &DbPool, sql: &str) -> Result<u64, String> {
    for attempt in 0..3 {
        let result: Result<u64, sqlx::Error> = match pool {
            DbPool::MySQL(p) => {
                let mut tx = p.begin().await.map_err(|e| e.to_string())?;
                match sqlx::query(sql).execute(&mut *tx).await {
                    Ok(done) => {
                        tx.commit().await.map_err(|e| e.to_string())?;
                        return Ok(done.rows_affected());
                    }
                    Err(e) => {
                        tx.rollback()
                            .await
                            .map_err(|rollback| rollback.to_string())?;
                        Err(e)
                    }
                }
            }
            DbPool::Postgres(p) => {
                let mut tx = p.begin().await.map_err(|e| e.to_string())?;
                match sqlx::query(sql).execute(&mut *tx).await {
                    Ok(done) => {
                        tx.commit().await.map_err(|e| e.to_string())?;
                        return Ok(done.rows_affected());
                    }
                    Err(e) => {
                        tx.rollback()
                            .await
                            .map_err(|rollback| rollback.to_string())?;
                        Err(e)
                    }
                }
            }
        };
        if let Err(error) = result {
            let retryable = error
                .as_database_error()
                .and_then(|e| e.code())
                .is_some_and(|c| matches!(c.as_ref(), "40001" | "40P01" | "1213"));
            if !retryable || attempt == 2 {
                return Err(error.to_string());
            }
            tokio::time::sleep(std::time::Duration::from_millis(50 * (attempt + 1))).await;
        }
    }
    unreachable!()
}

fn parse_json(file_path: &str) -> Result<ParsedTable, String> {
    let content = std::fs::read_to_string(file_path).map_err(|e| format!("读取文件失败: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("JSON 解析失败: {e}"))?;
    let arr = value
        .as_array()
        .ok_or_else(|| "JSON 文件必须是对象数组".to_string())?;

    if arr.is_empty() {
        return Ok((vec![], vec![]));
    }

    let cols: Vec<String> = arr[0]
        .as_object()
        .ok_or_else(|| "JSON 元素必须是对象".to_string())?
        .keys()
        .cloned()
        .collect();

    let rows = arr
        .iter()
        .map(|obj| {
            let map = obj.as_object();
            cols.iter()
                .map(|k| {
                    map.and_then(|m| m.get(k))
                        .map(|v| match v {
                            serde_json::Value::Null => None,
                            serde_json::Value::String(s) => Some(s.clone()),
                            other => Some(other.to_string()),
                        })
                        .unwrap_or(None)
                })
                .collect()
        })
        .collect();

    Ok((cols, rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_val_escapes_strings() {
        assert_eq!(sql_val(&serde_json::json!("plain"), false), "'plain'");
        assert_eq!(sql_val(&serde_json::json!("it's"), false), "'it''s'");
        assert_eq!(sql_val(&serde_json::json!("a\\b"), false), "E'a\\\\b'");
        assert_eq!(sql_val(&serde_json::json!(true), false), "TRUE");
        let binary = serde_json::json!({"$lotdbBinary": "00ff"});
        assert_eq!(sql_val(&binary, false), "decode('00ff', 'hex')");
        assert_eq!(sql_val(&binary, true), "X'00ff'");
        assert_eq!(
            import_literal(Some("\\x00ff"), true, false, true),
            "X'00ff'"
        );
        assert_eq!(
            import_literal(Some("\\x00ff"), false, false, false),
            "E'\\\\x00ff'"
        );
    }

    #[test]
    fn csv_cell_quotes_and_doubles() {
        assert_eq!(csv_cell(&serde_json::json!(1.5)), "1.5");
        assert_eq!(csv_cell(&serde_json::Value::Null), "");
        assert_eq!(
            csv_cell(&serde_json::json!("say \"hi\"")),
            "\"say \"\"hi\"\"\""
        );
        assert_eq!(csv_cell(&serde_json::json!(true)), "true");
    }

    #[test]
    fn build_select_sql_composes_parts() {
        assert_eq!(
            build_select_sql("`db`.`t`", "*", Some("a = 1"), 10),
            "SELECT * FROM `db`.`t` WHERE a = 1 LIMIT 10"
        );
        assert_eq!(
            build_select_sql("`db`.`t`", "a, b", Some("   "), 0),
            "SELECT a, b FROM `db`.`t`"
        );
    }

    #[test]
    fn ext_for_format_maps() {
        assert_eq!(ext_for_format("csv"), "csv");
        assert_eq!(ext_for_format("excel"), "xlsx");
        assert_eq!(ext_for_format("sql_insert"), "sql");
        assert_eq!(ext_for_format("unknown"), "csv");
    }
}

/// Exports only the already-loaded query result; never silently overwrites a file.
#[tauri::command]
pub async fn export_query_result(
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    file_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)
            .map_err(|e| e.to_string())?;
        let mut writer = csv::Writer::from_writer(file);
        writer.write_record(&columns).map_err(|e| e.to_string())?;
        for row in rows {
            writer
                .write_record(row.iter().map(|value| match value {
                    serde_json::Value::Null => String::new(),
                    serde_json::Value::String(s) => s.clone(),
                    value => value.to_string(),
                }))
                .map_err(|e| e.to_string())?;
        }
        writer.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

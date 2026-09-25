use crate::db::pool::{DbPool, PoolManager};
use futures::StreamExt;
use rust_xlsxwriter::{Color, Format, Workbook};
use serde::{Deserialize, Serialize};
use sqlx::{Column, Row};
use std::fs::File;
use std::io::{BufWriter, Write};
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

fn write_csv(
    writer: &mut BufWriter<File>,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> std::io::Result<()> {
    // Header
    let header = columns.join(",");
    writeln!(writer, "{header}")?;
    // Rows
    for row in rows {
        let cells: Vec<String> = row.iter().map(csv_cell).collect();
        writeln!(writer, "{}", cells.join(","))?;
    }
    Ok(())
}

fn write_json(
    writer: &mut BufWriter<File>,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> std::io::Result<()> {
    let objects: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            let mut map = serde_json::Map::new();
            for (col, val) in columns.iter().zip(row.iter()) {
                map.insert(col.clone(), val.clone());
            }
            serde_json::Value::Object(map)
        })
        .collect();
    let json = serde_json::to_string_pretty(&serde_json::Value::Array(objects))
        .map_err(std::io::Error::other)?;
    write!(writer, "{json}")?;
    Ok(())
}

fn write_sql_insert(
    writer: &mut BufWriter<File>,
    table_ref: &str,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
    db_quote: fn(&str) -> String,
    mysql: bool,
) -> std::io::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let col_list = columns
        .iter()
        .map(|c| db_quote(c))
        .collect::<Vec<_>>()
        .join(", ");
    writeln!(writer, "-- Generated by LotDB")?;
    for row in rows {
        let vals = row
            .iter()
            .map(|v| sql_val(v, mysql))
            .collect::<Vec<_>>()
            .join(", ");
        writeln!(
            writer,
            "INSERT INTO {table_ref} ({col_list}) VALUES ({vals});"
        )?;
    }
    Ok(())
}

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
    let pool = resolve_pool(&pools, &connection_id, &database).await?;

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
            let tr = crate::utils::sql::qualified_mysql(database.as_ref(), table.as_ref());
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
                    let mut stream = sqlx::query(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        let vals: Vec<serde_json::Value> = (0..row.columns().len())
                            .map(|i| mysql_val(&row, i))
                            .collect();
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
                    let mut stream = sqlx::query(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        let vals: Vec<serde_json::Value> =
                            (0..row.columns().len()).map(|i| pg_val(&row, i)).collect();
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
                    let mut stream = sqlx::query(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        let vals: Vec<serde_json::Value> = (0..row.columns().len())
                            .map(|i| mysql_val(&row, i))
                            .collect();
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
                    let mut stream = sqlx::query(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        let vals: Vec<serde_json::Value> =
                            (0..row.columns().len()).map(|i| pg_val(&row, i)).collect();
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
                    let mut stream = sqlx::query(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                            writeln!(writer, "{}", col_names.join(","))
                                .map_err(|e| format!("写入失败: {e}"))?;
                        }
                        let vals: Vec<String> = (0..row.columns().len())
                            .map(|i| csv_cell(&mysql_val(&row, i)))
                            .collect();
                        writeln!(writer, "{}", vals.join(","))
                            .map_err(|e| format!("写入失败: {e}"))?;
                        rows_exported += 1;
                        emit_export_progress!();
                    }
                }
                DbPool::Postgres(pool) => {
                    let mut stream = sqlx::query(&sql).fetch(pool);
                    while let Some(row) = stream.next().await {
                        let row = row.map_err(|e| format!("查询失败: {e}"))?;
                        if col_names.is_empty() {
                            col_names =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                            writeln!(writer, "{}", col_names.join(","))
                                .map_err(|e| format!("写入失败: {e}"))?;
                        }
                        let vals: Vec<String> = (0..row.columns().len())
                            .map(|i| csv_cell(&pg_val(&row, i)))
                            .collect();
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
            let tr = crate::utils::sql::qualified_mysql(database.as_ref(), table.as_ref());
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
            (tr, cs)
        }
    };
    let sql = build_select_sql(&q_table, &col_select, where_clause, limit);

    match pool {
        DbPool::MySQL(p) => {
            let db_rows = sqlx::query(&sql)
                .fetch_all(p)
                .await
                .map_err(|e| format!("查询失败: {e}"))?;
            let col_names = db_rows
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let rows = db_rows
                .iter()
                .map(|r| (0..r.columns().len()).map(|i| mysql_val(r, i)).collect())
                .collect();
            Ok((col_names, rows))
        }
        DbPool::Postgres(p) => {
            let db_rows = sqlx::query(&sql)
                .fetch_all(p)
                .await
                .map_err(|e| format!("查询失败: {e}"))?;
            let col_names = db_rows
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let rows = db_rows
                .iter()
                .map(|r| (0..r.columns().len()).map(|i| pg_val(r, i)).collect())
                .collect();
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
    // Route PG queries to the selected database (not the connection default).
    let pool = resolve_pool(&pools, &connection_id, &database).await?;

    let ext = ext_for_format(&format);
    let limit_part = if limit > 0 {
        format!(" LIMIT {limit}")
    } else {
        String::new()
    };

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

        let file_name = format!("{table}.{ext}");
        let file_path = format!("{output_dir}/{file_name}");

        let fetch_result = match &pool {
            DbPool::MySQL(pool) => {
                let q_table = crate::utils::sql::qualified_mysql(database.as_ref(), table.as_ref());
                let sql = format!("SELECT * FROM {q_table}{limit_part}");
                sqlx::query(&sql)
                    .fetch_all(pool)
                    .await
                    .map(|rows| {
                        let col_names: Vec<String> = rows
                            .first()
                            .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                            .unwrap_or_default();
                        let data: Vec<Vec<serde_json::Value>> = rows
                            .iter()
                            .map(|r| (0..r.columns().len()).map(|i| mysql_val(r, i)).collect())
                            .collect();
                        (col_names, data)
                    })
                    .map_err(|e| format!("查询 {table} 失败: {e}"))
            }
            DbPool::Postgres(pool) => {
                let schema_name = schema.as_deref().unwrap_or("public");
                let q_table = crate::utils::sql::qualified_pg(schema_name, &table);
                let sql = format!("SELECT * FROM {q_table}{limit_part}");
                sqlx::query(&sql)
                    .fetch_all(pool)
                    .await
                    .map(|rows| {
                        let col_names: Vec<String> = rows
                            .first()
                            .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                            .unwrap_or_default();
                        let data: Vec<Vec<serde_json::Value>> = rows
                            .iter()
                            .map(|r| (0..r.columns().len()).map(|i| pg_val(r, i)).collect())
                            .collect();
                        (col_names, data)
                    })
                    .map_err(|e| format!("查询 {table} 失败: {e}"))
            }
        };

        let (col_names, rows) = match fetch_result {
            Ok(v) => v,
            Err(e) => {
                results.push(TableExportStatus {
                    table: table.clone(),
                    rows_exported: 0,
                    file_path,
                    error: Some(e),
                });
                continue;
            }
        };

        let rows_exported = rows.len() as u64;

        let write_result = if format == "excel" {
            write_excel(&file_path, &col_names, &rows)
        } else {
            (|| -> Result<(), String> {
                let file = File::create(&file_path).map_err(|e| format!("创建文件失败: {e}"))?;
                let mut writer = BufWriter::new(file);
                match format.as_str() {
                    "json" => write_json(&mut writer, &col_names, &rows)
                        .map_err(|e| format!("写入 JSON 失败: {e}"))?,
                    "sql_insert" => {
                        let (table_ref, db_quote): (String, fn(&str) -> String) = match &pool {
                            DbPool::MySQL(_) => (
                                crate::utils::sql::qualified_mysql(
                                    database.as_ref(),
                                    table.as_ref(),
                                ),
                                |c| crate::utils::sql::quote_ident_mysql(c),
                            ),
                            DbPool::Postgres(_) => {
                                let s = schema.as_deref().unwrap_or("public");
                                (crate::utils::sql::qualified_pg(s, &table), |c| {
                                    crate::utils::sql::quote_ident_pg(c)
                                })
                            }
                        };
                        write_sql_insert(
                            &mut writer,
                            &table_ref,
                            &col_names,
                            &rows,
                            db_quote,
                            matches!(&pool, DbPool::MySQL(_)),
                        )
                        .map_err(|e| format!("写入 SQL 失败: {e}"))?;
                    }
                    _ => write_csv(&mut writer, &col_names, &rows)
                        .map_err(|e| format!("写入 CSV 失败: {e}"))?,
                }
                writer.flush().map_err(|e| format!("刷新失败: {e}"))?;
                Ok(())
            })()
        };

        results.push(TableExportStatus {
            table: table.clone(),
            rows_exported,
            file_path,
            error: write_result.err(),
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
    import_table_data_impl(
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
    )
    .await
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
    pools.ensure_writable(&connection_id)?;
    // Route PG queries to the selected database (not the connection default).
    let pool = resolve_pool(&pools, &connection_id, &database).await?;

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

        return Ok(ImportResult {
            rows_imported,
            rows_failed,
            error_message: first_error.map(|e| format!("{rows_failed} 条语句失败: {e}")),
        });
    }

    let column_kinds = import_column_kinds(&pool, &database, schema.as_deref(), &table).await?;
    let mysql = matches!(&pool, DbPool::MySQL(_));

    if format == "json" {
        // JSON arrays aren't easily streamable; parse into memory then insert row by row
        let (col_names, str_rows) = parse_json(&file_path)?;
        if col_names.is_empty() || str_rows.is_empty() {
            return Ok(ImportResult {
                rows_imported: 0,
                rows_failed: 0,
                error_message: None,
            });
        }
        if truncate_first {
            run_truncate(&pool, &database, schema.as_deref(), &table).await?;
        }
        let effective_mapping: Vec<Option<String>> = if column_mapping.is_empty() {
            col_names.iter().map(|n| Some(n.clone())).collect()
        } else {
            column_mapping
        };
        let mapped_indices: Vec<(usize, String)> = effective_mapping
            .iter()
            .enumerate()
            .filter_map(|(i, opt)| opt.as_ref().map(|name| (i, name.clone())))
            .collect();
        if mapped_indices.is_empty() {
            return Err("至少需要映射一列".to_string());
        }
        let schema_name = schema.as_deref().unwrap_or("public");
        let (table_ref, col_quote): (String, fn(&str) -> String) = match &pool {
            DbPool::MySQL(_) => (
                crate::utils::sql::qualified_mysql(database.as_ref(), table.as_ref()),
                |c| crate::utils::sql::quote_ident_mysql(c),
            ),
            DbPool::Postgres(_) => (crate::utils::sql::qualified_pg(schema_name, &table), |c| {
                crate::utils::sql::quote_ident_pg(c)
            }),
        };
        let col_list = mapped_indices
            .iter()
            .map(|(_, t)| col_quote(t))
            .collect::<Vec<_>>()
            .join(", ");
        let total = str_rows.len() as u64;
        let mut rows_imported = 0u64;
        let mut rows_failed = 0u64;
        let mut first_error: Option<String> = None;
        let start = Instant::now();
        for (idx, row) in str_rows.iter().enumerate() {
            let val_list = mapped_indices
                .iter()
                .map(|(src_idx, target)| {
                    import_literal(
                        row.get(*src_idx).and_then(|o| o.as_deref()),
                        column_kinds.binary.contains(target),
                        column_kinds.boolean.contains(target),
                        mysql,
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let insert_sql = format!("INSERT INTO {table_ref} ({col_list}) VALUES ({val_list})");
            let res = match &pool {
                DbPool::MySQL(p) => sqlx::query(&insert_sql)
                    .execute(p)
                    .await
                    .map(|r| r.rows_affected()),
                DbPool::Postgres(p) => sqlx::query(&insert_sql)
                    .execute(p)
                    .await
                    .map(|r| r.rows_affected()),
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
            if current.is_multiple_of(100) || current == total {
                let elapsed = start.elapsed().as_secs_f64().max(0.001);
                let rps = current as f64 / elapsed;
                let eta = if rps > 0.0 && current < total {
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
        return Ok(ImportResult {
            rows_imported,
            rows_failed,
            error_message: first_error.map(|e| format!("{rows_failed} 行失败: {e}")),
        });
    }

    if format != "csv" {
        return Err(format!("不支持的格式: {format}"));
    }

    // ── CSV streaming import ────────────────────────────────────────
    // First pass: count rows for progress display (cheap sequential scan)
    let total_rows: u64 = {
        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(has_header)
            .flexible(true)
            .from_path(&file_path)
            .map_err(|e| format!("CSV 读取失败: {e}"))?;
        rdr.records().count() as u64
    };

    // Second pass: read headers + stream rows
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(has_header)
        .flexible(true)
        .from_path(&file_path)
        .map_err(|e| format!("CSV 读取失败: {e}"))?;

    let col_names: Vec<String> = if has_header {
        rdr.headers()
            .map_err(|e| format!("读取标题失败: {e}"))?
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        // Peek at first record to determine column count
        let first = rdr
            .records()
            .next()
            .transpose()
            .map_err(|e| format!("CSV 行解析失败: {e}"))?;
        match first {
            None => {
                return Ok(ImportResult {
                    rows_imported: 0,
                    rows_failed: 0,
                    error_message: None,
                })
            }
            Some(r) => (1..=r.len()).map(|i| format!("col{i}")).collect(),
        }
    };

    if truncate_first {
        run_truncate(&pool, &database, schema.as_deref(), &table).await?;
    }

    // Resolve mapping
    let effective_mapping: Vec<Option<String>> = if column_mapping.is_empty() {
        col_names.iter().map(|n| Some(n.clone())).collect()
    } else {
        column_mapping
    };
    let mapped_indices: Vec<(usize, String)> = effective_mapping
        .iter()
        .enumerate()
        .filter_map(|(i, opt)| opt.as_ref().map(|name| (i, name.clone())))
        .collect();
    if mapped_indices.is_empty() {
        return Err("至少需要映射一列".to_string());
    }

    let schema_name = schema.as_deref().unwrap_or("public");
    let (table_ref, col_quote): (String, fn(&str) -> String) = match &pool {
        DbPool::MySQL(_) => (
            crate::utils::sql::qualified_mysql(database.as_ref(), table.as_ref()),
            |c| crate::utils::sql::quote_ident_mysql(c),
        ),
        DbPool::Postgres(_) => (crate::utils::sql::qualified_pg(schema_name, &table), |c| {
            crate::utils::sql::quote_ident_pg(c)
        }),
    };
    let col_list = mapped_indices
        .iter()
        .map(|(_, t)| col_quote(t))
        .collect::<Vec<_>>()
        .join(", ");

    let mut rows_imported: u64 = 0;
    let mut rows_failed: u64 = 0;
    let mut first_error: Option<String> = None;
    let start = Instant::now();

    // Re-open for streaming (can't reuse rdr after calling headers() and iterating above)
    let mut rdr2 = csv::ReaderBuilder::new()
        .has_headers(has_header)
        .flexible(true)
        .from_path(&file_path)
        .map_err(|e| format!("CSV 读取失败: {e}"))?;

    for (idx, record) in rdr2.records().enumerate() {
        let record = match record {
            Ok(r) => r,
            Err(e) => {
                rows_failed += 1;
                if first_error.is_none() {
                    first_error = Some(e.to_string());
                }
                continue;
            }
        };

        let row: Vec<Option<String>> = record
            .iter()
            .map(|s| {
                if s.is_empty() {
                    None
                } else {
                    Some(s.to_string())
                }
            })
            .collect();

        let val_list = mapped_indices
            .iter()
            .map(|(src_idx, target)| {
                import_literal(
                    row.get(*src_idx).and_then(|o| o.as_deref()),
                    column_kinds.binary.contains(target),
                    column_kinds.boolean.contains(target),
                    mysql,
                )
            })
            .collect::<Vec<_>>()
            .join(", ");

        let insert_sql = format!("INSERT INTO {table_ref} ({col_list}) VALUES ({val_list})");
        let res = match &pool {
            DbPool::MySQL(p) => sqlx::query(&insert_sql)
                .execute(p)
                .await
                .map(|r| r.rows_affected()),
            DbPool::Postgres(p) => sqlx::query(&insert_sql)
                .execute(p)
                .await
                .map(|r| r.rows_affected()),
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
        if current.is_multiple_of(100) || current == total_rows {
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            let rps = current as f64 / elapsed;
            let eta = if rps > 0.0 && current < total_rows {
                (total_rows - current) as f64 / rps
            } else {
                0.0
            };
            if let Some(app) = app {
                app.emit(
                    "import-progress",
                    ImportProgress {
                        current,
                        total: total_rows,
                        rows_per_sec: rps,
                        eta_sec: eta,
                    },
                )
                .ok();
            }
        }
    }

    Ok(ImportResult {
        rows_imported,
        rows_failed,
        error_message: first_error.map(|e| format!("{rows_failed} 行失败: {e}")),
    })
}

// ─── Import helpers ───────────────────────────────────────────────

async fn run_truncate(
    pool: &DbPool,
    database: &str,
    schema: Option<&str>,
    table: &str,
) -> Result<(), String> {
    let sql = match pool {
        DbPool::MySQL(_) => format!("TRUNCATE TABLE `{database}`.`{table}`"),
        DbPool::Postgres(_) => {
            let s = schema.unwrap_or("public");
            format!("TRUNCATE TABLE \"{s}\".\"{table}\"")
        }
    };
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
    transfer_table_data_impl(
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
    )
    .await
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
    pools.ensure_writable(&tgt_connection_id)?;
    // Route PG queries to the selected databases (not the connection defaults).
    let src_pool = resolve_pool(&pools, &src_connection_id, &src_database).await?;
    let tgt_pool = resolve_pool(&pools, &tgt_connection_id, &tgt_database).await?;

    // ── 1. Read all source rows into memory (batch) ────────────────
    let (src_col_names, src_rows) = fetch_all_as_json(
        &src_pool,
        &src_database,
        src_schema.as_deref(),
        &src_table,
        &[],
        where_clause.as_deref(),
        limit,
    )
    .await?;

    if src_rows.is_empty() {
        return Ok(TransferResult {
            rows_transferred: 0,
            rows_failed: 0,
            error_message: None,
        });
    }

    // ── 2. Resolve column mapping ──────────────────────────────────
    // pairs of (src_idx, tgt_col_name)
    let mapped: Vec<(usize, String)> = if column_mapping.is_empty() {
        src_col_names
            .iter()
            .enumerate()
            .map(|(i, name)| (i, name.clone()))
            .collect()
    } else {
        column_mapping
            .iter()
            .filter_map(|cm| {
                src_col_names
                    .iter()
                    .position(|n| n == &cm.src)
                    .map(|idx| (idx, cm.tgt.clone()))
            })
            .collect()
    };

    if mapped.is_empty() {
        return Err("列映射为空，无法传输".to_string());
    }

    // ── 3. Truncate target if requested ───────────────────────────
    if truncate_first {
        run_truncate(&tgt_pool, &tgt_database, tgt_schema.as_deref(), &tgt_table).await?;
    }

    // ── 4. Build target table ref + quoting ───────────────────────
    let (tgt_table_ref, tgt_col_quote): (String, fn(&str) -> String) = match &tgt_pool {
        DbPool::MySQL(_) => (
            crate::utils::sql::qualified_mysql(&tgt_database, &tgt_table),
            |c| crate::utils::sql::quote_ident_mysql(c),
        ),
        DbPool::Postgres(_) => {
            let s = tgt_schema.as_deref().unwrap_or("public");
            (crate::utils::sql::qualified_pg(s, &tgt_table), |c| {
                crate::utils::sql::quote_ident_pg(c)
            })
        }
    };

    let col_list = mapped
        .iter()
        .map(|(_, t)| tgt_col_quote(t))
        .collect::<Vec<_>>()
        .join(", ");

    // ── 5. Insert rows into target ─────────────────────────────────
    let total = src_rows.len() as u64;
    let mut rows_transferred: u64 = 0;
    let mut rows_failed: u64 = 0;
    let mut first_error: Option<String> = None;
    let start = Instant::now();

    for (idx, row) in src_rows.iter().enumerate() {
        let val_list = mapped
            .iter()
            .map(|(src_idx, _)| {
                sql_val(
                    row.get(*src_idx).unwrap_or(&serde_json::Value::Null),
                    matches!(&tgt_pool, DbPool::MySQL(_)),
                )
            })
            .collect::<Vec<_>>()
            .join(", ");

        let insert_sql = format!("INSERT INTO {tgt_table_ref} ({col_list}) VALUES ({val_list})");
        let res = match &tgt_pool {
            DbPool::MySQL(p) => sqlx::query(&insert_sql)
                .execute(p)
                .await
                .map(|r| r.rows_affected()),
            DbPool::Postgres(p) => sqlx::query(&insert_sql)
                .execute(p)
                .await
                .map(|r| r.rows_affected()),
        };
        match res {
            Ok(n) => rows_transferred += n,
            Err(e) => {
                rows_failed += 1;
                if first_error.is_none() {
                    first_error = Some(e.to_string());
                }
            }
        }

        let current = (idx + 1) as u64;
        if current.is_multiple_of(100) || current == total {
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            let rps = current as f64 / elapsed;
            let eta = if rps > 0.0 && current < total {
                (total - current) as f64 / rps
            } else {
                0.0
            };
            if let Some(app) = app {
                app.emit(
                    "transfer-progress",
                    TransferProgress {
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

    Ok(TransferResult {
        rows_transferred,
        rows_failed,
        error_message: first_error.map(|e| format!("{rows_failed} 行失败: {e}")),
    })
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
pub async fn export_query_result(columns: Vec<String>, rows: Vec<Vec<serde_json::Value>>, file_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&file_path).map_err(|e| e.to_string())?;
        let mut writer = csv::Writer::from_writer(file);
        writer.write_record(&columns).map_err(|e| e.to_string())?;
        for row in rows {
            writer.write_record(row.iter().map(|value| match value {
                serde_json::Value::Null => String::new(),
                serde_json::Value::String(s) => s.clone(),
                value => value.to_string(),
            })).map_err(|e| e.to_string())?;
        }
        writer.flush().map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

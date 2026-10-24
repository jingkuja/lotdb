use crate::db::dialect::Dialect;
use crate::db::pool::{DbPool, PoolManager};
use crate::error::{AppError, ResultExt};
use dashmap::DashMap;
use futures::{stream::BoxStream, StreamExt};
use rust_xlsxwriter::{Color, Format, Workbook, Worksheet};
use serde::{Deserialize, Serialize};
use sqlx::Row;
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

/// One CSV field. Strings are always quoted, so an empty string (`""`) stays
/// distinct from NULL (an empty field); numbers and booleans are bare.
fn csv_cell(v: &serde_json::Value) -> String {
    let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => quote(s),
        other => quote(&other.to_string()),
    }
}

/// One CSV record (RFC 4180), the only CSV writer: table export, batch
/// export and query-result export all go through it.
fn csv_line<'a>(values: impl IntoIterator<Item = &'a serde_json::Value>) -> String {
    values
        .into_iter()
        .map(csv_cell)
        .collect::<Vec<_>>()
        .join(",")
}

/// Format a JSON value for SQL INSERT: NULL, numbers raw, everything else quoted.
fn sql_val(v: &serde_json::Value, dialect: Dialect) -> String {
    if let Some(hex) = v.get("$lotdbBinary").and_then(|v| v.as_str()) {
        // Type tags only come from our row converter, or validated imports.
        if hex.len() % 2 == 0 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return dialect.binary_literal(hex);
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
        serde_json::Value::String(s) => dialect.string_literal(s),
        other => dialect.string_literal(&other.to_string()),
    }
}

fn import_literal(value: Option<&str>, binary: bool, boolean: bool, dialect: Dialect) -> String {
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
            return sql_val(&serde_json::json!({"$lotdbBinary": hex}), dialect);
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(s) {
            if v.get("$lotdbBinary").is_some() {
                return sql_val(&v, dialect);
            }
        }
    }
    dialect.string_literal(s)
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
) -> Result<ImportColumnKinds, AppError> {
    let columns: Vec<(String, String)> = match pool {
        DbPool::MySQL(p) => sqlx::query_as("SELECT COLUMN_NAME, CAST(COLUMN_TYPE AS CHAR) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")
            .bind(database).bind(table).fetch_all(p).await,
        DbPool::Postgres(p) => sqlx::query_as("SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2")
            .bind(schema.unwrap_or("public")).bind(table).fetch_all(p).await,
    }.ctx("获取导入列类型失败")?;
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
fn ensure_single_statement(sql: &str, dialect: Dialect) -> Result<(), AppError> {
    if crate::utils::sql::split_sql(sql, dialect.is_mysql())?.len() != 1 {
        return Err("筛选条件只能是单个 WHERE 表达式，不能包含多条语句".into());
    }
    Ok(())
}

fn row_values<R: Row>(
    row: &R,
    convert: impl Fn(&R, usize) -> Result<serde_json::Value, String>,
) -> Result<Vec<serde_json::Value>, AppError> {
    (0..row.columns().len())
        .map(|i| convert(row, i).map_err(AppError::sql))
        .collect()
}

/// Rows of `sql` over the text protocol, as export values. The one place
/// export and transfer read rows, whatever the database.
fn text_rows<'a>(
    pool: &'a DbPool,
    sql: &'a str,
) -> BoxStream<'a, Result<Vec<serde_json::Value>, AppError>> {
    match pool {
        DbPool::MySQL(p) => sqlx::raw_sql(sql)
            .fetch(p)
            .map(|r| {
                r.ctx("查询失败")
                    .and_then(|row| row_values(&row, mysql_val))
            })
            .boxed(),
        DbPool::Postgres(p) => sqlx::raw_sql(sql)
            .fetch(p)
            .map(|r| r.ctx("查询失败").and_then(|row| row_values(&row, pg_val)))
            .boxed(),
    }
}

// ─── File writers ─────────────────────────────────────────────────

/// One export file. Rows are written as they arrive; only Excel keeps them
/// in memory (rust_xlsxwriter assembles the workbook before saving).
enum ExportWriter {
    Csv(BufWriter<File>),
    Json {
        out: BufWriter<File>,
        columns: Vec<String>,
        first: bool,
    },
    SqlInsert {
        out: BufWriter<File>,
        prefix: String,
        dialect: Dialect,
    },
    Excel {
        path: String,
        sheet: Box<Worksheet>,
        row: u32,
    },
}

impl ExportWriter {
    /// `format`: "csv" (default) | "json" | "sql_insert" | "excel".
    fn new(
        format: &str,
        file: File,
        path: &str,
        columns: &[String],
        dialect: Dialect,
        table_ref: &str,
    ) -> Result<Self, AppError> {
        let mut out = BufWriter::new(file);
        Ok(match format {
            "json" => {
                write!(out, "[").ctx("写入失败")?;
                ExportWriter::Json {
                    out,
                    columns: columns.to_vec(),
                    first: true,
                }
            }
            "sql_insert" => {
                writeln!(out, "-- Generated by LotDB").ctx("写入失败")?;
                let col_list = columns
                    .iter()
                    .map(|c| dialect.quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ");
                ExportWriter::SqlInsert {
                    out,
                    prefix: format!("INSERT INTO {table_ref} ({col_list}) VALUES ("),
                    dialect,
                }
            }
            "excel" => {
                drop(out);
                let mut sheet = Worksheet::new();
                // Header style: bold + light blue background
                let header = Format::new()
                    .set_bold()
                    .set_background_color(Color::RGB(0xD9E1F2))
                    .set_border(rust_xlsxwriter::FormatBorder::Thin);
                for (i, name) in columns.iter().enumerate() {
                    sheet
                        .write_string_with_format(0, i as u16, name, &header)
                        .ctx("写入标题失败")?;
                    // Estimate: header length, within 12–40.
                    let width = (name.len() as f64 + 2.0).clamp(12.0, 40.0);
                    sheet
                        .set_column_width(i as u16, width)
                        .ctx("设置列宽失败")?;
                }
                sheet.set_freeze_panes(1, 0).ctx("冻结行失败")?;
                ExportWriter::Excel {
                    path: path.to_owned(),
                    sheet: Box::new(sheet),
                    row: 0,
                }
            }
            _ => {
                let header = columns.iter().map(|c| serde_json::Value::String(c.clone()));
                writeln!(out, "{}", csv_line(&header.collect::<Vec<_>>())).ctx("写入失败")?;
                ExportWriter::Csv(out)
            }
        })
    }

    fn write_row(&mut self, values: &[serde_json::Value]) -> Result<(), AppError> {
        match self {
            ExportWriter::Csv(out) => writeln!(out, "{}", csv_line(values)).ctx("写入失败"),
            ExportWriter::Json {
                out,
                columns,
                first,
            } => {
                let obj: serde_json::Map<String, serde_json::Value> = columns
                    .iter()
                    .cloned()
                    .zip(values.iter().cloned())
                    .collect();
                let s = serde_json::to_string(&obj).ctx("序列化失败")?;
                let sep = if std::mem::take(first) { "" } else { "," };
                write!(out, "{sep}\n  {s}").ctx("写入失败")
            }
            ExportWriter::SqlInsert {
                out,
                prefix,
                dialect,
            } => {
                let vals = values
                    .iter()
                    .map(|v| sql_val(v, *dialect))
                    .collect::<Vec<_>>()
                    .join(", ");
                writeln!(out, "{prefix}{vals});").ctx("写入失败")
            }
            ExportWriter::Excel { sheet, row, .. } => {
                *row += 1;
                for (col, val) in values.iter().enumerate() {
                    let col = col as u16;
                    match val {
                        serde_json::Value::Null => Ok(sheet.as_mut()), // leave cell empty
                        serde_json::Value::Bool(b) => sheet.write_boolean(*row, col, *b),
                        serde_json::Value::Number(n) => match n.as_f64() {
                            Some(f) => sheet.write_number(*row, col, f),
                            None => Ok(sheet.as_mut()),
                        },
                        serde_json::Value::String(s) => sheet.write_string(*row, col, s),
                        other => sheet.write_string(*row, col, other.to_string()),
                    }
                    .ctx("写入单元格失败")?;
                }
                Ok(())
            }
        }
    }

    fn finish(self) -> Result<(), AppError> {
        match self {
            ExportWriter::Csv(mut out) | ExportWriter::SqlInsert { mut out, .. } => {
                out.flush().ctx("刷新缓冲区失败")
            }
            ExportWriter::Json { mut out, .. } => {
                writeln!(out, "\n]").ctx("写入失败")?;
                out.flush().ctx("刷新缓冲区失败")
            }
            ExportWriter::Excel { path, sheet, .. } => {
                let mut workbook = Workbook::new();
                workbook.push_worksheet(*sheet);
                workbook.save(&path).ctx("保存 Excel 文件失败")
            }
        }
    }
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
) -> Result<ExportResult, AppError> {
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
) -> Result<ExportResult, AppError> {
    // Route PG queries to the selected database (not the connection default).
    let pool = pools.pool_for(&connection_id, &database).await?;
    let dialect = pool.dialect();
    let table_ref = dialect.table_ref(&database, schema.as_deref(), &table);
    let sql = build_select_sql(
        &table_ref,
        &dialect.column_list(&columns),
        where_clause.as_deref(),
        limit,
    );
    ensure_single_statement(&sql, dialect)?;
    let col_names = pool.describe_columns(&sql).await.ctx("获取结果列失败")?;

    let file = File::create(&file_path).ctx("创建文件失败")?;
    let mut writer = ExportWriter::new(&format, file, &file_path, &col_names, dialect, &table_ref)?;

    let start = Instant::now();
    let mut rows_exported: u64 = 0;
    let emit = |current: u64| {
        if let Some(app) = app {
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            app.emit(
                "export-progress",
                ExportProgress {
                    current,
                    rows_per_sec: current as f64 / elapsed,
                },
            )
            .ok();
        }
    };
    let mut rows = text_rows(&pool, &sql);
    while let Some(values) = rows.next().await {
        writer.write_row(&values?)?;
        rows_exported += 1;
        if rows_exported.is_multiple_of(500) {
            emit(rows_exported);
        }
    }
    writer.finish()?;
    emit(rows_exported);

    Ok(ExportResult {
        rows_exported,
        file_path,
    })
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
) -> Result<Vec<TableExportStatus>, AppError> {
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
) -> Result<FilePreview, AppError> {
    let (columns, mut rows): (Vec<String>, Vec<Vec<Option<String>>>) = match format.as_str() {
        "csv" => parse_csv(&file_path, has_header)?,
        "json" => parse_json(&file_path)?,
        _ => return Err("SQL 文件无需预览".into()),
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
) -> Result<ImportResult, AppError> {
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
) -> Result<ImportResult, AppError> {
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
) -> Result<ImportResult, AppError> {
    pools.ensure_writable(&connection_id)?;
    // Route PG queries to the selected database (not the connection default).
    let pool = pools.pool_for(&connection_id, &database).await?;
    let dialect = pool.dialect();

    // ── SQL: execute statements directly ──────────────────────────
    if format == "sql" {
        let content = tokio::fs::read_to_string(&file_path)
            .await
            .ctx("读取文件失败")?;

        let stmts = crate::utils::sql::split_sql(&content, dialect.is_mysql())?;
        let mut conn = ImportConn::acquire(&pool).await?;
        if dialect.is_mysql() {
            conn.exec(&format!("USE {}", dialect.quote_ident(&database)))
                .await
                .ctx("切换数据库失败")?;
        }
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
            match conn.exec(stmt).await {
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

        conn.close().await;
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

    let (col_names, rows, total): (Vec<String>, ImportRowIter, u64) = match format.as_str() {
        // JSON arrays aren't streamable; parse into memory.
        "json" => {
            let (cols, rows) = parse_json(&file_path)?;
            let total = rows.len() as u64;
            (cols, Box::new(rows.into_iter().map(Ok)), total)
        }
        "csv" => open_csv_rows(&file_path, has_header)?,
        _ => return Err(format!("不支持的格式: {format}").into()),
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
            return Err(format!("目标表 {table} 中没有列 {target}").into());
        }
        if !seen.insert(target.clone()) {
            return Err(format!("目标列 {target} 重复映射").into());
        }
        mapped.push((index, target));
    }
    if mapped.is_empty() {
        return Err("至少需要映射一列".into());
    }

    let table_ref = dialect.table_ref(&database, schema.as_deref(), &table);
    let col_list = mapped
        .iter()
        .map(|(_, c)| dialect.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let formatter = ImportRowFormatter {
        mapped,
        kinds: column_kinds,
        dialect,
    };

    let mut conn = ImportConn::acquire(&pool).await?;
    let result = insert_import_rows(
        app,
        &mut conn,
        &format!("INSERT INTO {table_ref} ({col_list}) VALUES "),
        truncate_first.then(|| dialect.clear_table_sql(&table_ref)),
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
    dialect: Dialect,
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
                    self.dialect,
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("({values})")
    }
}

type ImportRowIter = Box<dyn Iterator<Item = Result<Vec<Option<String>>, AppError>> + Send>;

/// Stream CSV records from disk. A first pass counts rows for progress.
fn open_csv_rows(
    file_path: &str,
    has_header: bool,
) -> Result<(Vec<String>, ImportRowIter, u64), AppError> {
    let reader = || {
        csv::ReaderBuilder::new()
            .has_headers(has_header)
            .flexible(true)
            .from_path(file_path)
            .ctx("CSV 读取失败")
    };
    let mut counter = reader()?;
    let total = counter.records().count() as u64;
    let mut rdr = reader()?;
    let col_names: Vec<String> = if has_header {
        rdr.headers()
            .ctx("读取标题失败")?
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
            .ctx("CSV 行解析失败")
    });
    Ok((col_names, Box::new(rows), total))
}

fn first_record_width(mut rdr: csv::Reader<File>) -> Result<usize, AppError> {
    Ok(rdr
        .records()
        .next()
        .transpose()
        .ctx("CSV 行解析失败")?
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
) -> Result<ImportResult, AppError> {
    let atomic = clear_sql.is_some();
    if let Some(clear_sql) = clear_sql {
        conn.exec("BEGIN").await.ctx("开启事务失败")?;
        if let Err(e) = conn.exec(&clear_sql).await {
            conn.rollback().await;
            return Err(AppError::from_sqlx("清空表失败", e));
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
            return Err(format!("第 {line} 行：{e}。已回滚，表数据未改动").into());
        }
        if batch.is_empty() {
            break;
        }

        let sql = format!("{prefix}{}", batch.join(","));
        if atomic {
            if let Err(e) = conn.exec(&sql).await {
                conn.rollback().await;
                return Err(AppError::from_sqlx(
                    &format!("第 {batch_start}–{line} 行导入失败（已回滚，表数据未改动）"),
                    e,
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
        conn.exec("COMMIT").await.ctx("提交事务失败")?;
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
    async fn acquire(pool: &DbPool) -> Result<Self, AppError> {
        Ok(match pool {
            DbPool::MySQL(p) => ImportConn::MySql(p.acquire().await.ctx("获取连接失败")?.detach()),
            DbPool::Postgres(p) => ImportConn::Pg(p.acquire().await.ctx("获取连接失败")?.detach()),
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
) -> Result<(), AppError> {
    let table_ref = pool.dialect().table_ref(database, schema, table);
    pool.execute(&format!("TRUNCATE TABLE {table_ref}"))
        .await
        .ctx("清空表失败")?;
    Ok(())
}

/// Parsed import file: (columns, rows of optional cell strings)
type ParsedTable = (Vec<String>, Vec<Vec<Option<String>>>);

fn parse_csv(file_path: &str, has_header: bool) -> Result<ParsedTable, AppError> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(has_header)
        .flexible(true)
        .from_path(file_path)
        .ctx("CSV 读取失败")?;

    let col_names: Vec<String> = if has_header {
        rdr.headers()
            .ctx("读取标题失败")?
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![]
    };

    let mut records: Vec<csv::StringRecord> = Vec::new();
    for res in rdr.records() {
        records.push(res.ctx("CSV 行解析失败")?);
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
) -> Result<TransferResult, AppError> {
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
) -> Result<TransferResult, AppError> {
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
    pub(crate) fn register(&self, id: &str) -> Result<Arc<TransferControl>, AppError> {
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
) -> Result<TransferResult, AppError> {
    pools.ensure_writable(&tgt_connection_id)?;
    if src_connection_id == tgt_connection_id
        && src_database == tgt_database
        && src_schema == tgt_schema
        && src_table == tgt_table
    {
        return Err("不能将表传输到自身".into());
    }
    let src_pool = pools.pool_for(&src_connection_id, &src_database).await?;
    let tgt_pool = pools.pool_for(&tgt_connection_id, &tgt_database).await?;
    let (src_dialect, tgt_dialect) = (src_pool.dialect(), tgt_pool.dialect());
    let source = src_dialect.table_ref(&src_database, src_schema.as_deref(), &src_table);
    let target = tgt_dialect.table_ref(&tgt_database, tgt_schema.as_deref(), &tgt_table);
    let sql = build_select_sql(&source, "*", where_clause.as_deref(), limit);
    ensure_single_statement(&sql, src_dialect)?;
    let columns = src_pool
        .describe_columns(&sql)
        .await
        .ctx("获取源表列失败")?;
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
            .ok_or_else(|| AppError::sql(format!("找不到源列 {}", item.src)))?;
        if !seen.insert(item.tgt.clone()) {
            return Err(format!("目标列 {} 重复映射", item.tgt).into());
        }
        mapped.push((index, item.tgt));
    }
    if mapped.is_empty() {
        return Err("列映射为空".into());
    }
    let col_list = mapped
        .iter()
        .map(|(_, col)| tgt_dialect.quote_ident(col))
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
    let mut stream = text_rows(&src_pool, &sql);
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
                    .map(|(i, _)| sql_val(&row[*i], tgt_dialect))
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
async fn insert_transfer_batch(pool: &DbPool, sql: &str) -> Result<u64, AppError> {
    // Insert in a transaction; a failed statement is rolled back first.
    macro_rules! in_transaction {
        ($pool:expr) => {{
            let mut tx = $pool.begin().await.ctx("开启事务失败")?;
            match sqlx::Executor::execute(&mut *tx, sql).await {
                Ok(done) => {
                    tx.commit().await.ctx("提交事务失败")?;
                    return Ok(done.rows_affected());
                }
                Err(e) => {
                    tx.rollback().await.ctx("回滚失败")?;
                    e
                }
            }
        }};
    }
    for attempt in 0..3 {
        let error = match pool {
            DbPool::MySQL(p) => in_transaction!(p),
            DbPool::Postgres(p) => in_transaction!(p),
        };
        let retryable = error
            .as_database_error()
            .and_then(|e| e.code())
            .is_some_and(|c| matches!(c.as_ref(), "40001" | "40P01" | "1213"));
        if !retryable || attempt == 2 {
            return Err(AppError::from_sqlx("写入失败", error));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50 * (attempt + 1))).await;
    }
    unreachable!()
}

fn parse_json(file_path: &str) -> Result<ParsedTable, AppError> {
    let content = std::fs::read_to_string(file_path).ctx("读取文件失败")?;
    let value: serde_json::Value = serde_json::from_str(&content).ctx("JSON 解析失败")?;
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
        assert_eq!(
            sql_val(&serde_json::json!("plain"), Dialect::Postgres),
            "'plain'"
        );
        assert_eq!(
            sql_val(&serde_json::json!("it's"), Dialect::Postgres),
            "'it''s'"
        );
        assert_eq!(
            sql_val(&serde_json::json!("a\\b"), Dialect::Postgres),
            "E'a\\\\b'"
        );
        assert_eq!(sql_val(&serde_json::json!(true), Dialect::Postgres), "TRUE");
        let binary = serde_json::json!({"$lotdbBinary": "00ff"});
        assert_eq!(sql_val(&binary, Dialect::Postgres), "decode('00ff', 'hex')");
        assert_eq!(sql_val(&binary, Dialect::MySQL), "X'00ff'");
        assert_eq!(
            import_literal(Some("\\x00ff"), true, false, Dialect::MySQL),
            "X'00ff'"
        );
        assert_eq!(
            import_literal(Some("\\x00ff"), false, false, Dialect::Postgres),
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
    fn csv_line_quotes_headers_and_keeps_null_apart_from_empty() {
        use serde_json::json;
        assert_eq!(
            csv_line(&[json!("a,b"), json!(""), json!(null), json!(2)]),
            "\"a,b\",\"\",,2"
        );
    }

    #[test]
    fn writers_produce_each_format() {
        use serde_json::json;
        let dir = std::env::temp_dir().join(format!("lotdb-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let columns = vec!["id".to_string(), "na,me".to_string()];
        let rows = [vec![json!(1), json!("x")], vec![json!(2), json!(null)]];
        for format in ["csv", "json", "sql_insert", "excel"] {
            let path = dir.join(format).to_string_lossy().into_owned();
            let file = File::create(&path).unwrap();
            let mut w =
                ExportWriter::new(format, file, &path, &columns, Dialect::Postgres, "\"t\"")
                    .unwrap();
            for row in &rows {
                w.write_row(row).unwrap();
            }
            w.finish().unwrap();
        }
        let read = |f: &str| std::fs::read_to_string(dir.join(f)).unwrap();
        assert_eq!(read("csv"), "\"id\",\"na,me\"\n1,\"x\"\n2,\n");
        let json: serde_json::Value = serde_json::from_str(&read("json")).unwrap();
        assert_eq!(
            json,
            json!([{"id": 1, "na,me": "x"}, {"id": 2, "na,me": null}])
        );
        assert!(
            read("sql_insert").contains("INSERT INTO \"t\" (\"id\", \"na,me\") VALUES (2, NULL);")
        );
        assert!(std::fs::metadata(dir.join("excel")).unwrap().len() > 0);
        std::fs::remove_dir_all(dir).unwrap();
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
) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)
            .ctx("创建文件失败")?;
        let mut writer = ExportWriter::new("csv", file, &file_path, &columns, Dialect::MySQL, "")?;
        for row in &rows {
            writer.write_row(row)?;
        }
        writer.finish()
    })
    .await
    .ctx("导出任务失败")?
}

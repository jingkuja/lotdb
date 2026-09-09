import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig } from "@/types/database";

export async function createConnection(
  config: ConnectionConfig,
): Promise<ConnectionConfig> {
  return invoke<ConnectionConfig>("create_connection", { config });
}

export async function getConnections(): Promise<ConnectionConfig[]> {
  return invoke<ConnectionConfig[]>("get_connections");
}

export async function updateConnection(
  config: ConnectionConfig,
): Promise<ConnectionConfig> {
  return invoke<ConnectionConfig>("update_connection", { config });
}

export async function deleteConnection(id: string): Promise<void> {
  return invoke<void>("delete_connection", { id });
}

export async function testConnection(
  config: ConnectionConfig,
): Promise<string> {
  return invoke<string>("test_connection", { config });
}

// ─── Pool management ──────────────────────────────────────────────

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  affectedRows: number;
  executionMs: number;
  /** 结果超出上限被截断 */
  truncated: boolean;
}

export interface ExecuteOptions {
  /** 结果行数上限；0 = 不限制 */
  maxRows?: number;
  /** 本次执行的唯一 ID，用于取消查询 */
  executionId?: string;
  sessionId?: string;
}

export async function openConnection(config: ConnectionConfig): Promise<void> {
  return invoke<void>("open_connection", { config });
}

export async function closeConnection(id: string): Promise<void> {
  return invoke<void>("close_connection", { id });
}

export async function getActiveConnections(): Promise<string[]> {
  return invoke<string[]>("get_active_connections");
}

export async function executeQuery(
  connectionId: string,
  sql: string,
  opts?: ExecuteOptions,
): Promise<QueryResult> {
  return invoke<QueryResult>("execute_query", {
    connectionId,
    sql,
    maxRows: opts?.maxRows ?? null,
    executionId: opts?.executionId ?? null,
    sessionId: opts?.sessionId ?? null,
  });
}

export async function executeQueryWithParams(
  connectionId: string,
  sql: string,
  params: (string | number | boolean | null)[],
  opts?: ExecuteOptions,
): Promise<QueryResult> {
  return invoke<QueryResult>("execute_query_with_params", {
    connectionId,
    sql,
    params,
    maxRows: opts?.maxRows ?? null,
    executionId: opts?.executionId ?? null,
    sessionId: opts?.sessionId ?? null,
  });
}

/** 取消一个正在执行的查询（经独立连接发送 KILL / pg_cancel_backend）。 */
export async function cancelQuery(executionId: string): Promise<void> {
  return invoke<void>("cancel_query", { executionId });
}

// ─── Schema / object browser ──────────────────────────────────────

export interface SchemaObjects {
  tables: string[];
  views: string[];
  functions: string[];
}

export async function listDatabases(connectionId: string): Promise<string[]> {
  return invoke<string[]>("list_databases", { connectionId });
}

export async function listSchemas(
  connectionId: string,
  database: string,
): Promise<string[]> {
  return invoke<string[]>("list_schemas", { connectionId, database });
}

export async function listObjects(
  connectionId: string,
  database: string,
  schema?: string,
): Promise<SchemaObjects> {
  return invoke<SchemaObjects>("list_objects", { connectionId, database, schema });
}

// ─── Table structure ──────────────────────────────────────────────

export interface ColumnDef {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  comment: string | null;
  extra: string | null;
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  indexType: string;
}

export interface ForeignKeyDef {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export async function getTableColumns(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table: string,
): Promise<ColumnDef[]> {
  return invoke<ColumnDef[]>("get_table_columns", {
    connectionId,
    database,
    schema,
    table,
  });
}

export async function getTableIndexes(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table: string,
): Promise<IndexDef[]> {
  return invoke<IndexDef[]>("get_table_indexes", {
    connectionId,
    database,
    schema,
    table,
  });
}

export async function getTableForeignKeys(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table: string,
): Promise<ForeignKeyDef[]> {
  return invoke<ForeignKeyDef[]>("get_table_foreign_keys", {
    connectionId,
    database,
    schema,
    table,
  });
}

// ─── Object search ────────────────────────────────────────────────

export interface SearchResult {
  database: string;
  schema: string | null;
  name: string;
  objectType: "table" | "view" | "function";
}

export async function searchObjects(
  connectionId: string,
  query: string,
  limit?: number,
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>("search_objects", { connectionId, query, limit });
}

// ─── Autocomplete schema ──────────────────────────────────────────

export interface CompletionTable {
  database: string;
  schema: string | null;
  name: string;
  columns: string[];
}

export async function getCompletionSchema(
  connectionId: string,
): Promise<CompletionTable[]> {
  return invoke<CompletionTable[]>("get_completion_schema", { connectionId });
}

// ─── Object DDL (views / functions) ───────────────────────────────

export interface ObjectDdl {
  objectType: "view" | "function" | "procedure" | "trigger";
  name: string;
  ddl: string;
}

export async function getViewDdl(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
): Promise<ObjectDdl> {
  return invoke<ObjectDdl>("get_view_ddl", { connectionId, database, schema: schema ?? null, name });
}

export async function getFunctionDdl(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
): Promise<ObjectDdl> {
  return invoke<ObjectDdl>("get_function_ddl", { connectionId, database, schema: schema ?? null, name });
}

// ─── Triggers ─────────────────────────────────────────────────────

export interface TriggerInfo {
  name: string;
  table: string;
  timing: string;
  event: string;
  ddl: string;
}

export async function listTriggers(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table?: string,
): Promise<TriggerInfo[]> {
  return invoke<TriggerInfo[]>("list_triggers", {
    connectionId,
    database,
    schema: schema ?? null,
    table: table ?? null,
  });
}

export async function getTriggerDdl(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table: string | undefined,
  name: string,
): Promise<ObjectDdl> {
  return invoke<ObjectDdl>("get_trigger_ddl", {
    connectionId,
    database,
    schema: schema ?? null,
    table: table ?? null,
    name,
  });
}

export async function dropTrigger(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table: string,
  name: string,
): Promise<void> {
  return invoke<void>("drop_trigger", { connectionId, database, schema: schema ?? null, table, name });
}

// ─── PG sequences ─────────────────────────────────────────────────

export interface SequenceInfo {
  name: string;
  dataType: string;
  startValue: number;
  minValue: number;
  maxValue: number;
  incrementBy: number;
  cycle: boolean;
  lastValue: number | null;
}

export interface SequenceOptions {
  start?: number | null;
  increment?: number | null;
  min?: number | null;
  max?: number | null;
  cycle: boolean;
}

export async function listSequences(
  connectionId: string,
  database: string,
  schema: string | undefined,
): Promise<SequenceInfo[]> {
  return invoke<SequenceInfo[]>("list_sequences", { connectionId, database, schema: schema ?? null });
}

export async function createSequence(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  options: SequenceOptions,
): Promise<void> {
  return invoke<void>("create_sequence", { connectionId, database, schema: schema ?? null, name, options });
}

export async function restartSequence(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  value?: number | null,
): Promise<void> {
  return invoke<void>("restart_sequence", {
    connectionId,
    database,
    schema: schema ?? null,
    name,
    value: value ?? null,
  });
}

export async function dropSequence(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
): Promise<void> {
  return invoke<void>("drop_sequence", { connectionId, database, schema: schema ?? null, name });
}

// ─── PG enum types ────────────────────────────────────────────────

export interface EnumTypeInfo {
  name: string;
  labels: string[];
}

export async function listEnums(
  connectionId: string,
  database: string,
  schema: string | undefined,
): Promise<EnumTypeInfo[]> {
  return invoke<EnumTypeInfo[]>("list_enums", { connectionId, database, schema: schema ?? null });
}

export async function createEnumType(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  labels: string[],
): Promise<void> {
  return invoke<void>("create_enum_type", { connectionId, database, schema: schema ?? null, name, labels });
}

export async function addEnumValue(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  label: string,
): Promise<void> {
  return invoke<void>("add_enum_value", { connectionId, database, schema: schema ?? null, name, label });
}

export async function dropEnumType(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  cascade: boolean,
): Promise<void> {
  return invoke<void>("drop_enum_type", { connectionId, database, schema: schema ?? null, name, cascade });
}

// ─── Connection groups ────────────────────────────────────────────

export interface ConnectionGroup {
  id: string;
  name: string;
  parentId?: string;
}

export async function listGroups(): Promise<ConnectionGroup[]> {
  return invoke<ConnectionGroup[]>("list_groups");
}

export async function createGroup(name: string): Promise<ConnectionGroup> {
  return invoke<ConnectionGroup>("create_group", { name, parentId: null });
}

export async function renameGroup(id: string, name: string): Promise<void> {
  return invoke<void>("rename_group", { id, name });
}

export async function deleteGroup(id: string): Promise<void> {
  return invoke<void>("delete_group", { id });
}

// ─── Query history ────────────────────────────────────────────────

export interface HistoryEntry {
  id: number;
  connectionId: string;
  connectionName: string;
  sql: string;
  status: "success" | "error";
  rowsAffected: number | null;
  executionMs: number | null;
  errorMessage: string | null;
  executedAt: string;
}

export interface SaveHistoryArgs {
  connectionId: string;
  connectionName: string;
  sql: string;
  status: "success" | "error";
  rowsAffected?: number | null;
  executionMs?: number | null;
  errorMessage?: string | null;
}

export async function saveHistory(args: SaveHistoryArgs): Promise<number> {
  const { connectionId, connectionName, sql, status, rowsAffected, executionMs, errorMessage } = args;
  return invoke<number>("save_history", {
    connectionId,
    connectionName,
    sql,
    status,
    rowsAffected: rowsAffected ?? null,
    executionMs: executionMs ?? null,
    errorMessage: errorMessage ?? null,
  });
}

export async function getHistory(
  connectionId?: string,
  limit?: number,
): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("get_history", { connectionId, limit });
}

export async function deleteHistory(id: number): Promise<void> {
  return invoke<void>("delete_history", { id });
}

export async function clearHistory(connectionId?: string): Promise<void> {
  return invoke<void>("clear_history", { connectionId });
}

// ─── Table data ───────────────────────────────────────────────────

export interface TableDataResult {
  columns: string[];
  rows: unknown[][];
  totalCount: number;
}

export interface ColumnFilter {
  column: string;
  op: "=" | "!=" | "LIKE" | "NOT LIKE" | ">" | "<" | ">=" | "<=" | "IS NULL" | "IS NOT NULL";
  value: string;
}

export async function getTableData(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table: string,
  limit: number,
  offset: number,
  orderBy?: string,
  orderDir?: "ASC" | "DESC",
  filters?: ColumnFilter[],
): Promise<TableDataResult> {
  return invoke<TableDataResult>("get_table_data", {
    connectionId,
    database,
    schema,
    table,
    limit,
    offset,
    orderBy: orderBy ?? null,
    orderDir: orderDir ?? null,
    filters: filters && filters.length > 0 ? filters : null,
  });
}

export async function executeStatements(
  connectionId: string,
  sqls: string[],
  database?: string,
): Promise<number> {
  return invoke<number>("execute_statements", { connectionId, sqls, database: database ?? null });
}

// ─── Snippets ─────────────────────────────────────────────────────

export interface SnippetEntry {
  id: number;
  name: string;
  sql: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getSnippets(search?: string): Promise<SnippetEntry[]> {
  return invoke<SnippetEntry[]>("get_snippets", { search });
}

export async function createSnippet(
  name: string,
  sql: string,
  description?: string,
): Promise<SnippetEntry> {
  return invoke<SnippetEntry>("create_snippet", { name, sql, description });
}

export async function updateSnippet(
  id: number,
  name: string,
  sql: string,
  description?: string,
): Promise<SnippetEntry> {
  return invoke<SnippetEntry>("update_snippet", { id, name, sql, description });
}

export async function deleteSnippet(id: number): Promise<void> {
  return invoke<void>("delete_snippet", { id });
}

// ─── Export ───────────────────────────────────────────────────────

export type ExportFormat = "csv" | "json" | "sql_insert" | "excel";

export interface ExportOptions {
  connectionId: string;
  database: string;
  schema?: string;
  table: string;
  format: ExportFormat;
  /** Selected column names; empty array = all columns */
  columns: string[];
  /** Raw WHERE expression (without keyword), optional */
  whereClause?: string;
  /** Max rows to export; 0 = no limit */
  limit: number;
  /** Absolute path to the output file */
  filePath: string;
}

export interface ExportResult {
  rowsExported: number;
  filePath: string;
}

export async function exportTableData(opts: ExportOptions): Promise<ExportResult> {
  return invoke<ExportResult>("export_table_data", {
    connectionId: opts.connectionId,
    database: opts.database,
    schema: opts.schema,
    table: opts.table,
    format: opts.format,
    columns: opts.columns,
    whereClause: opts.whereClause ?? null,
    limit: opts.limit,
    filePath: opts.filePath,
  });
}

export interface TableExportStatus {
  table: string;
  rowsExported: number;
  filePath: string;
  error: string | null;
}

// ─── Import ───────────────────────────────────────────────────────

// ─── Progress event payloads ──────────────────────────────────────

export interface ImportProgressEvent {
  current: number;
  total: number;
  rowsPerSec: number;
  etaSec: number;
}

export interface BatchExportProgressEvent {
  tableIndex: number;
  totalTables: number;
  table: string;
}

// ─── Import ───────────────────────────────────────────────────────

export type ImportFormat = "csv" | "json" | "sql";

export interface ImportResult {
  rowsImported: number;
  rowsFailed: number;
  errorMessage: string | null;
}

export interface FilePreview {
  columns: string[];
  rows: (string | null)[][];
}

export async function previewImportFile(
  filePath: string,
  format: ImportFormat,
  hasHeader: boolean,
  previewRows?: number,
): Promise<FilePreview> {
  return invoke<FilePreview>("preview_import_file", {
    filePath,
    format,
    hasHeader,
    previewRows: previewRows ?? 5,
  });
}

export async function importTableData(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table: string,
  filePath: string,
  format: ImportFormat,
  hasHeader: boolean,
  truncateFirst: boolean,
  columnMapping: (string | null)[],
): Promise<ImportResult> {
  return invoke<ImportResult>("import_table_data", {
    connectionId,
    database,
    schema,
    table,
    filePath,
    format,
    hasHeader,
    truncateFirst,
    columnMapping,
  });
}

export async function batchExportTables(
  connectionId: string,
  database: string,
  schema: string | undefined,
  tables: string[],
  format: ExportFormat,
  limit: number,
  outputDir: string,
): Promise<TableExportStatus[]> {
  return invoke<TableExportStatus[]>("batch_export_tables", {
    connectionId,
    database,
    schema,
    tables,
    format,
    limit,
    outputDir,
  });
}

// ─── Database management ──────────────────────────────────────────

export async function createDatabase(
  connectionId: string,
  dbName: string,
  charset?: string,
  collation?: string,
): Promise<void> {
  return invoke<void>("create_database", { connectionId, dbName, charset, collation });
}

export async function dropDatabase(
  connectionId: string,
  dbName: string,
): Promise<void> {
  return invoke<void>("drop_database", { connectionId, dbName });
}

// ─── User management ──────────────────────────────────────────────

export interface UserInfo {
  username: string;
  host: string;      // empty for PG
  isSuper: boolean;
  canLogin: boolean; // PG only
}

export interface DbPrivilege {
  database: string;
  privileges: string;
}

export async function listUsers(connectionId: string): Promise<UserInfo[]> {
  return invoke<UserInfo[]>("list_users", { connectionId });
}

export async function getUserGrants(
  connectionId: string,
  username: string,
  host: string,
): Promise<DbPrivilege[]> {
  return invoke<DbPrivilege[]>("get_user_grants", { connectionId, username, host });
}

export async function createUser(
  connectionId: string,
  username: string,
  host: string,
  password: string,
): Promise<void> {
  return invoke<void>("create_user", { connectionId, username, host, password });
}

export async function dropUser(
  connectionId: string,
  username: string,
  host: string,
): Promise<void> {
  return invoke<void>("drop_user", { connectionId, username, host });
}

export async function grantPrivilege(
  connectionId: string,
  username: string,
  host: string,
  database: string,
): Promise<void> {
  return invoke<void>("grant_privilege", { connectionId, username, host, database });
}

export async function revokePrivilege(
  connectionId: string,
  username: string,
  host: string,
  database: string,
): Promise<void> {
  return invoke<void>("revoke_privilege", { connectionId, username, host, database });
}

// ─── Process list ─────────────────────────────────────────────────

export interface ProcessInfo {
  id: number;
  user: string;
  host: string;
  database: string | null;
  command: string;
  timeSec: number;
  state: string;
  info: string | null;
}

export async function listProcesses(connectionId: string): Promise<ProcessInfo[]> {
  return invoke<ProcessInfo[]>("list_processes", { connectionId });
}

export async function killProcess(
  connectionId: string,
  processId: number,
  killType: "connection" | "query",
): Promise<void> {
  return invoke<void>("kill_process", { connectionId, processId, killType });
}

// ─── Disk usage ───────────────────────────────────────────────────

export interface DbSizeInfo {
  database: string;
  sizeBytes: number;
}

export interface TableSizeInfo {
  tableName: string;
  dataBytes: number;
  indexBytes: number;
  totalBytes: number;
  rowCount: number | null;
}

export async function getDiskUsage(connectionId: string): Promise<DbSizeInfo[]> {
  return invoke<DbSizeInfo[]>("get_disk_usage", { connectionId });
}

export async function getTableSizes(
  connectionId: string,
  database: string,
  schema?: string,
): Promise<TableSizeInfo[]> {
  return invoke<TableSizeInfo[]>("get_table_sizes", { connectionId, database, schema });
}

// ─── Explain ──────────────────────────────────────────────────────

export interface ExplainResult {
  isText: boolean;
  columns: string[];
  rows: (string | null)[][];
}

export async function explainQuery(
  connectionId: string,
  sql: string,
  analyze: boolean,
  opts?: ExecuteOptions,
): Promise<ExplainResult> {
  return invoke<ExplainResult>("explain_query", { connectionId, sql, analyze, sessionId: opts?.sessionId ?? null, executionId: opts?.executionId ?? null });
}

// ─── Cross-connection data transfer ──────────────────────────────

export interface ColumnMap {
  src: string;
  tgt: string;
}

export interface TransferResult {
  rowsTransferred: number;
  rowsFailed: number;
  errorMessage: string | null;
}

// ─── Backup / Restore ─────────────────────────────────────────────

export interface BackupResult {
  filePath: string;
  sizeBytes: number;
  stderrOutput: string;
}

export interface RestoreResult {
  rowsAffected: number;
  stderrOutput: string;
}

export async function backupDatabase(
  connectionId: string,
  database: string,
  filePath: string,
  noData: boolean,
  noSchema: boolean,
  tables: string[],
): Promise<BackupResult> {
  return invoke<BackupResult>("backup_database", {
    connectionId,
    database,
    filePath,
    noData,
    noSchema,
    tables,
  });
}

export async function restoreDatabase(
  connectionId: string,
  database: string,
  filePath: string,
  createDb: boolean,
): Promise<RestoreResult> {
  return invoke<RestoreResult>("restore_database", {
    connectionId,
    database,
    filePath,
    createDb,
  });
}

export async function transferTableData(
  srcConnectionId: string,
  srcDatabase: string,
  srcSchema: string | undefined,
  srcTable: string,
  tgtConnectionId: string,
  tgtDatabase: string,
  tgtSchema: string | undefined,
  tgtTable: string,
  columnMapping: ColumnMap[],
  truncateFirst: boolean,
  whereClause: string | undefined,
  limit: number,
): Promise<TransferResult> {
  return invoke<TransferResult>("transfer_table_data", {
    srcConnectionId,
    srcDatabase,
    srcSchema,
    srcTable,
    tgtConnectionId,
    tgtDatabase,
    tgtSchema,
    tgtTable,
    columnMapping,
    truncateFirst,
    whereClause,
    limit,
  });
}

// ─── Connection import/export ──────────────────────────────────────

export interface ImportConnectionsResult {
  imported: number;
  skipped: number;
}

export async function importConnections(
  configs: ConnectionConfig[],
): Promise<ImportConnectionsResult> {
  return invoke<ImportConnectionsResult>("import_connections", { configs });
}

export async function closeQuerySession(connectionId: string, sessionId: string): Promise<void> {
  return invoke<void>("close_query_session", { connectionId, sessionId });
}

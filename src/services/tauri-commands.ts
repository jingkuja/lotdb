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
): Promise<QueryResult> {
  return invoke<QueryResult>("execute_query", { connectionId, sql });
}

export async function executeQueryWithParams(
  connectionId: string,
  sql: string,
  params: (string | number | boolean | null)[],
): Promise<QueryResult> {
  return invoke<QueryResult>("execute_query_with_params", { connectionId, sql, params });
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

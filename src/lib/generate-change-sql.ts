import type { PendingEdit, NewRow, GridRow } from "@/components/grid/data-grid";
import type { DatabaseType } from "@/types/database";

// PendingEdit.newValue is now string | null

interface GenerateOptions {
  dbType: DatabaseType;
  database: string;
  schema?: string;
  table: string;
  columns: string[];
  pkColumns: string[];   // column names that form the PK
  rows: GridRow[];       // current page data (original values)
  pendingEdits: Record<string, PendingEdit>;
  pendingDeletes: Set<number>;
  newRows: NewRow[];
}

function quoteIdent(name: string, dbType: DatabaseType): string {
  return dbType === "postgres" ? `"${name}"` : `\`${name}\``;
}

function quoteTable(opts: GenerateOptions): string {
  const { dbType, database, schema, table } = opts;
  if (dbType === "postgres") {
    const s = schema ?? "public";
    return `"${s}"."${table}"`;
  }
  return `\`${database}\`.\`${table}\``;
}

function escapeValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

/** Render a value for use in SQL. null → NULL, string → quoted. */
function sqlValue(v: string | null): string {
  if (v === null) return "NULL";
  return `'${escapeValue(v)}'`;
}

/** Render an original (unknown) cell value for use in a WHERE clause. */
function sqlOrigValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  return `'${escapeValue(String(v))}'`;
}

function buildWhere(
  rowIndex: number,
  columns: string[],
  rows: GridRow[],
  pkColumns: string[],
  dbType: DatabaseType,
): string | null {
  if (pkColumns.length === 0) return null; // cannot safely UPDATE/DELETE without PK
  const row = rows[rowIndex];
  if (!row) return null;

  const conditions = pkColumns.map((pk) => {
    const colIdx = columns.indexOf(pk);
    const val = colIdx >= 0 ? row[colIdx] : null;
    return `${quoteIdent(pk, dbType)} = ${sqlOrigValue(val)}`;
  });
  return conditions.join(" AND ");
}

export function generateChangeSql(opts: GenerateOptions): string[] {
  const { dbType, columns, pkColumns, rows, pendingEdits, pendingDeletes, newRows } = opts;
  const tbl = quoteTable(opts);
  const sqls: string[] = [];

  // ── UPDATEs (group edits by row) ──────────────────────────────
  const editsByRow = new Map<number, PendingEdit[]>();
  for (const edit of Object.values(pendingEdits)) {
    if (!editsByRow.has(edit.rowIndex)) editsByRow.set(edit.rowIndex, []);
    editsByRow.get(edit.rowIndex)!.push(edit);
  }

  for (const [rowIndex, edits] of editsByRow) {
    if (pendingDeletes.has(rowIndex)) continue; // row will be deleted, skip update
    const where = buildWhere(rowIndex, columns, rows, pkColumns, dbType);
    if (!where) continue;
    const setClauses = edits.map(
      (e) => `${quoteIdent(e.column, dbType)} = ${sqlValue(e.newValue ?? null)}`,
    );
    sqls.push(`UPDATE ${tbl} SET ${setClauses.join(", ")} WHERE ${where};`);
  }

  // ── DELETEs ───────────────────────────────────────────────────
  for (const rowIndex of pendingDeletes) {
    const where = buildWhere(rowIndex, columns, rows, pkColumns, dbType);
    if (!where) continue;
    sqls.push(`DELETE FROM ${tbl} WHERE ${where};`);
  }

  // ── INSERTs ───────────────────────────────────────────────────
  for (const newRow of newRows) {
    const cols = columns.filter((c) => newRow[c] !== undefined);
    if (cols.length === 0) continue;
    const colList = cols.map((c) => quoteIdent(c, dbType)).join(", ");
    const valList = cols.map((c) => sqlValue(newRow[c] ?? null)).join(", ");
    sqls.push(`INSERT INTO ${tbl} (${colList}) VALUES (${valList});`);
  }

  return sqls;
}

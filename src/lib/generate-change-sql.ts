import { quoteIdent, sqlLiteral, binaryLiteral } from "./sql-literal";
import type { PendingEdit, NewRow, GridRow } from "@/components/grid/data-grid";
import type { DatabaseType } from "@/types/database";

// PendingEdit.newValue is now string | null

interface GenerateOptions {
  dbType: DatabaseType;
  database: string;
  schema?: string;
  table: string;
  columns: string[];
  binaryColumns?: string[];
  pkColumns: string[]; // column names that form the PK
  rows: GridRow[]; // current page data (original values)
  pendingEdits: Record<string, PendingEdit>;
  pendingDeletes: Set<number>;
  newRows: NewRow[];
}

function quoteTable(opts: GenerateOptions): string {
  return `${quoteIdent(opts.dbType === "postgres" ? (opts.schema ?? "public") : opts.database, opts.dbType)}.${quoteIdent(opts.table, opts.dbType)}`;
}

function buildWhere(
  rowIndex: number,
  columns: string[],
  rows: GridRow[],
  pkColumns: string[],
  dbType: DatabaseType,
  binaryColumns: string[],
): string | null {
  if (pkColumns.length === 0) return null; // cannot safely UPDATE/DELETE without PK
  const row = rows[rowIndex];
  if (!row) return null;

  const conditions = pkColumns.map((pk) => {
    const colIdx = columns.indexOf(pk);
    const val = colIdx >= 0 ? row[colIdx] : null;
    return `${quoteIdent(pk, dbType)} = ${(binaryColumns.includes(pk) ? binaryLiteral : sqlLiteral)(val, dbType)}`;
  });
  return conditions.join(" AND ");
}

export function generateChangeSql(opts: GenerateOptions): string[] {
  const {
    dbType,
    columns,
    pkColumns,
    rows,
    pendingEdits,
    pendingDeletes,
    newRows,
    binaryColumns = [],
  } = opts;
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
    const where = buildWhere(
      rowIndex,
      columns,
      rows,
      pkColumns,
      dbType,
      binaryColumns,
    );
    if (!where) continue;
    const setClauses = edits.map(
      (e) =>
        `${quoteIdent(e.column, dbType)} = ${(binaryColumns.includes(e.column) ? binaryLiteral : sqlLiteral)(e.newValue ?? null, dbType)}`,
    );
    sqls.push(`UPDATE ${tbl} SET ${setClauses.join(", ")} WHERE ${where};`);
  }

  // ── DELETEs ───────────────────────────────────────────────────
  for (const rowIndex of pendingDeletes) {
    const where = buildWhere(
      rowIndex,
      columns,
      rows,
      pkColumns,
      dbType,
      binaryColumns,
    );
    if (!where) continue;
    sqls.push(`DELETE FROM ${tbl} WHERE ${where};`);
  }

  // ── INSERTs ───────────────────────────────────────────────────
  for (const newRow of newRows) {
    const cols = columns.filter((c) => newRow[c] !== undefined);
    if (cols.length === 0) {
      sqls.push(
        dbType === "postgres"
          ? `INSERT INTO ${tbl} DEFAULT VALUES;`
          : `INSERT INTO ${tbl} () VALUES ();`,
      );
      continue;
    }
    const colList = cols.map((c) => quoteIdent(c, dbType)).join(", ");
    const valList = cols
      .map((c) =>
        (binaryColumns.includes(c) ? binaryLiteral : sqlLiteral)(
          newRow[c] ?? null,
          dbType,
        ),
      )
      .join(", ");
    sqls.push(`INSERT INTO ${tbl} (${colList}) VALUES (${valList});`);
  }

  return sqls;
}

/** Lock and compare the original snapshot inside the commit transaction. */
export function generateChangeChecks(
  opts: GenerateOptions,
): { sql: string; original: unknown[] }[] {
  const indexes = new Set([
    ...Object.values(opts.pendingEdits).map((e) => e.rowIndex),
    ...opts.pendingDeletes,
  ]);
  return [...indexes]
    .sort((a, b) => a - b)
    .flatMap((index) => {
      const where = buildWhere(
        index,
        opts.columns,
        opts.rows,
        opts.pkColumns,
        opts.dbType,
        opts.binaryColumns ?? [],
      );
      if (!where) return [];
      return [
        {
          sql: `SELECT ${opts.columns.map((c) => quoteIdent(c, opts.dbType)).join(", ")} FROM ${quoteTable(opts)} WHERE ${where} FOR UPDATE`,
          original: opts.rows[index]!,
        },
      ];
    });
}

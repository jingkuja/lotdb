import { quoteIdent, sqlLiteral } from "./sql-literal";
import type { GridRow } from "@/components/grid/data-grid";
import type { DatabaseType } from "@/types/database";

function cellStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function quoteTable(database: string, schema: string | undefined, table: string, dbType: DatabaseType): string {
  return `${quoteIdent(dbType === "postgres" ? schema ?? "public" : database, dbType)}.${quoteIdent(table, dbType)}`;
}

// ─── INSERT ───────────────────────────────────────────────────────

export function copyAsInsert(
  database: string,
  schema: string | undefined,
  table: string,
  columns: string[],
  rows: GridRow[],
  dbType: DatabaseType,
): string {
  if (rows.length === 0) return "";
  const tbl = quoteTable(database, schema, table, dbType);
  const colList = columns.map((c) => quoteIdent(c, dbType)).join(", ");
  const valueRows = rows.map((row) => {
    const vals = columns.map((_, i) => sqlLiteral(row[i], dbType));
    return `  (${vals.join(", ")})`;
  });
  return `INSERT INTO ${tbl} (${colList}) VALUES\n${valueRows.join(",\n")};`;
}

// ─── CSV ──────────────────────────────────────────────────────────

function csvCell(value: unknown): string {
  const s = cellStr(value);
  // Quote if contains comma, newline, or double-quote
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function copyAsCsv(columns: string[], rows: GridRow[]): string {
  const header = columns.map(csvCell).join(",");
  const dataRows = rows.map((row) =>
    columns.map((_, i) => csvCell(row[i])).join(","),
  );
  return [header, ...dataRows].join("\n");
}

// ─── JSON ─────────────────────────────────────────────────────────

export function copyAsJson(columns: string[], rows: GridRow[]): string {
  const objects = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i] ?? null;
    });
    return obj;
  });
  return JSON.stringify(objects, null, 2);
}

// ─── Markdown ─────────────────────────────────────────────────────

export function copyAsMarkdown(columns: string[], rows: GridRow[]): string {
  const escape = (s: string) => s.replace(/\|/g, "\\|");
  const header = `| ${columns.map((c) => escape(c)).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const dataRows = rows.map(
    (row) =>
      `| ${columns.map((_, i) => escape(cellStr(row[i]))).join(" | ")} |`,
  );
  return [header, separator, ...dataRows].join("\n");
}

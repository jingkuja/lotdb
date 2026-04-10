/**
 * Detect parameterized placeholders in SQL.
 *
 * MySQL / SQLite style:  ?  (positional, unnamed)
 * PostgreSQL style:      $1, $2, $3 … (positional, numbered)
 *
 * Returns an ordered list of param descriptors so the UI can render
 * one input per placeholder.
 */

export interface SqlParam {
  /** Display label shown in the input dialog */
  label: string;
  /** Index into the bound params array (0-based) */
  index: number;
}

export type ParamStyle = "mysql" | "postgres" | "none";

/** Strip SQL single-line (--) and block (/* *\/) comments before scanning. */
function stripComments(sql: string): string {
  // Remove block comments
  let out = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Remove line comments
  out = out.replace(/--[^\n]*/g, " ");
  return out;
}

/** Strip string literals to avoid matching ? or $N inside strings. */
function stripStrings(sql: string): string {
  // Single-quoted strings (handles escaped quote '' but not \')
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

export function detectParams(sql: string): { params: SqlParam[]; style: ParamStyle } {
  const clean = stripStrings(stripComments(sql));

  // PostgreSQL: $1 … $N
  const pgMatches = [...clean.matchAll(/\$(\d+)/g)];
  if (pgMatches.length > 0) {
    const maxIdx = Math.max(...pgMatches.map((m) => parseInt(m[1]!, 10)));
    const params: SqlParam[] = Array.from({ length: maxIdx }, (_, i) => ({
      label: `$${i + 1}`,
      index: i,
    }));
    return { params, style: "postgres" };
  }

  // MySQL: ? (count occurrences)
  const qCount = [...clean.matchAll(/\?/g)].length;
  if (qCount > 0) {
    const params: SqlParam[] = Array.from({ length: qCount }, (_, i) => ({
      label: `参数 ${i + 1}`,
      index: i,
    }));
    return { params, style: "mysql" };
  }

  return { params: [], style: "none" };
}

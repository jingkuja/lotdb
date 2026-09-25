import { splitStatements } from "./split-statements";
import type { DatabaseType } from "@/types/database";

export function currentStatement(
  sql: string,
  cursor: number,
  dialect: DatabaseType,
): string {
  let offset = 0;
  let last = "";
  for (const statement of splitStatements(sql, dialect)) {
    const start = sql.indexOf(statement, offset);
    const end = start + statement.length;
    if (cursor <= end) return statement;
    offset = end + 1;
    last = statement;
  }
  return last;
}

/** Conservative: unknown commands and CTEs also require confirmation. */
export function needsWriteConfirmation(sql: string): boolean {
  const leading = sql.replace(
    /^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,
    "",
  );
  if (/^EXPLAIN\b/i.test(leading) && /\bANALYZE\b/i.test(leading))
    return /\b(INSERT|UPDATE|DELETE|MERGE|CALL)\b/i.test(leading);
  return !/^(SELECT|SHOW|EXPLAIN|DESC|DESCRIBE|VALUES|TABLE|BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(
    leading,
  );
}

export function transactionAction(sql: string): "begin" | "end" | null {
  const text = sql
    .replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
    .trim();
  if (/^(BEGIN|START\s+TRANSACTION)\b/i.test(text)) return "begin";
  if (
    /^(COMMIT|END|ROLLBACK|ABORT)(?:\s+(?:WORK|TRANSACTION))?\s*;?$/i.test(text)
  )
    return "end";
  return null;
}

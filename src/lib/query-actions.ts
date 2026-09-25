import { splitStatements } from "./split-statements";
import type { DatabaseType } from "@/types/database";

export function currentStatement(sql: string, cursor: number, dialect: DatabaseType): string {
  let offset = 0;
  for (const statement of splitStatements(sql, dialect)) {
    const start = sql.indexOf(statement, offset);
    const end = start + statement.length;
    if (cursor <= end) return statement;
    offset = end + 1;
  }
  return "";
}

/** Conservative: unknown commands and CTEs also require confirmation. */
export function needsWriteConfirmation(sql: string): boolean {
  const leading = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
  return !/^(SELECT|SHOW|EXPLAIN|DESC|DESCRIBE|VALUES|TABLE|BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(leading);
}

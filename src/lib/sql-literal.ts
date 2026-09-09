import type { DatabaseType } from "@/types/database";

export function quoteIdent(name: string, dbType: DatabaseType): string {
  const q = dbType === "postgres" ? '"' : "`";
  return q + name.replaceAll(q, q + q) + q;
}

/** Explicit escaping independent of standard_conforming_strings / NO_BACKSLASH_ESCAPES. */
export function sqlLiteral(value: unknown, dbType: DatabaseType): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new Error("数值超出安全范围，请刷新数据后重试");
    }
    return String(value);
  }
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (dbType === "mysql" && /[\\\0]/.test(text)) {
    const hex = Array.from(new TextEncoder().encode(text), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return `CONVERT(X'${hex}' USING utf8mb4)`;
  }
  const escaped = text.replaceAll("'", "''");
  return dbType === "postgres" && text.includes("\\")
    ? `E'${escaped.replaceAll("\\", "\\\\")}'`
    : `'${escaped}'`;
}

/** Grid binary values use a full \x-prefixed hex representation. */
export function binaryLiteral(value: unknown, dbType: DatabaseType): string {
  if (typeof value === "string" && /^\\x(?:[0-9a-f]{2})*$/i.test(value)) {
    const hex = value.slice(2);
    return dbType === "mysql" ? `X'${hex}'` : `decode('${hex}', 'hex')`;
  }
  return sqlLiteral(value, dbType);
}

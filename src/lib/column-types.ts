import type { DatabaseType } from "@/types/database";

export interface TypeGroup {
  label: string;
  types: string[];
}

export const MYSQL_TYPE_GROUPS: TypeGroup[] = [
  {
    label: "整数",
    types: ["TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT"],
  },
  {
    label: "浮点/定点",
    types: ["FLOAT", "DOUBLE", "DECIMAL"],
  },
  {
    label: "字符串",
    types: ["CHAR", "VARCHAR", "TINYTEXT", "TEXT", "MEDIUMTEXT", "LONGTEXT"],
  },
  {
    label: "日期时间",
    types: ["DATE", "TIME", "DATETIME", "TIMESTAMP", "YEAR"],
  },
  {
    label: "二进制",
    types: ["BINARY", "VARBINARY", "TINYBLOB", "BLOB", "MEDIUMBLOB", "LONGBLOB"],
  },
  {
    label: "其他",
    types: ["BOOLEAN", "JSON", "ENUM", "SET"],
  },
];

export const PG_TYPE_GROUPS: TypeGroup[] = [
  {
    label: "整数",
    types: ["SMALLINT", "INTEGER", "BIGINT", "SERIAL", "BIGSERIAL"],
  },
  {
    label: "浮点/定点",
    types: ["REAL", "DOUBLE PRECISION", "NUMERIC"],
  },
  {
    label: "字符串",
    types: ["CHAR", "VARCHAR", "TEXT"],
  },
  {
    label: "日期时间",
    types: ["DATE", "TIME", "TIMESTAMP", "TIMESTAMPTZ", "INTERVAL"],
  },
  {
    label: "布尔/UUID",
    types: ["BOOLEAN", "UUID"],
  },
  {
    label: "JSON/二进制",
    types: ["JSON", "JSONB", "BYTEA"],
  },
];

export function getTypeGroups(dbType: DatabaseType): TypeGroup[] {
  return dbType === "postgres" ? PG_TYPE_GROUPS : MYSQL_TYPE_GROUPS;
}

/** Types that support a length/precision parameter */
export const TYPES_WITH_LENGTH = new Set([
  "CHAR", "VARCHAR", "BINARY", "VARBINARY",
  "DECIMAL", "NUMERIC", "FLOAT", "DOUBLE",
  "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT",
]);

/** Types that support auto_increment (MySQL) / SERIAL (PG via type itself) */
export const MYSQL_AUTO_INCREMENT_TYPES = new Set([
  "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "BIGINT",
]);

export const PG_SERIAL_TYPES = new Set(["SERIAL", "BIGSERIAL"]);

export function supportsAutoIncrement(type: string, dbType: DatabaseType): boolean {
  if (dbType === "postgres") return PG_SERIAL_TYPES.has(type.toUpperCase());
  return MYSQL_AUTO_INCREMENT_TYPES.has(type.toUpperCase());
}

export function supportsUnsigned(type: string, dbType: DatabaseType): boolean {
  if (dbType === "postgres") return false;
  return MYSQL_AUTO_INCREMENT_TYPES.has(type.toUpperCase()) ||
    ["FLOAT", "DOUBLE", "DECIMAL"].includes(type.toUpperCase());
}

export function supportsLength(type: string): boolean {
  return TYPES_WITH_LENGTH.has(type.toUpperCase());
}

/**
 * Converts raw DB schema defs (from tauri-commands) into DesignerState
 * so an existing table can be pre-loaded in the TableDesignerTab.
 */
import {
  getTableColumns,
  getTableIndexes,
  getTableForeignKeys,
  type ColumnDef,
  type IndexDef,
  type ForeignKeyDef,
} from "@/services/tauri-commands";
import {
  type DesignerColumn,
  type DesignerIndex,
  type DesignerForeignKey,
  type DesignerState,
  type IndexType,
  type IndexMethod,
  type FKAction,
} from "@/types/designer";
import type { DatabaseType } from "@/types/database";

// ─── MySQL COLUMN_TYPE parser ─────────────────────────────────────
// e.g. "varchar(255)" → {baseType:"VARCHAR", length:"255", unsigned:false}
// e.g. "int(11) unsigned" → {baseType:"INT", length:"", unsigned:true}
// e.g. "decimal(10,2)" → {baseType:"DECIMAL", length:"10,2", unsigned:false}

function parseMysqlType(rawType: string): {
  baseType: string;
  length: string;
  unsigned: boolean;
} {
  let s = rawType.trim();
  const unsigned = s.endsWith(" unsigned");
  if (unsigned) s = s.slice(0, -" unsigned".length).trim();

  const parenIdx = s.indexOf("(");
  if (parenIdx === -1) {
    return { baseType: s.toUpperCase(), length: "", unsigned };
  }
  const baseType = s.slice(0, parenIdx).toUpperCase();
  const length = s.slice(parenIdx + 1, s.lastIndexOf(")"));
  return { baseType, length, unsigned };
}

// ─── PG format_type → designer type ──────────────────────────────
// format_type() returns verbose strings like "character varying(255)", "integer", etc.

function parsePgType(rawType: string): { baseType: string; length: string } {
  const s = rawType.trim().toLowerCase();

  // character varying(n)
  const charVarMatch = s.match(/^character varying\((\d+)\)$/);
  if (charVarMatch) return { baseType: "VARCHAR", length: charVarMatch[1]! };

  // character varying (no length)
  if (s === "character varying") return { baseType: "VARCHAR", length: "" };

  // character(n)
  const charMatch = s.match(/^character\((\d+)\)$/);
  if (charMatch) return { baseType: "CHAR", length: charMatch[1]! };

  // numeric(p,s) or numeric(p)
  const numMatch = s.match(/^numeric\(([^)]+)\)$/);
  if (numMatch) return { baseType: "NUMERIC", length: numMatch[1]! };

  // double precision
  if (s === "double precision") return { baseType: "DOUBLE PRECISION", length: "" };

  // timestamp / time variants
  if (s.startsWith("timestamp with time zone")) return { baseType: "TIMESTAMPTZ", length: "" };
  if (s.startsWith("timestamp")) return { baseType: "TIMESTAMP", length: "" };
  if (s.startsWith("time with time zone")) return { baseType: "TIME", length: "" };
  if (s.startsWith("time")) return { baseType: "TIME", length: "" };

  // Map verbose names to designer names
  const MAP: Record<string, string> = {
    integer: "INTEGER",
    bigint: "BIGINT",
    smallint: "SMALLINT",
    real: "REAL",
    boolean: "BOOLEAN",
    text: "TEXT",
    date: "DATE",
    json: "JSON",
    jsonb: "JSONB",
    uuid: "UUID",
    bytea: "BYTEA",
    interval: "INTERVAL",
  };
  if (MAP[s]) return { baseType: MAP[s]!, length: "" };

  // Serial types (rarely returned by format_type but handle them)
  if (s === "serial") return { baseType: "SERIAL", length: "" };
  if (s === "bigserial") return { baseType: "BIGSERIAL", length: "" };

  // Fall back to uppercase
  return { baseType: rawType.toUpperCase(), length: "" };
}

// ─── ColumnDef → DesignerColumn ───────────────────────────────────

let _counter = 0;
const nextId = () => `loaded-col-${Date.now()}-${_counter++}`;

function toDesignerColumn(def: ColumnDef, dbType: DatabaseType): DesignerColumn {
  const { baseType, length, unsigned } =
    dbType === "mysql"
      ? parseMysqlType(def.dataType)
      : { ...parsePgType(def.dataType), unsigned: false };

  const isAutoIncrement =
    dbType === "mysql"
      ? def.extra === "auto_increment"
      : baseType === "SERIAL" || baseType === "BIGSERIAL";

  return {
    id: nextId(),
    name: def.name,
    type: baseType,
    length,
    nullable: def.nullable,
    defaultValue: def.defaultValue ?? "",
    isPrimaryKey: def.isPrimaryKey,
    isAutoIncrement,
    isUnique: false, // derived from indexes below
    unsigned,
    comment: def.comment ?? "",
  };
}

// ─── IndexDef → DesignerIndex ─────────────────────────────────────

function toDesignerIndex(def: IndexDef): DesignerIndex {
  let type: IndexType = "INDEX";
  if (def.unique && !def.primary) type = "UNIQUE";
  // fulltext / spatial names come through indexType for MySQL
  const upperType = def.indexType.toUpperCase();
  if (upperType === "FULLTEXT") type = "FULLTEXT";
  if (upperType === "SPATIAL") type = "SPATIAL";

  const method = (["BTREE", "HASH", "FULLTEXT", "SPATIAL", "GIN", "GIST", "BRIN", "SPGIST"].includes(
    upperType,
  )
    ? upperType
    : "BTREE") as IndexMethod;

  return {
    id: `loaded-idx-${def.name}`,
    name: def.name,
    type,
    columns: def.columns,
    method,
    comment: "",
  };
}

// ─── ForeignKeyDef → DesignerForeignKey ──────────────────────────

function toDesignerForeignKey(def: ForeignKeyDef): DesignerForeignKey {
  const validActions: FKAction[] = [
    "NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT",
  ];
  const onDelete = validActions.includes(def.onDelete as FKAction)
    ? (def.onDelete as FKAction)
    : "NO ACTION";
  const onUpdate = validActions.includes(def.onUpdate as FKAction)
    ? (def.onUpdate as FKAction)
    : "NO ACTION";

  return {
    id: `loaded-fk-${def.name}`,
    name: def.name,
    columns: def.columns,
    refTable: def.refTable,
    refColumns: def.refColumns,
    onDelete,
    onUpdate,
  };
}

// ─── Public API ───────────────────────────────────────────────────

export async function getTableDesignerState(
  connectionId: string,
  database: string,
  schema: string | undefined,
  tableName: string,
  dbType: DatabaseType,
): Promise<DesignerState> {
  const [cols, idxs, fks] = await Promise.all([
    getTableColumns(connectionId, database, schema, tableName),
    getTableIndexes(connectionId, database, schema, tableName),
    getTableForeignKeys(connectionId, database, schema, tableName),
  ]);

  const columns = cols.map((c) => toDesignerColumn(c, dbType));

  // Mark unique columns from UNIQUE single-column indexes
  const uniqueColNames = new Set<string>();
  for (const idx of idxs) {
    if (idx.unique && !idx.primary && idx.columns.length === 1) {
      uniqueColNames.add(idx.columns[0]!);
    }
  }
  for (const col of columns) {
    if (uniqueColNames.has(col.name)) col.isUnique = true;
  }

  // Skip PRIMARY index (represented by isPrimaryKey on column)
  const indexes = idxs
    .filter((i) => !i.primary)
    .map(toDesignerIndex);

  const foreignKeys = fks.map(toDesignerForeignKey);

  return { tableName, tableComment: "", columns, indexes, foreignKeys };
}

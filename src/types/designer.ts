export interface DesignerColumn {
  /** Internal React key */
  id: string;
  name: string;
  type: string;
  /** For VARCHAR/CHAR/DECIMAL etc. */
  length: string;
  nullable: boolean;
  defaultValue: string;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  isUnique: boolean;
  unsigned: boolean; // MySQL only
  comment: string;
}

export type IndexType = "INDEX" | "UNIQUE" | "FULLTEXT" | "SPATIAL";
export type IndexMethod = "BTREE" | "HASH" | "FULLTEXT" | "SPATIAL" | "GIN" | "GIST" | "BRIN" | "SPGIST";

export type FKAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";

export interface DesignerForeignKey {
  id: string;
  name: string;
  /** Local column names (ordered) */
  columns: string[];
  /** Referenced schema (PG only, optional) */
  refSchema?: string;
  refTable: string;
  /** Parallel to columns — referenced column names */
  refColumns: string[];
  onDelete: FKAction;
  onUpdate: FKAction;
}

export interface DesignerIndex {
  id: string;
  name: string;
  type: IndexType;
  columns: string[];   // ordered list of column names
  method: IndexMethod;
  comment: string;
}

export interface DesignerState {
  tableName: string;
  tableComment: string;
  columns: DesignerColumn[];
  indexes: DesignerIndex[];
  foreignKeys: DesignerForeignKey[];
}

export function emptyIndex(id: string): DesignerIndex {
  return { id, name: "", type: "INDEX", columns: [], method: "BTREE", comment: "" };
}

export function emptyForeignKey(id: string): DesignerForeignKey {
  return {
    id,
    name: "",
    columns: [],
    refTable: "",
    refColumns: [],
    onDelete: "NO ACTION",
    onUpdate: "NO ACTION",
  };
}

export function emptyColumn(id: string): DesignerColumn {
  return {
    id,
    name: "",
    type: "VARCHAR",
    length: "255",
    nullable: true,
    defaultValue: "",
    isPrimaryKey: false,
    isAutoIncrement: false,
    isUnique: false,
    unsigned: false,
    comment: "",
  };
}

export function emptyState(): DesignerState {
  return { tableName: "", tableComment: "", columns: [], indexes: [], foreignKeys: [] };
}

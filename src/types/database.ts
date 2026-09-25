export type DatabaseType = "mysql" | "postgres";

export interface ConnectionConfig {
  id: string;
  name: string;
  dbType: DatabaseType;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  /** 只读模式：拦截 DML/DDL */
  readonly?: boolean;
  groupId?: string;
  ssh?: SSHConfig;
  ssl?: SSLConfig;
  color?: string;
}

export interface SSHConfig {
  host: string;
  port: number;
  user: string;
  authType: "password" | "key";
  password?: string;
  privateKeyPath?: string;
  hostKeyFingerprint?: string;
  passphrase?: string;
}

export interface SSLConfig {
  enabled: boolean;
  caPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
}

export interface ConnectionGroup {
  id: string;
  name: string;
  parentId?: string;
}

export interface DatabaseObject {
  name: string;
  type: "database" | "schema" | "table" | "view" | "function" | "procedure" | "trigger" | "sequence" | "enum";
  schema?: string;
  database?: string;
}

export interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  comment: string | null;
}

export interface TableIndex {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  affectedRows: number;
  executionTime: number;
}

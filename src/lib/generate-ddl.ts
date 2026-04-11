/**
 * DDL generator: DesignerState → CREATE TABLE / ALTER TABLE SQL.
 */
import type {
  DesignerState,
  DesignerColumn,
  DesignerIndex,
  DesignerForeignKey,
} from "@/types/designer";
import type { DatabaseType } from "@/types/database";

// ─── Helpers ──────────────────────────────────────────────────────

function q(name: string, dbType: DatabaseType): string {
  return dbType === "mysql" ? `\`${name}\`` : `"${name}"`;
}

function tableRef(
  tableName: string,
  dbType: DatabaseType,
  schema?: string,
): string {
  if (schema && dbType === "postgres") {
    return `${q(schema, dbType)}.${q(tableName, dbType)}`;
  }
  return q(tableName, dbType);
}

/** Build the type fragment: "VARCHAR(255)", "INT UNSIGNED", "DECIMAL(10,2)", etc. */
function colType(col: DesignerColumn, dbType: DatabaseType): string {
  let t = col.type;
  if (col.length) t += `(${col.length})`;
  if (col.unsigned && dbType === "mysql") t += " UNSIGNED";
  return t;
}

/** Build DEFAULT clause, or empty string if no default. */
function defaultClause(col: DesignerColumn): string {
  if (col.isAutoIncrement) return ""; // MySQL AUTO_INCREMENT has no DEFAULT
  if (col.defaultValue === "") return "";
  if (col.defaultValue.toUpperCase() === "NULL") return " DEFAULT NULL";
  // Output raw — user is responsible for correctness (e.g. 0, 'foo', NOW())
  return ` DEFAULT ${col.defaultValue}`;
}

/** Full column definition line (without trailing comma). */
function colDef(col: DesignerColumn, dbType: DatabaseType): string {
  const name = q(col.name, dbType);
  const type = colType(col, dbType);
  const nullability = col.nullable ? "NULL" : "NOT NULL";
  const autoInc =
    col.isAutoIncrement && dbType === "mysql" ? " AUTO_INCREMENT" : "";
  const def = defaultClause(col);
  const comment =
    col.comment && dbType === "mysql"
      ? ` COMMENT '${col.comment.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
      : "";
  return `  ${name} ${type} ${nullability}${autoInc}${def}${comment}`;
}

/** PK column list as a parenthesised, quoted, comma-separated string. */
function pkList(cols: DesignerColumn[], dbType: DatabaseType): string {
  return cols
    .filter((c) => c.isPrimaryKey)
    .map((c) => q(c.name, dbType))
    .join(", ");
}

/** Index definition inside CREATE TABLE (MySQL only). */
function mysqlIndexLine(idx: DesignerIndex): string {
  const cols = idx.columns.map((c) => `\`${c}\``).join(", ");
  const name = `\`${idx.name || `idx_${idx.columns.join("_")}`}\``;
  switch (idx.type) {
    case "UNIQUE":
      return `  UNIQUE KEY ${name} (${cols})`;
    case "FULLTEXT":
      return `  FULLTEXT KEY ${name} (${cols})`;
    case "SPATIAL":
      return `  SPATIAL KEY ${name} (${cols})`;
    default:
      return `  KEY ${name} (${cols})`;
  }
}

/** FK constraint definition line. */
function fkLine(
  fk: DesignerForeignKey,
  dbType: DatabaseType,
  schema?: string,
): string {
  const name = q(
    fk.name || `fk_${fk.columns.join("_")}`,
    dbType,
  );
  const localCols = fk.columns.map((c) => q(c, dbType)).join(", ");
  const refTable = fk.refSchema
    ? tableRef(fk.refTable, dbType, fk.refSchema)
    : tableRef(fk.refTable, dbType, schema);
  const refCols = fk.refColumns.map((c) => q(c, dbType)).join(", ");
  const onDelete = `ON DELETE ${fk.onDelete}`;
  const onUpdate = `ON UPDATE ${fk.onUpdate}`;
  return `  CONSTRAINT ${name} FOREIGN KEY (${localCols}) REFERENCES ${refTable} (${refCols}) ${onDelete} ${onUpdate}`;
}

// ─── CREATE TABLE ─────────────────────────────────────────────────

export function generateCreateTable(
  state: DesignerState,
  dbType: DatabaseType,
  schema?: string,
): string {
  const { tableName, tableComment, columns, indexes, foreignKeys } = state;
  const tref = tableRef(tableName || "table_name", dbType, schema);
  const lines: string[] = [];

  // Column definitions
  for (const col of columns) {
    if (!col.name) continue;
    lines.push(colDef(col, dbType));
  }

  // PRIMARY KEY
  const pkCols = pkList(columns, dbType);
  if (pkCols) lines.push(`  PRIMARY KEY (${pkCols})`);

  if (dbType === "mysql") {
    // Indexes inline
    for (const idx of indexes) {
      if (idx.columns.length === 0) continue;
      lines.push(mysqlIndexLine(idx));
    }
    // Foreign keys inline
    for (const fk of foreignKeys) {
      if (!fk.refTable || fk.columns.length === 0) continue;
      lines.push(fkLine(fk, dbType, schema));
    }
  } else {
    // PG: UNIQUE constraints inline; regular indexes are separate statements
    for (const idx of indexes) {
      if (idx.columns.length === 0 || idx.type !== "UNIQUE") continue;
      const cols = idx.columns.map((c) => q(c, dbType)).join(", ");
      const name = idx.name
        ? `CONSTRAINT ${q(idx.name, dbType)} `
        : "";
      lines.push(`  ${name}UNIQUE (${cols})`);
    }
    // PG: FK constraints inline
    for (const fk of foreignKeys) {
      if (!fk.refTable || fk.columns.length === 0) continue;
      lines.push(fkLine(fk, dbType, schema));
    }
  }

  const body = lines.join(",\n");
  let sql = `CREATE TABLE ${tref} (\n${body}\n)`;

  if (dbType === "mysql") {
    if (tableComment) {
      sql += ` COMMENT='${tableComment.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    }
    sql += ";";
  } else {
    sql += ";\n";
    // PG: separate CREATE INDEX statements for non-UNIQUE indexes
    for (const idx of indexes) {
      if (idx.columns.length === 0 || idx.type === "UNIQUE") continue;
      const idxName = q(idx.name || `idx_${idx.columns.join("_")}`, dbType);
      const cols = idx.columns.map((c) => q(c, dbType)).join(", ");
      const method = idx.method !== "BTREE" ? ` USING ${idx.method}` : "";
      sql += `\nCREATE INDEX ${idxName} ON ${tref} (${cols})${method};`;
    }
    // PG: table comment
    if (tableComment) {
      sql += `\n\nCOMMENT ON TABLE ${tref} IS '${tableComment.replace(/'/g, "''")}';`;
    }
    // PG: column comments
    for (const col of columns) {
      if (col.comment && col.name) {
        sql += `\nCOMMENT ON COLUMN ${tref}.${q(col.name, dbType)} IS '${col.comment.replace(/'/g, "''")}';`;
      }
    }
  }

  return sql;
}

// ─── ALTER TABLE ──────────────────────────────────────────────────

function colChanged(a: DesignerColumn, b: DesignerColumn): boolean {
  return (
    a.type !== b.type ||
    a.length !== b.length ||
    a.nullable !== b.nullable ||
    a.defaultValue !== b.defaultValue ||
    a.isPrimaryKey !== b.isPrimaryKey ||
    a.isAutoIncrement !== b.isAutoIncrement ||
    a.isUnique !== b.isUnique ||
    a.unsigned !== b.unsigned ||
    a.comment !== b.comment
  );
}

/**
 * Generate ALTER TABLE statements comparing original → current state.
 * Returns an array of SQL strings (each ending with ";").
 */
export function generateAlterTable(
  original: DesignerState,
  current: DesignerState,
  dbType: DatabaseType,
  schema?: string,
): string[] {
  const stmts: string[] = [];
  const origName = original.tableName || "table_name";
  const currName = current.tableName || "table_name";
  const tref = tableRef(origName, dbType, schema);
  const newTref = tableRef(currName, dbType, schema);

  // ── Table rename ──────────────────────────────────────────────
  if (origName !== currName) {
    if (dbType === "mysql") {
      stmts.push(`RENAME TABLE ${tref} TO ${newTref};`);
    } else {
      stmts.push(`ALTER TABLE ${tref} RENAME TO ${q(currName, dbType)};`);
    }
  }

  const tref2 = tableRef(currName, dbType, schema); // after rename

  // ── Column changes ────────────────────────────────────────────
  const origColMap = new Map(original.columns.map((c) => [c.name, c]));
  const currColMap = new Map(current.columns.map((c) => [c.name, c]));

  // Dropped columns (in original, not in current)
  for (const col of original.columns) {
    if (!currColMap.has(col.name) && col.name) {
      if (dbType === "mysql") {
        stmts.push(
          `ALTER TABLE ${tref2} DROP COLUMN ${q(col.name, dbType)};`,
        );
      } else {
        stmts.push(
          `ALTER TABLE ${tref2} DROP COLUMN ${q(col.name, dbType)};`,
        );
      }
    }
  }

  // Added columns (in current, not in original)
  for (const col of current.columns) {
    if (!origColMap.has(col.name) && col.name) {
      const def = colDef(col, dbType).trim();
      stmts.push(`ALTER TABLE ${tref2} ADD COLUMN ${def};`);
    }
  }

  // Modified columns (in both)
  for (const col of current.columns) {
    const orig = origColMap.get(col.name);
    if (!orig || !col.name) continue;
    if (!colChanged(orig, col)) continue;

    if (dbType === "mysql") {
      stmts.push(
        `ALTER TABLE ${tref2} MODIFY COLUMN ${colDef(col, dbType).trim()};`,
      );
    } else {
      // PG: separate ALTER statements for each sub-change
      const colName = q(col.name, dbType);
      const prefix = `ALTER TABLE ${tref2} ALTER COLUMN ${colName}`;

      if (orig.type !== col.type || orig.length !== col.length) {
        stmts.push(`${prefix} TYPE ${colType(col, dbType)};`);
      }
      if (orig.nullable !== col.nullable) {
        stmts.push(
          col.nullable
            ? `${prefix} DROP NOT NULL;`
            : `${prefix} SET NOT NULL;`,
        );
      }
      if (orig.defaultValue !== col.defaultValue) {
        if (col.defaultValue === "") {
          stmts.push(`${prefix} DROP DEFAULT;`);
        } else if (col.defaultValue.toUpperCase() === "NULL") {
          stmts.push(`${prefix} SET DEFAULT NULL;`);
        } else {
          stmts.push(`${prefix} SET DEFAULT ${col.defaultValue};`);
        }
      }
      if (orig.comment !== col.comment) {
        stmts.push(
          `COMMENT ON COLUMN ${tref2}.${colName} IS '${col.comment.replace(/'/g, "''")}';`,
        );
      }
    }
  }

  // ── PK change ────────────────────────────────────────────────
  const origPk = original.columns
    .filter((c) => c.isPrimaryKey)
    .map((c) => c.name)
    .sort()
    .join(",");
  const currPk = current.columns
    .filter((c) => c.isPrimaryKey)
    .map((c) => c.name)
    .sort()
    .join(",");

  if (origPk !== currPk) {
    if (dbType === "mysql") {
      if (origPk) stmts.push(`ALTER TABLE ${tref2} DROP PRIMARY KEY;`);
      if (currPk) {
        const cols = current.columns
          .filter((c) => c.isPrimaryKey)
          .map((c) => q(c.name, dbType))
          .join(", ");
        stmts.push(`ALTER TABLE ${tref2} ADD PRIMARY KEY (${cols});`);
      }
    } else {
      // PG: drop constraint by name (usually "tablename_pkey")
      if (origPk)
        stmts.push(
          `ALTER TABLE ${tref2} DROP CONSTRAINT IF EXISTS ${q(`${origName}_pkey`, dbType)};`,
        );
      if (currPk) {
        const cols = current.columns
          .filter((c) => c.isPrimaryKey)
          .map((c) => q(c.name, dbType))
          .join(", ");
        stmts.push(`ALTER TABLE ${tref2} ADD PRIMARY KEY (${cols});`);
      }
    }
  }

  // ── Index changes ────────────────────────────────────────────
  const origIdxMap = new Map(original.indexes.map((i) => [i.name, i]));
  const currIdxMap = new Map(current.indexes.map((i) => [i.name, i]));

  // Dropped indexes
  for (const idx of original.indexes) {
    if (!currIdxMap.has(idx.name) && idx.name) {
      if (dbType === "mysql") {
        stmts.push(
          `ALTER TABLE ${tref2} DROP INDEX ${q(idx.name, dbType)};`,
        );
      } else {
        stmts.push(`DROP INDEX IF EXISTS ${q(idx.name, dbType)};`);
      }
    }
  }

  // Added indexes
  for (const idx of current.indexes) {
    if (!origIdxMap.has(idx.name) && idx.name && idx.columns.length > 0) {
      if (dbType === "mysql") {
        stmts.push(
          `ALTER TABLE ${tref2} ADD ${mysqlIndexLine(idx).trim()};`,
        );
      } else {
        const isUnique = idx.type === "UNIQUE" ? "UNIQUE " : "";
        const idxName = q(idx.name, dbType);
        const cols = idx.columns.map((c) => q(c, dbType)).join(", ");
        const method = idx.method !== "BTREE" ? ` USING ${idx.method}` : "";
        stmts.push(
          `CREATE ${isUnique}INDEX ${idxName} ON ${tref2} (${cols})${method};`,
        );
      }
    }
  }

  // Modified indexes (drop + recreate)
  for (const idx of current.indexes) {
    const orig = origIdxMap.get(idx.name);
    if (!orig || !idx.name || idx.columns.length === 0) continue;
    const changed =
      orig.type !== idx.type ||
      orig.method !== idx.method ||
      orig.columns.join(",") !== idx.columns.join(",");
    if (!changed) continue;

    if (dbType === "mysql") {
      stmts.push(
        `ALTER TABLE ${tref2} DROP INDEX ${q(idx.name, dbType)}, ADD ${mysqlIndexLine(idx).trim()};`,
      );
    } else {
      stmts.push(`DROP INDEX IF EXISTS ${q(idx.name, dbType)};`);
      const isUnique = idx.type === "UNIQUE" ? "UNIQUE " : "";
      const idxName = q(idx.name, dbType);
      const cols = idx.columns.map((c) => q(c, dbType)).join(", ");
      const method = idx.method !== "BTREE" ? ` USING ${idx.method}` : "";
      stmts.push(
        `CREATE ${isUnique}INDEX ${idxName} ON ${tref2} (${cols})${method};`,
      );
    }
  }

  // ── FK changes ───────────────────────────────────────────────
  const origFkMap = new Map(original.foreignKeys.map((f) => [f.name, f]));
  const currFkMap = new Map(current.foreignKeys.map((f) => [f.name, f]));

  // Dropped FKs
  for (const fk of original.foreignKeys) {
    if (!currFkMap.has(fk.name) && fk.name) {
      if (dbType === "mysql") {
        stmts.push(
          `ALTER TABLE ${tref2} DROP FOREIGN KEY ${q(fk.name, dbType)};`,
        );
      } else {
        stmts.push(
          `ALTER TABLE ${tref2} DROP CONSTRAINT ${q(fk.name, dbType)};`,
        );
      }
    }
  }

  // Added FKs
  for (const fk of current.foreignKeys) {
    if (
      !origFkMap.has(fk.name) &&
      fk.name &&
      fk.columns.length > 0 &&
      fk.refTable
    ) {
      stmts.push(
        `ALTER TABLE ${tref2} ADD ${fkLine(fk, dbType, schema).trim()};`,
      );
    }
  }

  // Modified FKs (drop + re-add)
  for (const fk of current.foreignKeys) {
    const orig = origFkMap.get(fk.name);
    if (!orig || !fk.name || !fk.refTable || fk.columns.length === 0) continue;
    const changed =
      orig.refTable !== fk.refTable ||
      orig.columns.join(",") !== fk.columns.join(",") ||
      orig.refColumns.join(",") !== fk.refColumns.join(",") ||
      orig.onDelete !== fk.onDelete ||
      orig.onUpdate !== fk.onUpdate;
    if (!changed) continue;

    if (dbType === "mysql") {
      stmts.push(
        `ALTER TABLE ${tref2} DROP FOREIGN KEY ${q(fk.name, dbType)};`,
      );
    } else {
      stmts.push(
        `ALTER TABLE ${tref2} DROP CONSTRAINT ${q(fk.name, dbType)};`,
      );
    }
    stmts.push(
      `ALTER TABLE ${tref2} ADD ${fkLine(fk, dbType, schema).trim()};`,
    );
  }

  // ── Table comment change (MySQL) ──────────────────────────────
  if (
    dbType === "mysql" &&
    original.tableComment !== current.tableComment
  ) {
    stmts.push(
      `ALTER TABLE ${tref2} COMMENT='${current.tableComment.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
      }';`,
    );
  }

  return stmts;
}

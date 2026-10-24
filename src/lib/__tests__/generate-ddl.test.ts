import { describe, expect, it } from "vitest";
import { generateAlterTable, generateCreateTable } from "@/lib/generate-ddl";
import {
  emptyColumn,
  type DesignerColumn,
  type DesignerState,
} from "@/types/designer";

function col(id: string, name: string, extra: Partial<DesignerColumn> = {}): DesignerColumn {
  return { ...emptyColumn(id), name, ...extra };
}

function table(columns: DesignerColumn[], rest: Partial<DesignerState> = {}): DesignerState {
  return { tableName: "t", tableComment: "", columns, indexes: [], foreignKeys: [], ...rest };
}

describe("generateAlterTable — columns", () => {
  const original = table([
    col("1", "id", { type: "INT", length: "", nullable: false, isPrimaryKey: true }),
    col("2", "name"),
  ]);

  it("renames a column instead of dropping it (MySQL and PG)", () => {
    const current = table([original.columns[0]!, { ...original.columns[1]!, name: "title" }]);
    expect(generateAlterTable(original, current, "mysql")).toEqual([
      "ALTER TABLE `t` RENAME COLUMN `name` TO `title`;",
    ]);
    expect(generateAlterTable(original, current, "postgres", "public")).toEqual([
      'ALTER TABLE "public"."t" RENAME COLUMN "name" TO "title";',
    ]);
  });

  it("renames and modifies under the new name", () => {
    const current = table([
      original.columns[0]!,
      { ...original.columns[1]!, name: "title", length: "100" },
    ]);
    expect(generateAlterTable(original, current, "mysql")).toEqual([
      "ALTER TABLE `t` RENAME COLUMN `name` TO `title`;",
      "ALTER TABLE `t` MODIFY COLUMN `title` VARCHAR(100) NULL;",
    ]);
  });

  it("swaps two names through temporary names", () => {
    const current = table([
      { ...original.columns[0]!, name: "name" },
      { ...original.columns[1]!, name: "id" },
    ]);
    const stmts = generateAlterTable(original, current, "postgres");
    expect(stmts.slice(0, 4)).toEqual([
      'ALTER TABLE "t" RENAME COLUMN "id" TO "__lotdb_tmp_0";',
      'ALTER TABLE "t" RENAME COLUMN "name" TO "__lotdb_tmp_1";',
      'ALTER TABLE "t" RENAME COLUMN "__lotdb_tmp_0" TO "name";',
      'ALTER TABLE "t" RENAME COLUMN "__lotdb_tmp_1" TO "id";',
    ]);
  });

  it("does not rebuild the primary key when a key column is renamed", () => {
    const current = table([{ ...original.columns[0]!, name: "pk" }, original.columns[1]!]);
    expect(generateAlterTable(original, current, "mysql")).toEqual([
      "ALTER TABLE `t` RENAME COLUMN `id` TO `pk`;",
    ]);
  });

  it("keeps index columns pointing at a renamed column", () => {
    const withIdx = table(original.columns, {
      indexes: [{ id: "i", name: "idx_name", type: "INDEX", columns: ["name"], method: "BTREE", comment: "" }],
    });
    const current = table([original.columns[0]!, { ...original.columns[1]!, name: "title" }], {
      indexes: withIdx.indexes,
    });
    expect(generateAlterTable(withIdx, current, "mysql")).toEqual([
      "ALTER TABLE `t` RENAME COLUMN `name` TO `title`;",
    ]);
  });

  it("drops and re-adds when a column is replaced by a new one", () => {
    const current = table([original.columns[0]!, col("3", "name")]);
    // Same name but a different column (new id) in the designer: name pairing
    // only applies to columns without an id counterpart.
    expect(generateAlterTable(original, current, "mysql")).toEqual([]);
    const replaced = table([original.columns[0]!, col("3", "other")]);
    expect(generateAlterTable(original, replaced, "mysql")).toEqual([
      "ALTER TABLE `t` DROP COLUMN `name`;",
      "ALTER TABLE `t` ADD COLUMN `other` VARCHAR(255) NULL;",
    ]);
  });

  it("pairs by name when ids are unrelated (schema compare)", () => {
    const other = table([
      col("x", "id", { type: "INT", length: "", nullable: false, isPrimaryKey: true }),
      col("y", "name", { length: "50" }),
    ]);
    expect(generateAlterTable(original, other, "mysql")).toEqual([
      "ALTER TABLE `t` MODIFY COLUMN `name` VARCHAR(50) NULL;",
    ]);
  });
});

describe("MySQL attributes the designer does not model", () => {
  const extras = {
    charset: "CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
    generated: "",
    attributes: "ON UPDATE CURRENT_TIMESTAMP",
  };

  it("survive MODIFY COLUMN", () => {
    const original = table([
      col("1", "code", { mysqlExtras: { ...extras, attributes: "" } }),
      col("2", "ts", {
        type: "TIMESTAMP",
        length: "",
        defaultValue: "CURRENT_TIMESTAMP",
        mysqlExtras: { charset: "", generated: "", attributes: extras.attributes },
      }),
      col("3", "total", {
        type: "INT",
        length: "",
        mysqlExtras: { charset: "", generated: "GENERATED ALWAYS AS ((`id` * 2)) STORED", attributes: "" },
      }),
    ]);
    const current = table(original.columns.map((c) => ({ ...c, comment: "note" })));
    expect(generateAlterTable(original, current, "mysql")).toEqual([
      "ALTER TABLE `t` MODIFY COLUMN `code` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT 'note';",
      "ALTER TABLE `t` MODIFY COLUMN `ts` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'note';",
      "ALTER TABLE `t` MODIFY COLUMN `total` INT GENERATED ALWAYS AS ((`id` * 2)) STORED NULL COMMENT 'note';",
    ]);
  });

  it("drop the collation when the type is no longer textual", () => {
    const original = table([col("1", "code", { mysqlExtras: { ...extras, attributes: "" } })]);
    const current = table([{ ...original.columns[0]!, type: "INT", length: "" }]);
    expect(generateAlterTable(original, current, "mysql")).toEqual([
      "ALTER TABLE `t` MODIFY COLUMN `code` INT NULL;",
    ]);
  });

  it("are ignored for PostgreSQL", () => {
    const state = table([col("1", "code", { mysqlExtras: extras })]);
    expect(generateCreateTable(state, "postgres")).not.toContain("COLLATE");
  });
});

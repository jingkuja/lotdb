import { describe, it, expect } from "vitest";
import { generateChangeSql } from "../generate-change-sql";

const base = {
  dbType: "mysql" as const,
  database: "mydb",
  table: "users",
  columns: ["id", "name", "age"],
  pkColumns: ["id"],
  rows: [
    [1, "Alice", 30],
    [2, "Bob", 25],
  ] as unknown[][],
  pendingEdits: {},
  pendingDeletes: new Set<number>(),
  newRows: [],
};

describe("generateChangeSql — UPDATE", () => {
  it("generates UPDATE for single edit", () => {
    const sqls = generateChangeSql({
      ...base,
      pendingEdits: {
        "0:name": { rowIndex: 0, column: "name", originalValue: "Alice", newValue: "Alicia" },
      },
    });
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toMatch(/UPDATE `mydb`\.`users` SET `name` = 'Alicia' WHERE `id` = 1/);
  });

  it("groups multiple edits on the same row into one UPDATE", () => {
    const sqls = generateChangeSql({
      ...base,
      pendingEdits: {
        "0:name": { rowIndex: 0, column: "name", originalValue: "Alice", newValue: "Alicia" },
        "0:age": { rowIndex: 0, column: "age", originalValue: 30, newValue: "31" },
      },
    });
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain("`name` = 'Alicia'");
    expect(sqls[0]).toContain("`age` = '31'");
  });

  it("sets column to NULL when newValue is null", () => {
    const sqls = generateChangeSql({
      ...base,
      pendingEdits: {
        "1:age": { rowIndex: 1, column: "age", originalValue: 25, newValue: null },
      },
    });
    expect(sqls[0]).toContain("`age` = NULL");
  });

  it("skips UPDATE for rows marked as deleted", () => {
    const sqls = generateChangeSql({
      ...base,
      pendingEdits: {
        "0:name": { rowIndex: 0, column: "name", originalValue: "Alice", newValue: "X" },
      },
      pendingDeletes: new Set([0]),
    });
    const updates = sqls.filter((s) => s.startsWith("UPDATE"));
    expect(updates).toHaveLength(0);
  });

  it("skips UPDATE when no PK columns", () => {
    const sqls = generateChangeSql({
      ...base,
      pkColumns: [],
      pendingEdits: {
        "0:name": { rowIndex: 0, column: "name", originalValue: "Alice", newValue: "X" },
      },
    });
    expect(sqls).toHaveLength(0);
  });
});

describe("generateChangeSql — DELETE", () => {
  it("generates DELETE with PK WHERE clause", () => {
    const sqls = generateChangeSql({
      ...base,
      pendingDeletes: new Set([1]),
    });
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toMatch(/DELETE FROM `mydb`\.`users` WHERE `id` = 2/);
  });
});

describe("generateChangeSql — INSERT", () => {
  it("generates INSERT for new rows", () => {
    const sqls = generateChangeSql({
      ...base,
      newRows: [{ id: "3", name: "Carol", age: "28" }],
    });
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toMatch(/INSERT INTO `mydb`\.`users`/);
    expect(sqls[0]).toContain("'Carol'");
    expect(sqls[0]).toContain("'28'");
  });

  it("uses NULL for null new row values", () => {
    const sqls = generateChangeSql({
      ...base,
      newRows: [{ id: "4", name: null, age: null }],
    });
    expect(sqls[0]).toContain("NULL");
  });
});

describe("generateChangeSql — PG quoting", () => {
  it("uses double-quote identifiers for postgres", () => {
    const sqls = generateChangeSql({
      ...base,
      dbType: "postgres",
      pendingEdits: {
        "0:name": { rowIndex: 0, column: "name", originalValue: "Alice", newValue: "X" },
      },
    });
    expect(sqls[0]).toContain('"name"');
    expect(sqls[0]).toContain('"id"');
  });
});

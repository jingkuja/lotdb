import { describe, it, expect } from "vitest";
import { copyAsInsert, copyAsCsv, copyAsJson, copyAsMarkdown } from "../copy-as";

const columns = ["id", "name", "age"];
const rows = [
  [1, "Alice", 30],
  [2, "Bob", null],
];

describe("copyAsInsert", () => {
  it("generates MySQL INSERT with backtick quoting", () => {
    const sql = copyAsInsert("mydb", undefined, "users", columns, rows, "mysql");
    expect(sql).toContain("INSERT INTO `mydb`.`users`");
    expect(sql).toContain("`id`, `name`, `age`");
    expect(sql).toContain("(1, 'Alice', 30)");
    expect(sql).toContain("(2, 'Bob', NULL)");
  });

  it("generates PG INSERT with double-quote quoting", () => {
    const sql = copyAsInsert("mydb", "public", "users", columns, rows, "postgres");
    expect(sql).toContain('INSERT INTO "public"."users"');
    expect(sql).toContain('"id", "name", "age"');
    expect(sql).toContain("(1, 'Alice', 30)");
    expect(sql).toContain("(2, 'Bob', NULL)");
  });

  it("escapes single quotes in string values", () => {
    const sql = copyAsInsert("db", undefined, "t", ["val"], [["it's"]], "mysql");
    expect(sql).toContain("'it''s'");
  });

  it("returns empty string for no rows", () => {
    expect(copyAsInsert("db", undefined, "t", columns, [], "mysql")).toBe("");
  });
});

describe("copyAsCsv", () => {
  it("produces header + data rows", () => {
    const csv = copyAsCsv(columns, rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("id,name,age");
    expect(lines[1]).toBe("1,Alice,30");
    expect(lines[2]).toBe("2,Bob,");
  });

  it("quotes cells containing commas", () => {
    const csv = copyAsCsv(["val"], [["a,b"]]);
    expect(csv).toContain('"a,b"');
  });

  it("quotes cells containing double-quotes and escapes them", () => {
    const csv = copyAsCsv(["val"], [[`say "hi"`]]);
    expect(csv).toContain('"say ""hi"""');
  });
});

describe("copyAsJson", () => {
  it("produces valid JSON array", () => {
    const json = copyAsJson(columns, rows);
    const parsed = JSON.parse(json) as unknown[];
    expect(parsed).toHaveLength(2);
    expect((parsed[0] as Record<string, unknown>)["name"]).toBe("Alice");
    expect((parsed[1] as Record<string, unknown>)["age"]).toBeNull();
  });
});

describe("copyAsMarkdown", () => {
  it("produces header, separator, and data rows", () => {
    const md = copyAsMarkdown(columns, rows);
    const lines = md.split("\n");
    expect(lines[0]).toBe("| id | name | age |");
    expect(lines[1]).toBe("| --- | --- | --- |");
    expect(lines[2]).toBe("| 1 | Alice | 30 |");
    expect(lines[3]).toBe("| 2 | Bob |  |");
  });

  it("escapes pipe characters in cell values", () => {
    const md = copyAsMarkdown(["col"], [["a|b"]]);
    expect(md).toContain("a\\|b");
  });
});

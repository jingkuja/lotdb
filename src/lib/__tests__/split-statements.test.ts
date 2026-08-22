import { describe, expect, it } from "vitest";
import { splitStatements } from "@/lib/split-statements";

describe("splitStatements", () => {
  it("splits simple statements", () => {
    expect(splitStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("handles a missing trailing semicolon", () => {
    expect(splitStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    expect(splitStatements("SELECT 'a;b' AS x; SELECT 2;")).toEqual([
      "SELECT 'a;b' AS x",
      "SELECT 2",
    ]);
  });

  it("handles doubled-quote escapes in strings", () => {
    expect(splitStatements("SELECT 'it''s;fine'; SELECT 2")).toEqual([
      "SELECT 'it''s;fine'",
      "SELECT 2",
    ]);
  });

  it("handles backslash escapes in strings", () => {
    expect(splitStatements("SELECT 'a\\'; still string'; SELECT 2")).toEqual([
      "SELECT 'a\\'; still string'",
      "SELECT 2",
    ]);
  });

  it("ignores semicolons in quoted identifiers", () => {
    expect(splitStatements('SELECT "a;b" AS `c;d`; SELECT 2')).toEqual([
      'SELECT "a;b" AS `c;d`',
      "SELECT 2",
    ]);
  });

  it("ignores semicolons in line comments", () => {
    expect(splitStatements("SELECT 1 -- not; split\n; SELECT 2")).toEqual([
      "SELECT 1 -- not; split",
      "SELECT 2",
    ]);
    expect(splitStatements("SELECT 1 # hash; comment\n; SELECT 2")).toEqual([
      "SELECT 1 # hash; comment",
      "SELECT 2",
    ]);
  });

  it("ignores semicolons in block comments", () => {
    expect(splitStatements("SELECT /* a;b */ 1; SELECT 2")).toEqual([
      "SELECT /* a;b */ 1",
      "SELECT 2",
    ]);
  });

  it("keeps PG dollar-quoted function bodies as one statement", () => {
    const sql = [
      "CREATE FUNCTION f() RETURNS void AS $$",
      "BEGIN",
      "  PERFORM 1; -- inner",
      "  PERFORM 2;",
      "END;",
      "$$ LANGUAGE plpgsql;",
      "SELECT 1;",
    ].join("\n");
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("LANGUAGE plpgsql");
    expect(stmts[1]).toBe("SELECT 1");
  });

  it("supports tagged dollar quotes", () => {
    const sql = "SELECT $body$ a;b $body$ AS x; SELECT 2";
    expect(splitStatements(sql)).toEqual(["SELECT $body$ a;b $body$ AS x", "SELECT 2"]);
  });

  it("drops comment-only fragments", () => {
    expect(splitStatements("-- only a comment\n; SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("returns empty for empty / blank input", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("   \n -- hi\n")).toEqual([]);
  });
});

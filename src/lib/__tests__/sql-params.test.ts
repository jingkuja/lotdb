import { describe, it, expect } from "vitest";
import { detectParams } from "../sql-params";

describe("detectParams", () => {
  it("returns empty for plain SQL", () => {
    const { params, style } = detectParams("SELECT * FROM users WHERE id = 1");
    expect(params).toHaveLength(0);
    expect(style).toBe("none");
  });

  it("detects MySQL positional ? params", () => {
    const { params, style } = detectParams("SELECT * FROM t WHERE a = ? AND b = ?");
    expect(style).toBe("mysql");
    expect(params).toHaveLength(2);
    expect(params[0]).toEqual({ label: "参数 1", index: 0 });
    expect(params[1]).toEqual({ label: "参数 2", index: 1 });
  });

  it("detects PG $N params", () => {
    const { params, style } = detectParams("SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $1");
    expect(style).toBe("postgres");
    // max index is 2, so 2 params
    expect(params).toHaveLength(2);
    expect(params[0]).toEqual({ label: "$1", index: 0 });
    expect(params[1]).toEqual({ label: "$2", index: 1 });
  });

  it("ignores ? inside string literals", () => {
    const { params, style } = detectParams("SELECT '?' FROM t WHERE id = ?");
    expect(style).toBe("mysql");
    expect(params).toHaveLength(1);
  });

  it("ignores $N inside string literals", () => {
    const { params, style } = detectParams("SELECT '$1' FROM t WHERE id = $1");
    expect(style).toBe("postgres");
    expect(params).toHaveLength(1);
  });

  it("ignores params inside -- comments", () => {
    const { params } = detectParams("SELECT * FROM t -- WHERE id = ?\nWHERE id = ?");
    expect(params).toHaveLength(1);
  });

  it("ignores params inside block comments", () => {
    const { params } = detectParams("SELECT /* ? */ * FROM t WHERE id = ?");
    expect(params).toHaveLength(1);
  });

  it("PG takes precedence over ? when both present", () => {
    // $1 found first, ? ignored
    const { style } = detectParams("SELECT $1, ?");
    expect(style).toBe("postgres");
  });
});

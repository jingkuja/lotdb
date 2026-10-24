import { describe, expect, it } from "vitest";
import {
  DbError,
  formatDbError,
  isConnectionError,
  toDbError,
} from "@/lib/error";

describe("backend errors", () => {
  it("turns AppError payloads into DbError", () => {
    const e = toDbError({ code: "connection", message: "连接已断开" });
    expect(e).toBeInstanceOf(DbError);
    expect(isConnectionError(e)).toBe(true);
    // String(e) is what many call sites used to render.
    expect(String(e)).toBe("连接已断开");
    expect(`${e as DbError}`).toBe("连接已断开");
  });

  it("leaves plain rejections alone", () => {
    expect(toDbError("invalid args")).toBe("invalid args");
    expect(formatDbError("invalid args")).toBe("invalid args");
    expect(formatDbError(new Error("boom"))).toBe("boom");
    expect(isConnectionError({ code: "sql", message: "x" })).toBe(false);
  });
});

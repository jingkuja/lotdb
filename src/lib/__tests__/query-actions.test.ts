import { describe, it, expect } from "vitest";
import {
  currentStatement,
  needsWriteConfirmation,
  transactionAction,
} from "../query-actions";
describe("query actions", () => {
  it("executes the cursor statement without splitting quoted semicolons", () => {
    const sql = "SELECT 'a;b';\nSELECT 2;\n";
    expect(currentStatement(sql, 8, "postgres")).toBe("SELECT 'a;b'");
    expect(currentStatement(sql, sql.length, "postgres")).toBe("SELECT 2");
  });
  it("recognizes write paths including comments, CTEs, and ANALYZE", () => {
    for (const sql of [
      "/* header */ UPDATE t SET a=1",
      "WITH x AS (SELECT 1) DELETE FROM t",
      "EXPLAIN ANALYZE DELETE FROM t",
      "CALL mutate()",
      "TRUNCATE t",
    ])
      expect(needsWriteConfirmation(sql)).toBe(true);
    expect(needsWriteConfirmation("-- comment\nSELECT 1")).toBe(false);
    expect(needsWriteConfirmation("ROLLBACK")).toBe(false);
  });
  it("does not mistake rollback to a savepoint for ending the transaction", () => {
    expect(transactionAction("BEGIN")).toBe("begin");
    expect(transactionAction("START TRANSACTION READ ONLY")).toBe("begin");
    expect(transactionAction("ROLLBACK TO SAVEPOINT x")).toBe(null);
    expect(transactionAction("ROLLBACK WORK;")).toBe("end");
  });
});

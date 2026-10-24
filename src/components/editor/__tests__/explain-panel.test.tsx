// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExplainPanel } from "../explain-panel";

afterEach(cleanup);

const pgPlan = [
  {
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "users",
      Alias: "users",
      "Startup Cost": 0,
      "Total Cost": 35.5,
      "Plan Rows": 2550,
      "Plan Width": 4,
      Filter: "(id > 1)",
    },
    "Planning Time": 0.1,
  },
];

it("draws a PostgreSQL plan as a graph and as classic text", () => {
  render(
    <ExplainPanel
      analyzed={false}
      result={{ isText: true, columns: ["QUERY PLAN"], rows: [], plan: pgPlan }}
    />,
  );
  expect(screen.getByText("Seq Scan")).toBeTruthy();
  expect(screen.getByText("on users")).toBeTruthy();
  expect(screen.getByText("100%")).toBeTruthy();
  expect(screen.getByText("(id > 1)")).toBeTruthy();

  fireEvent.click(screen.getByText("文本"));
  expect(screen.getByText("Filter: (id > 1)", { exact: false })).toBeTruthy();
  expect(screen.getByText("Planning Time: 0.100 ms")).toBeTruthy();
});

it("keeps MySQL's table and adds the tree as a graph", () => {
  render(
    <ExplainPanel
      analyzed={false}
      result={{
        isText: false,
        columns: ["id", "type", "table"],
        rows: [["1", "ALL", "t"]],
        tree: "-> Filter: (t.a > 1)  (cost=0.55 rows=2)\n    -> Table scan on t  (cost=0.55 rows=3)",
      }}
    />,
  );
  expect(screen.getByText("Table scan on t")).toBeTruthy();
  fireEvent.click(screen.getByText("表格"));
  expect(screen.getByRole("cell", { name: "ALL" })).toBeTruthy();
});

it("falls back to the plain view when there is no tree", () => {
  render(
    <ExplainPanel
      analyzed={false}
      result={{ isText: false, columns: ["type"], rows: [["ref"]] }}
    />,
  );
  expect(screen.queryByText("图形")).toBeNull();
  expect(screen.getByRole("cell", { name: "ref" })).toBeTruthy();
});

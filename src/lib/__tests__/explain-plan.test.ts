import { describe, it, expect } from "vitest";
import {
  estimateError,
  parseMysqlTree,
  parsePgPlan,
  pgPlanText,
  selfWeight,
  totalWeight,
} from "../explain-plan";

// Trimmed from real `EXPLAIN (FORMAT JSON, ANALYZE)` output of PostgreSQL 18.
const PG_PLAN = [
  {
    Plan: {
      "Node Type": "Hash Join",
      "Join Type": "Left",
      "Startup Cost": 1.09,
      "Total Cost": 2.2,
      "Plan Rows": 4,
      "Plan Width": 40,
      "Actual Startup Time": 0.03,
      "Actual Total Time": 0.05,
      "Actual Rows": 400,
      "Actual Loops": 1,
      "Hash Cond": "(a.id = b.a_id)",
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Parent Relationship": "Outer",
          "Relation Name": "a",
          Schema: "public",
          Alias: "a",
          "Startup Cost": 0,
          "Total Cost": 1.04,
          "Plan Rows": 4,
          "Plan Width": 36,
          "Actual Startup Time": 0.01,
          "Actual Total Time": 0.02,
          "Actual Rows": 4,
          "Actual Loops": 1,
          Filter: "(id > 0)",
          "Rows Removed by Filter": 0,
        },
        {
          "Node Type": "Index Scan",
          "Index Name": "b_pkey",
          "Relation Name": "b",
          Alias: "bb",
          "Startup Cost": 0.1,
          "Total Cost": 0.5,
          "Plan Rows": 1,
          "Plan Width": 8,
          "Actual Loops": 0,
        },
      ],
    },
    "Planning Time": 0.2,
    "Execution Time": 0.1,
  },
];

describe("parsePgPlan", () => {
  it("names nodes like PostgreSQL's text format", () => {
    const plan = parsePgPlan(PG_PLAN)!;
    expect(plan.root.title).toBe("Hash Left Join");
    expect(plan.root.extra).toEqual([["Hash Cond", "(a.id = b.a_id)"]]);
    const [scan, index] = plan.root.children;
    expect(scan!.detail).toBe("on public.a");
    expect(scan!.extra).toEqual([["Filter", "(id > 0)"]]);
    expect(index!.detail).toBe("using b_pkey on b bb");
    expect(index!.neverExecuted).toBe(true);
    expect(plan.executionMs).toBe(0.1);
    expect(parsePgPlan({ nope: 1 })).toBeNull();
  });

  it("rebuilds the text format with indentation and timings", () => {
    const lines = pgPlanText(parsePgPlan(PG_PLAN)!);
    expect(lines[0]).toBe(
      "Hash Left Join  (cost=1.09..2.20 rows=4 width=40) (actual time=0.030..0.050 rows=400 loops=1)",
    );
    expect(lines[1]).toBe("  Hash Cond: (a.id = b.a_id)");
    expect(lines[2]).toMatch(/^ {2}-> {2}Seq Scan on public\.a {2}\(cost=/);
    expect(lines).toContain("      Filter: (id > 0)");
    expect(lines[lines.length - 1]).toBe("Execution Time: 0.100 ms");
  });

  it("weighs nodes by their own time and flags bad estimates", () => {
    const { root } = parsePgPlan(PG_PLAN)!;
    expect(selfWeight(root, true)).toBeCloseTo(0.03);
    expect(totalWeight(root, true)).toBeCloseTo(0.05);
    expect(selfWeight(root, false)).toBeCloseTo(2.2 - 1.04 - 0.5);
    expect(estimateError(root)).toBe(100);
  });
});

describe("parseMysqlTree", () => {
  it("builds the operator tree from indentation", () => {
    const text = [
      "-> Nested loop inner join  (cost=1.15 rows=2) (actual time=0.04..0.05 rows=2 loops=1)",
      "    -> Filter: (t.a > 1)  (cost=0.45 rows=2) (actual time=0.02..0.03 rows=2 loops=1)",
      "        -> Table scan on t  (cost=0.45 rows=2) (actual time=0.02..0.02 rows=3 loops=1)",
      "    -> Single-row index lookup on u using PRIMARY (id=t.uid)  (cost=0.30..0.35 rows=1) (never executed)",
    ].join("\n");
    const { root } = parseMysqlTree(text)!;
    expect(root.title).toBe("Nested loop inner join");
    expect(root.cost).toBe(1.15);
    expect(root.actualMs).toBe(0.05);
    expect(root.children.map((c) => c.title)).toEqual([
      "Filter: (t.a > 1)",
      "Single-row index lookup on u using PRIMARY (id=t.uid)",
    ]);
    expect(root.children[0]!.children[0]!.title).toBe("Table scan on t");
    const lookup = root.children[1]!;
    expect(lookup.cost).toBe(0.35);
    expect(lookup.startupCost).toBe(0.3);
    expect(lookup.neverExecuted).toBe(true);
    expect(parseMysqlTree("id\tselect_type")).toBeNull();
  });
});

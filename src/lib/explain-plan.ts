// Execution plans from PostgreSQL (`EXPLAIN (FORMAT JSON)`) and MySQL
// (`FORMAT=TREE` / `EXPLAIN ANALYZE` text) as one node tree, for the
// graphical plan view; plus PostgreSQL's classic text drawn from the JSON.

export interface PlanNode {
  /** Operation, e.g. "Hash Left Join", "Index Scan", "Table scan on t". */
  title: string;
  /** What it works on: "on users u", "using users_pkey on users". */
  detail?: string;
  /** Estimated total cost, children included. */
  cost?: number;
  startupCost?: number;
  /** Estimated rows (per loop). */
  rows?: number;
  width?: number;
  /** EXPLAIN ANALYZE: rows actually produced (per loop). */
  actualRows?: number;
  /** EXPLAIN ANALYZE: time per loop in ms, children included. */
  actualMs?: number;
  actualStartupMs?: number;
  loops?: number;
  /** ANALYZE ran but this node never executed. */
  neverExecuted?: boolean;
  /** Conditions and counters worth showing ("Filter", "Index Cond", …). */
  extra: [string, string][];
  children: PlanNode[];
}

export interface ParsedPlan {
  root: PlanNode;
  planningMs?: number;
  executionMs?: number;
}

// ─── PostgreSQL JSON ──────────────────────────────────────────────

type Json = Record<string, unknown>;

const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Detail keys shown under a node, in PostgreSQL's text-format order. */
const PG_EXTRA_KEYS = [
  "Hash Cond",
  "Merge Cond",
  "Index Cond",
  "Recheck Cond",
  "Join Filter",
  "Filter",
  "Rows Removed by Join Filter",
  "Rows Removed by Filter",
  "Rows Removed by Index Recheck",
  "Sort Key",
  "Sort Method",
  "Group Key",
  "Presorted Key",
  "Output",
  "Workers Planned",
  "Workers Launched",
  "Heap Fetches",
];

function pgTitle(n: Json): string {
  let type = str(n["Node Type"]) ?? "?";
  const strategy = str(n["Strategy"]);
  if (type === "Aggregate" && strategy) {
    type =
      strategy === "Hashed"
        ? "HashAggregate"
        : strategy === "Sorted"
          ? "GroupAggregate"
          : strategy === "Mixed"
            ? "MixedAggregate"
            : "Aggregate";
  }
  if (type === "SetOp" && strategy === "Hashed") type = "HashSetOp";
  const partial = str(n["Partial Mode"]);
  if (partial && partial !== "Simple") type = `${partial} ${type}`;
  const join = str(n["Join Type"]);
  if (join && join !== "Inner") {
    type =
      type === "Nested Loop"
        ? `Nested Loop ${join} Join`
        : type.replace(/ Join$/, ` ${join} Join`);
  }
  if (str(n["Scan Direction"]) === "Backward") type += " Backward";
  return type;
}

function pgDetail(n: Json): string | undefined {
  const index = str(n["Index Name"]);
  const relation = str(n["Relation Name"]);
  const schema = str(n["Schema"]);
  const alias = str(n["Alias"]);
  const target =
    relation &&
    `${schema ? `${schema}.` : ""}${relation}${alias && alias !== relation ? ` ${alias}` : ""}`;
  const named =
    str(n["CTE Name"]) ?? str(n["Function Name"]) ?? str(n["Subplan Name"]);
  if (index && target) return `using ${index} on ${target}`;
  if (index) return `on ${index}`;
  if (target) return `on ${target}`;
  if (named) return `on ${named}`;
  if (alias && str(n["Node Type"]) === "Subquery Scan") return `on ${alias}`;
  return undefined;
}

function pgExtra(n: Json): [string, string][] {
  const extra: [string, string][] = [];
  for (const key of PG_EXTRA_KEYS) {
    const v = n[key];
    if (v === undefined || v === null) continue;
    if (key === "Rows Removed by Filter" && v === 0) continue;
    extra.push([key, Array.isArray(v) ? v.join(", ") : String(v)]);
  }
  const hit = num(n["Shared Hit Blocks"]);
  const read = num(n["Shared Read Blocks"]);
  if (hit || read)
    extra.push([
      "Buffers",
      `shared hit=${hit ?? 0}${read ? ` read=${read}` : ""}`,
    ]);
  return extra;
}

function pgNode(n: Json): PlanNode {
  const loops = num(n["Actual Loops"]);
  return {
    title: pgTitle(n),
    detail: pgDetail(n),
    cost: num(n["Total Cost"]),
    startupCost: num(n["Startup Cost"]),
    rows: num(n["Plan Rows"]),
    width: num(n["Plan Width"]),
    actualRows: num(n["Actual Rows"]),
    actualMs: num(n["Actual Total Time"]),
    actualStartupMs: num(n["Actual Startup Time"]),
    loops,
    neverExecuted: loops === 0,
    extra: pgExtra(n),
    children: Array.isArray(n["Plans"])
      ? (n["Plans"] as Json[]).map(pgNode)
      : [],
  };
}

/** The plan inside `EXPLAIN (FORMAT JSON)` output, or null if it isn't one. */
export function parsePgPlan(json: unknown): ParsedPlan | null {
  const doc = (Array.isArray(json) ? json[0] : json) as Json | undefined;
  const plan = doc?.["Plan"];
  if (!plan || typeof plan !== "object") return null;
  return {
    root: pgNode(plan as Json),
    planningMs: num(doc["Planning Time"]),
    executionMs: num(doc["Execution Time"]),
  };
}

const fixed = (v: number | undefined) => (v ?? 0).toFixed(2);

/** PostgreSQL's text format, rebuilt from the JSON plan. */
export function pgPlanText(plan: ParsedPlan): string[] {
  const lines: string[] = [];
  const walk = (node: PlanNode, depth: number) => {
    const pad = depth === 0 ? "" : " ".repeat(6 * (depth - 1) + 2) + "->  ";
    let line = `${pad}${node.title}${node.detail ? ` ${node.detail}` : ""}`;
    if (node.cost !== undefined)
      line += `  (cost=${fixed(node.startupCost)}..${fixed(node.cost)} rows=${node.rows ?? 0} width=${node.width ?? 0})`;
    if (node.neverExecuted) line += " (never executed)";
    else if (node.actualMs !== undefined)
      line += ` (actual time=${node.actualStartupMs?.toFixed(3) ?? "0.000"}..${node.actualMs.toFixed(3)} rows=${node.actualRows ?? 0} loops=${node.loops ?? 1})`;
    lines.push(line);
    const detailPad = " ".repeat(depth === 0 ? 2 : 6 * depth);
    for (const [k, v] of node.extra) lines.push(`${detailPad}${k}: ${v}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(plan.root, 0);
  if (plan.planningMs !== undefined)
    lines.push(`Planning Time: ${plan.planningMs.toFixed(3)} ms`);
  if (plan.executionMs !== undefined)
    lines.push(`Execution Time: ${plan.executionMs.toFixed(3)} ms`);
  return lines;
}

// ─── MySQL tree text ──────────────────────────────────────────────

const NUM = String.raw`\d+(?:\.\d+)?(?:e[+-]?\d+)?`;
const MYSQL_ACTUAL = new RegExp(
  String.raw`\s*\(actual time=(${NUM})\.\.(${NUM}) rows=(${NUM}) loops=(\d+)\)\s*$`,
);
const MYSQL_NEVER = /\s*\(never executed\)\s*$/;
const MYSQL_COST = new RegExp(
  String.raw`\s*\((?:cost=(${NUM})(?:\.\.(${NUM}))? )?rows=(${NUM})\)\s*$`,
);

function mysqlNode(text: string): PlanNode {
  const node: PlanNode = { title: "", extra: [], children: [] };
  let rest = text;
  let m = rest.match(MYSQL_ACTUAL);
  if (m) {
    node.actualStartupMs = Number(m[1]);
    node.actualMs = Number(m[2]);
    node.actualRows = Number(m[3]);
    node.loops = Number(m[4]);
    rest = rest.slice(0, m.index);
  } else if ((m = rest.match(MYSQL_NEVER))) {
    node.neverExecuted = true;
    rest = rest.slice(0, m.index);
  }
  m = rest.match(MYSQL_COST);
  if (m) {
    // 8.0 prints cost=total; newer servers cost=first..total.
    if (m[1] !== undefined) node.cost = Number(m[2] ?? m[1]);
    if (m[2] !== undefined) node.startupCost = Number(m[1]);
    node.rows = Number(m[3]);
    rest = rest.slice(0, m.index);
  }
  node.title = rest.trim();
  return node;
}

/** The `-> …` operator tree MySQL 8.0.16+ prints, or null if `text` isn't one. */
export function parseMysqlTree(text: string): ParsedPlan | null {
  const roots: PlanNode[] = [];
  const stack: { indent: number; node: PlanNode }[] = [];
  let last: PlanNode | undefined;
  for (const line of text.split("\n")) {
    const arrow = line.indexOf("->");
    if (arrow < 0 || line.slice(0, arrow).trim() !== "") {
      // A wrapped condition continues the previous operator's text.
      if (last && line.trim()) last.title += ` ${line.trim()}`;
      continue;
    }
    const node = mysqlNode(line.slice(arrow + 2));
    while (stack.length && stack[stack.length - 1]!.indent >= arrow)
      stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    stack.push({ indent: arrow, node });
    last = node;
  }
  if (roots.length === 0) return null;
  const root =
    roots.length === 1
      ? roots[0]!
      : { title: "Query", extra: [], children: roots };
  return { root };
}

// ─── Weighing nodes ───────────────────────────────────────────────

/**
 * What a node costs by itself: actual time across all loops when the plan
 * was executed, otherwise estimated cost, minus what its children account for.
 */
export function selfWeight(node: PlanNode, analyzed: boolean): number {
  const total = (n: PlanNode) =>
    analyzed ? (n.actualMs ?? 0) * (n.loops ?? 1) : (n.cost ?? 0);
  const own = total(node) - node.children.reduce((sum, c) => sum + total(c), 0);
  return Math.max(0, own);
}

/** Sum of selfWeight over the whole tree. */
export function totalWeight(node: PlanNode, analyzed: boolean): number {
  return (
    selfWeight(node, analyzed) +
    node.children.reduce((sum, c) => sum + totalWeight(c, analyzed), 0)
  );
}

/** How far the row estimate was off (≥ 1), when the plan was executed. */
export function estimateError(node: PlanNode): number | undefined {
  if (node.actualRows === undefined || node.rows === undefined) return;
  const est = Math.max(node.rows, 1);
  const act = Math.max(node.actualRows, 1);
  return Math.max(est / act, act / est);
}

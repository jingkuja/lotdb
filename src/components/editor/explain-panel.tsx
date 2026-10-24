import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExplainResult } from "@/services/tauri-commands";
import {
  estimateError,
  parseMysqlTree,
  parsePgPlan,
  pgPlanText,
  selfWeight,
  totalWeight,
  type ParsedPlan,
  type PlanNode,
} from "@/lib/explain-plan";

// ─── MySQL access-type color coding ───────────────────────────────
// Best → worst: system/const > eq_ref > ref > range > index > ALL

const ACCESS_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  system: { bg: "bg-green-500/15", text: "text-green-700 dark:text-green-400" },
  const: { bg: "bg-green-500/15", text: "text-green-700 dark:text-green-400" },
  eq_ref: {
    bg: "bg-emerald-500/15",
    text: "text-emerald-700 dark:text-emerald-400",
  },
  ref: { bg: "bg-blue-500/15", text: "text-blue-700 dark:text-blue-400" },
  fulltext: { bg: "bg-blue-500/15", text: "text-blue-700 dark:text-blue-400" },
  ref_or_null: {
    bg: "bg-blue-500/15",
    text: "text-blue-700 dark:text-blue-400",
  },
  index_merge: { bg: "bg-sky-500/15", text: "text-sky-700 dark:text-sky-400" },
  unique_subquery: {
    bg: "bg-yellow-500/15",
    text: "text-yellow-700 dark:text-yellow-500",
  },
  index_subquery: {
    bg: "bg-yellow-500/15",
    text: "text-yellow-700 dark:text-yellow-500",
  },
  range: {
    bg: "bg-yellow-500/15",
    text: "text-yellow-700 dark:text-yellow-500",
  },
  index: {
    bg: "bg-orange-500/15",
    text: "text-orange-700 dark:text-orange-400",
  },
  ALL: { bg: "bg-red-500/15", text: "text-red-700 dark:text-red-400" },
};

// ─── PG node-type keywords ────────────────────────────────────────

const PG_NODE_KEYWORDS = [
  "Seq Scan",
  "Index Scan",
  "Index Only Scan",
  "Bitmap Index Scan",
  "Bitmap Heap Scan",
  "Hash Join",
  "Merge Join",
  "Nested Loop",
  "Hash",
  "Sort",
  "Aggregate",
  "Group",
  "Gather",
  "Gather Merge",
  "Limit",
  "Append",
  "Materialize",
  "Subquery Scan",
  "Result",
  "WindowAgg",
  "Unique",
  "SetOp",
  "LockRows",
  "ModifyTable",
  "CTE Scan",
  "Function Scan",
  "Values Scan",
];

const PG_NODE_RE = new RegExp(
  `(${PG_NODE_KEYWORDS.map((k) => k.replace(/\s+/g, "\\s+")).join("|")})`,
  "g",
);

// Highlight cost=X..Y rows=Z and actual time=A..B
function highlightPgLine(line: string): React.ReactNode {
  // Split by patterns we want to highlight
  const parts: { text: string; kind: "plain" | "node" | "cost" | "actual" }[] =
    [];

  let remaining = line;

  // Replace node types
  remaining = remaining.replace(PG_NODE_RE, "\x00NODE\x00$1\x00");

  // Replace cost=...
  remaining = remaining.replace(
    /\(cost=[\d.]+\.\.[\d.]+ rows=\d+ width=\d+\)/g,
    (m) => `\x00COST\x00${m}\x00`,
  );

  // Replace actual time=...
  remaining = remaining.replace(
    /\(actual time=[\d.]+\.\.[\d.]+ rows=\d+ loops=\d+\)/g,
    (m) => `\x00ACTUAL\x00${m}\x00`,
  );

  const tokens = remaining.split("\x00");
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === "NODE") {
      parts.push({ text: tokens[i + 1] ?? "", kind: "node" });
      i += 2;
    } else if (tok === "COST") {
      parts.push({ text: tokens[i + 1] ?? "", kind: "cost" });
      i += 2;
    } else if (tok === "ACTUAL") {
      parts.push({ text: tokens[i + 1] ?? "", kind: "actual" });
      i += 2;
    } else {
      if (tok) parts.push({ text: tok, kind: "plain" });
      i += 1;
    }
  }

  return parts.map((p, idx) => {
    if (p.kind === "plain") return <span key={idx}>{p.text}</span>;
    if (p.kind === "node")
      return (
        <span key={idx} className="font-semibold text-primary">
          {p.text}
        </span>
      );
    if (p.kind === "cost")
      return (
        <span key={idx} className="text-muted-foreground">
          {p.text}
        </span>
      );
    if (p.kind === "actual")
      return (
        <span key={idx} className="text-green-600 dark:text-green-400">
          {p.text}
        </span>
      );
    return <span key={idx}>{p.text}</span>;
  });
}

// ─── Text / tree view (PG + MySQL ANALYZE) ───────────────────────

function TextExplainView({ lines }: { lines: string[] }) {
  return (
    <div className="flex-1 overflow-auto p-4">
      <pre className="font-mono text-xs leading-5 whitespace-pre-wrap">
        {lines.map((line, i) => (
          <div key={i} className="hover:bg-muted/30">
            {highlightPgLine(line)}
          </div>
        ))}
      </pre>
    </div>
  );
}

// ─── Tabular view (MySQL EXPLAIN) ─────────────────────────────────

function TableExplainView({
  columns,
  rows,
}: {
  columns: string[];
  rows: (string | null)[][];
}) {
  const typeIdx = columns.findIndex((c) => c.toLowerCase() === "type");

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-left">
        <thead className="sticky top-0 border-b border-border bg-muted/80 backdrop-blur-sm">
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                className="px-3 py-2 text-[11px] font-semibold whitespace-nowrap text-muted-foreground"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr
              key={ri}
              className="border-b border-border/50 hover:bg-muted/30"
            >
              {row.map((cell, ci) => {
                const isType = ci === typeIdx;
                const style =
                  isType && cell ? ACCESS_TYPE_COLORS[cell] : undefined;
                return (
                  <td
                    key={ci}
                    className={cn(
                      "max-w-[220px] truncate px-3 py-1.5 text-xs",
                      cell === null && "text-muted-foreground/40 italic",
                    )}
                    title={cell ?? "NULL"}
                  >
                    {isType && cell && style ? (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 font-mono font-medium",
                          style.bg,
                          style.text,
                        )}
                      >
                        {cell}
                      </span>
                    ) : (
                      (cell ?? "NULL")
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Access type legend */}
      {typeIdx >= 0 && (
        <div className="border-t border-border px-4 py-2">
          <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">
            访问类型（好 → 差）
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(["const", "eq_ref", "ref", "range", "index", "ALL"] as const).map(
              (t) => {
                const s = ACCESS_TYPE_COLORS[t]!;
                return (
                  <span
                    key={t}
                    className={cn(
                      "rounded px-1.5 py-0.5 font-mono text-[10px] font-medium",
                      s.bg,
                      s.text,
                    )}
                  >
                    {t}
                  </span>
                );
              },
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Graph view ───────────────────────────────────────────────────

function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 10) return `${ms.toFixed(0)} ms`;
  return `${ms.toFixed(2)} ms`;
}

function PlanNodeCard({
  node,
  analyzed,
  total,
  depth,
}: {
  node: PlanNode;
  analyzed: boolean;
  total: number;
  depth: number;
}) {
  const [open, setOpen] = useState(true);
  const share = total > 0 ? selfWeight(node, analyzed) / total : 0;
  const error = estimateError(node);
  const heavy = share >= 0.3;
  const notable = share >= 0.1;
  const scan = /seq scan|table scan|full scan/i.test(node.title);

  return (
    <li className="relative">
      {/* Connector to the parent */}
      {depth > 0 && (
        <span className="absolute -left-4 top-0 h-5 w-4 rounded-bl border-b border-l border-border" />
      )}
      <div
        className={cn(
          "relative inline-flex min-w-72 max-w-full flex-col gap-1 rounded-md border bg-background px-2.5 py-1.5 text-xs shadow-xs",
          heavy
            ? "border-red-500/60"
            : notable
              ? "border-amber-500/60"
              : "border-border",
          node.neverExecuted && "opacity-50",
        )}
      >
        <div className="flex items-center gap-1.5">
          {node.children.length > 0 ? (
            <button
              className="-ml-1 rounded p-0.5 text-muted-foreground hover:bg-muted"
              title={open ? "折叠子节点" : "展开子节点"}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
            </button>
          ) : null}
          <span
            className={cn(
              "font-semibold",
              scan ? "text-orange-600 dark:text-orange-400" : "text-primary",
            )}
          >
            {node.title}
          </span>
          {node.detail && (
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {node.detail}
            </span>
          )}
          <span
            className={cn(
              "ml-auto shrink-0 rounded px-1.5 font-mono text-[10px] tabular-nums",
              heavy
                ? "bg-red-500/15 text-red-700 dark:text-red-400"
                : notable
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                  : "bg-muted text-muted-foreground",
            )}
            title={
              analyzed ? "本节点自身耗时占比" : "本节点自身成本占比（估算）"
            }
          >
            {(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              heavy ? "bg-red-500" : notable ? "bg-amber-500" : "bg-primary/50",
            )}
            style={{ width: `${Math.max(share * 100, 1)}%` }}
          />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground tabular-nums">
          {node.cost !== undefined && (
            <span>成本 {formatCount(node.cost)}</span>
          )}
          {node.rows !== undefined && (
            <span>估算 {formatCount(node.rows)} 行</span>
          )}
          {node.neverExecuted ? (
            <span>未执行</span>
          ) : (
            <>
              {node.actualRows !== undefined && (
                <span className="text-foreground">
                  实际 {formatCount(node.actualRows)} 行
                </span>
              )}
              {node.actualMs !== undefined && (
                <span className="text-foreground">
                  {formatMs(node.actualMs)}
                  {node.loops && node.loops > 1 ? ` × ${node.loops} 次` : ""}
                </span>
              )}
            </>
          )}
          {error !== undefined && error >= 10 && (
            <span
              className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400"
              title="估算行数与实际相差较大，统计信息可能过期（可执行 ANALYZE）"
            >
              <TriangleAlert className="size-3" />
              估算偏差 ×{formatCount(error)}
            </span>
          )}
        </div>
        {node.extra.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[10px] leading-4">
            {node.extra.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {open && node.children.length > 0 && (
        <ul className="ml-4 mt-2 flex flex-col gap-2 border-l border-border pl-4">
          {node.children.map((child, i) => (
            <PlanNodeCard
              key={i}
              node={child}
              analyzed={analyzed}
              total={total}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function GraphExplainView({
  plan,
  analyzed,
}: {
  plan: ParsedPlan;
  analyzed: boolean;
}) {
  const total = totalWeight(plan.root, analyzed);
  return (
    <div className="flex-1 overflow-auto p-4">
      {(plan.planningMs !== undefined || plan.executionMs !== undefined) && (
        <p className="mb-3 text-xs text-muted-foreground">
          {plan.planningMs !== undefined && `规划 ${formatMs(plan.planningMs)}`}
          {plan.planningMs !== undefined &&
            plan.executionMs !== undefined &&
            " · "}
          {plan.executionMs !== undefined &&
            `执行 ${formatMs(plan.executionMs)}`}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        <PlanNodeCard
          node={plan.root}
          analyzed={analyzed}
          total={total}
          depth={0}
        />
      </ul>
      <p className="mt-4 text-[11px] text-muted-foreground">
        百分比为节点自身（不含子节点）{analyzed ? "实际耗时" : "估算成本"}
        占整个计划的比例；红色 ≥ 30%，黄色 ≥ 10%。橙色标题为全表扫描。
      </p>
    </div>
  );
}

// ─── ExplainPanel ─────────────────────────────────────────────────

interface ExplainPanelProps {
  result: ExplainResult;
  analyzed: boolean;
}

export function ExplainPanel({ result, analyzed }: ExplainPanelProps) {
  const plan = useMemo(
    () =>
      result.plan !== undefined
        ? parsePgPlan(result.plan)
        : result.tree
          ? parseMysqlTree(result.tree)
          : null,
    [result],
  );
  const [view, setView] = useState<"graph" | "text">("graph");
  const shown = plan ? view : "text";
  const textLines = useMemo(
    () =>
      result.plan !== undefined && plan
        ? pgPlanText(plan)
        : result.rows.map((r) => r[0] ?? ""),
    [result, plan],
  );
  // MySQL actual times exist only with ANALYZE; PG's too.
  const timed = analyzed && plan?.root.actualMs !== undefined;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {analyzed ? "EXPLAIN ANALYZE" : "EXPLAIN"}
        </span>
        {!plan && (
          <>
            <span>·</span>
            <span>{result.rows.length} 行</span>
          </>
        )}
        {plan && (
          <div className="ml-auto flex rounded-md border border-border p-0.5">
            {(
              [
                ["graph", "图形"],
                ["text", result.isText ? "文本" : "表格"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px]",
                  shown === value
                    ? "bg-primary/15 font-medium text-primary"
                    : "hover:bg-muted",
                )}
                onClick={() => setView(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {shown === "graph" && plan ? (
        <GraphExplainView plan={plan} analyzed={timed} />
      ) : result.isText ? (
        <TextExplainView lines={textLines} />
      ) : (
        <TableExplainView columns={result.columns} rows={result.rows} />
      )}
    </div>
  );
}

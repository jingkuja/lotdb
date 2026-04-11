import { cn } from "@/lib/utils";
import type { ExplainResult } from "@/services/tauri-commands";

// ─── MySQL access-type color coding ───────────────────────────────
// Best → worst: system/const > eq_ref > ref > range > index > ALL

const ACCESS_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  system:           { bg: "bg-green-500/15",  text: "text-green-700 dark:text-green-400" },
  const:            { bg: "bg-green-500/15",  text: "text-green-700 dark:text-green-400" },
  eq_ref:           { bg: "bg-emerald-500/15", text: "text-emerald-700 dark:text-emerald-400" },
  ref:              { bg: "bg-blue-500/15",   text: "text-blue-700 dark:text-blue-400" },
  fulltext:         { bg: "bg-blue-500/15",   text: "text-blue-700 dark:text-blue-400" },
  ref_or_null:      { bg: "bg-blue-500/15",   text: "text-blue-700 dark:text-blue-400" },
  index_merge:      { bg: "bg-sky-500/15",    text: "text-sky-700 dark:text-sky-400" },
  unique_subquery:  { bg: "bg-yellow-500/15", text: "text-yellow-700 dark:text-yellow-500" },
  index_subquery:   { bg: "bg-yellow-500/15", text: "text-yellow-700 dark:text-yellow-500" },
  range:            { bg: "bg-yellow-500/15", text: "text-yellow-700 dark:text-yellow-500" },
  index:            { bg: "bg-orange-500/15", text: "text-orange-700 dark:text-orange-400" },
  ALL:              { bg: "bg-red-500/15",    text: "text-red-700 dark:text-red-400" },
};

// ─── PG node-type keywords ────────────────────────────────────────

const PG_NODE_KEYWORDS = [
  "Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Index Scan",
  "Bitmap Heap Scan", "Hash Join", "Merge Join", "Nested Loop",
  "Hash", "Sort", "Aggregate", "Group", "Gather", "Gather Merge",
  "Limit", "Append", "Materialize", "Subquery Scan", "Result",
  "WindowAgg", "Unique", "SetOp", "LockRows", "ModifyTable",
  "CTE Scan", "Function Scan", "Values Scan",
];

const PG_NODE_RE = new RegExp(
  `(${PG_NODE_KEYWORDS.map((k) => k.replace(/\s+/g, "\\s+")).join("|")})`,
  "g",
);

// Highlight cost=X..Y rows=Z and actual time=A..B
function highlightPgLine(line: string): React.ReactNode {
  // Split by patterns we want to highlight
  const parts: { text: string; kind: "plain" | "node" | "cost" | "actual" }[] = [];

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

function TextExplainView({ rows }: { rows: (string | null)[][] }) {
  const lines = rows.map((r) => r[0] ?? "");
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
            <tr key={ri} className="border-b border-border/50 hover:bg-muted/30">
              {row.map((cell, ci) => {
                const isType = ci === typeIdx;
                const style = isType && cell ? ACCESS_TYPE_COLORS[cell] : undefined;
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
                      cell ?? "NULL"
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

// ─── ExplainPanel ─────────────────────────────────────────────────

interface ExplainPanelProps {
  result: ExplainResult;
  analyzed: boolean;
}

export function ExplainPanel({ result, analyzed }: ExplainPanelProps) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {analyzed ? "EXPLAIN ANALYZE" : "EXPLAIN"}
        </span>
        <span>·</span>
        <span>{result.rows.length} 行</span>
        {!result.isText && (
          <>
            <span>·</span>
            <span>点击列头可排序</span>
          </>
        )}
      </div>

      {result.isText ? (
        <TextExplainView rows={result.rows} />
      ) : (
        <TableExplainView columns={result.columns} rows={result.rows} />
      )}
    </div>
  );
}

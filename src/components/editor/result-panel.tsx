import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  Table2,
  TriangleAlert,
  Ban,
  Unplug,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { QueryResult } from "@/services/tauri-commands";

/** One statement's outcome inside a multi-statement run. */
export interface MultiStmtOutcome {
  sql: string;
  status: "pending" | "running" | "success" | "error" | "skipped";
  result?: QueryResult;
  message?: string;
  /** Reconnect handler for connection-class failures. */
  onReconnect?: () => void;
}

type ResultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string; onReconnect?: () => void }
  | { status: "success"; result: QueryResult }
  | { status: "multi"; runId: string; outcomes: MultiStmtOutcome[] };

interface ResultPanelProps {
  state: ResultState;
}

export function ResultPanel({ state }: ResultPanelProps) {
  if (state.status === "idle") {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
        <Table2 className="size-4 opacity-40" />
        <span>运行查询后结果将在此显示</span>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span>执行中...</span>
      </div>
    );
  }

  if (state.status === "error") {
    return <ErrorView message={state.message} onReconnect={state.onReconnect} />;
  }

  if (state.status === "multi") {
    return <MultiResultView runId={state.runId} outcomes={state.outcomes} />;
  }

  return <SingleResultView result={state.result} />;
}

// ─── Single result ────────────────────────────────────────────────

function ErrorView({
  message,
  onReconnect,
}: {
  message: string;
  onReconnect?: () => void;
}) {
  const [reconnecting, setReconnecting] = useState(false);
  return (
    <div className="flex flex-1 flex-col gap-2 p-4">
      <div className="flex items-center gap-2 text-destructive">
        <AlertCircle className="size-4 shrink-0" />
        <span className="text-sm font-medium">
          {onReconnect ? "连接已断开" : "执行失败"}
        </span>
      </div>
      <pre className="whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-xs text-destructive">
        {message}
      </pre>
      {onReconnect && (
        <div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={reconnecting}
            onClick={async () => {
              setReconnecting(true);
              try {
                await onReconnect();
              } finally {
                setReconnecting(false);
              }
            }}
          >
            {reconnecting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Unplug className="size-3" />
            )}
            重新连接
          </Button>
        </div>
      )}
    </div>
  );
}

function SingleResultView({ result }: { result: QueryResult }) {
  // Non-SELECT (INSERT / UPDATE / DELETE / DDL)
  if (result.columns.length === 0) {
    return (
      <div className="flex flex-1 items-center gap-2 p-4 text-sm text-green-600 dark:text-green-400">
        <CheckCircle2 className="size-4 shrink-0" />
        <span>
          执行成功，影响 {result.affectedRows} 行 · {result.executionMs} ms
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Status bar */}
      <div className="flex items-center gap-3 border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
          <CheckCircle2 className="size-3" />
          {result.rows.length} 行
        </span>
        {result.truncated && (
          <span
            className="flex items-center gap-1 text-amber-600 dark:text-amber-400"
            title="结果超出上限，仅加载前 N 行。可在 偏好设置 → 行为 → 查询结果行数上限 中调整。"
          >
            <TriangleAlert className="size-3" />
            已截断，仅显示前 {result.rows.length} 行
          </span>
        )}
        <span>{result.executionMs} ms</span>
        <span>{result.columns.length} 列</span>
      </div>

      <ResultGrid result={result} />
    </div>
  );
}

function ResultGrid({ result }: { result: QueryResult }) {
  return (
    <ScrollArea className="flex-1">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/60">
              {/* Row number column */}
              <th className="sticky left-0 top-0 w-10 bg-muted/80 px-2 py-1.5 text-right font-mono text-[10px] text-muted-foreground">
                #
              </th>
              {result.columns.map((col) => (
                <th
                  key={col}
                  className="sticky top-0 whitespace-nowrap bg-muted/80 px-3 py-1.5 text-left font-medium backdrop-blur"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, ri) => (
              <tr
                key={ri}
                className={cn(
                  "border-b border-border/40 hover:bg-muted/30",
                  ri % 2 === 1 && "bg-muted/10",
                )}
              >
                <td className="px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">
                  {ri + 1}
                </td>
                {(row as unknown[]).map((cell, ci) => (
                  <td
                    key={ci}
                    className="max-w-xs truncate whitespace-nowrap px-3 py-1 font-mono"
                  >
                    {cell === null ? (
                      <span className="italic text-muted-foreground/60">
                        NULL
                      </span>
                    ) : (
                      String(cell)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ScrollArea>
  );
}

// ─── Multi-statement results ──────────────────────────────────────

function MultiResultView({
  runId,
  outcomes,
}: {
  runId: string;
  outcomes: MultiStmtOutcome[];
}) {
  // Manual tab selection, scoped to the current run (auto-follows the
  // running / failed statement until the user picks a tab).
  const [manualSel, setManualSel] = useState<{ runId: string; index: number } | null>(
    null,
  );
  const manual = manualSel?.runId === runId ? manualSel.index : null;

  const runningIdx = outcomes.findIndex((o) => o.status === "running");
  const errorIdx = outcomes.findIndex((o) => o.status === "error");
  const auto =
    runningIdx >= 0 ? runningIdx : errorIdx >= 0 ? errorIdx : outcomes.length - 1;
  const shown = outcomes[manual ?? auto] ?? outcomes[outcomes.length - 1]!;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Result set tabs */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {outcomes.map((o, i) => {
          const active = (manual ?? auto) === i;
          return (
            <button
              key={i}
              onClick={() => setManualSel({ runId, index: i })}
              title={o.sql.length > 120 ? `${o.sql.slice(0, 120)}…` : o.sql}
              className={cn(
                "flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px]",
                active
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-muted",
                o.status === "error" && "text-destructive",
              )}
            >
              结果 {i + 1}
              {o.status === "running" && <Loader2 className="size-3 animate-spin" />}
              {o.status === "success" && o.result && o.result.columns.length > 0 && (
                <span className="text-[10px] opacity-70">{o.result.rows.length}行</span>
              )}
              {o.status === "success" && o.result && o.result.columns.length === 0 && (
                <span className="text-[10px] opacity-70">影响{o.result.affectedRows}行</span>
              )}
              {o.status === "error" && <AlertCircle className="size-3" />}
              {o.status === "skipped" && <Ban className="size-3 opacity-60" />}
            </button>
          );
        })}
      </div>

      {/* Selected outcome body */}
      <div className="flex min-h-0 flex-1 flex-col">
        {shown.status === "running" && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="max-w-2xl truncate font-mono text-xs">{shown.sql}</span>
          </div>
        )}
        {shown.status === "pending" && (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Ban className="size-3.5" />
            等待执行
          </div>
        )}
        {shown.status === "skipped" && (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Ban className="size-3.5" />
            已跳过（前序语句失败或已取消）
          </div>
        )}
        {shown.status === "error" && (
          <ErrorView message={shown.message ?? "执行失败"} onReconnect={shown.onReconnect} />
        )}
        {shown.status === "success" && shown.result && (
          <SingleResultView result={shown.result} />
        )}
      </div>
    </div>
  );
}

export type { ResultState };

import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, AlertCircle, CheckCircle2, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QueryResult } from "@/services/tauri-commands";

type ResultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; result: QueryResult };

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
    return (
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span className="text-sm font-medium">执行失败</span>
        </div>
        <pre className="whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-xs text-destructive">
          {state.message}
        </pre>
      </div>
    );
  }

  const { result } = state;

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
        <span>{result.executionMs} ms</span>
        <span>{result.columns.length} 列</span>
      </div>

      {/* Data grid */}
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
    </div>
  );
}

export type { ResultState };

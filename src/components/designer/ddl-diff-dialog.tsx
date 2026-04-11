import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { generateCreateTable } from "@/lib/generate-ddl";
import { diffLines, buildHunks } from "@/lib/line-diff";
import type { DesignerState } from "@/types/designer";
import type { DatabaseType } from "@/types/database";

interface DdlDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  originalState: DesignerState;
  currentState: DesignerState;
  dbType: DatabaseType;
  schema?: string;
}

export function DdlDiffDialog({
  open,
  onOpenChange,
  originalState,
  currentState,
  dbType,
  schema,
}: DdlDiffDialogProps) {
  const { hunks, addCount, removeCount } = useMemo(() => {
    const leftSql = generateCreateTable(originalState, dbType, schema);
    const rightSql = generateCreateTable(currentState, dbType, schema);
    const lines = diffLines(leftSql, rightSql);
    const hunks = buildHunks(lines, 3);
    const addCount = lines.filter((l) => l.kind === "added").length;
    const removeCount = lines.filter((l) => l.kind === "removed").length;
    return { hunks, addCount, removeCount };
  }, [originalState, currentState, dbType, schema]);

  const noChanges = addCount === 0 && removeCount === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[800px] max-w-[95vw] flex-col gap-0 p-0">
        <DialogHeader className="flex-row items-center gap-3 border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">
            DDL 对比 — {"`"}{originalState.tableName || "?"}{"`"}
          </DialogTitle>

          {/* Stats */}
          {!noChanges && (
            <div className="flex items-center gap-2 text-xs">
              {addCount > 0 && (
                <span className="rounded bg-green-500/15 px-1.5 py-0.5 font-mono text-green-600 dark:text-green-400">
                  +{addCount}
                </span>
              )}
              {removeCount > 0 && (
                <span className="rounded bg-red-500/15 px-1.5 py-0.5 font-mono text-red-600 dark:text-red-400">
                  -{removeCount}
                </span>
              )}
            </div>
          )}

          <div className="ml-auto flex items-center gap-4 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block size-2.5 rounded-sm bg-red-500/20" />
              原始
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block size-2.5 rounded-sm bg-green-500/20" />
              修改后
            </span>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          {noChanges ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              DDL 无变化
            </div>
          ) : (
            <div className="font-mono text-xs">
              {hunks.map((hunk, hi) => (
                <div key={hi}>
                  {/* Hunk separator */}
                  {hi > 0 && (
                    <div className="border-y border-border/50 bg-muted/40 px-4 py-0.5 text-[10px] text-muted-foreground">
                      ···
                    </div>
                  )}
                  {hunk.lines.map((line, li) => (
                    <DiffLineRow key={li} line={line} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Single diff line row ─────────────────────────────────────────

import type { DiffLine } from "@/lib/line-diff";

function DiffLineRow({ line }: { line: DiffLine }) {
  const isAdded = line.kind === "added";
  const isRemoved = line.kind === "removed";

  const prefix = isAdded ? "+" : isRemoved ? "-" : " ";

  const leftNo = line.leftNo != null ? String(line.leftNo) : "";
  const rightNo = line.rightNo != null ? String(line.rightNo) : "";

  return (
    <div
      className={cn(
        "flex min-w-0 items-stretch leading-5",
        isAdded && "bg-green-500/10",
        isRemoved && "bg-red-500/10",
      )}
    >
      {/* Left line number */}
      <span className="w-10 shrink-0 select-none border-r border-border/40 pr-1.5 text-right text-[10px] text-muted-foreground/50">
        {leftNo}
      </span>
      {/* Right line number */}
      <span className="w-10 shrink-0 select-none border-r border-border/40 pr-1.5 text-right text-[10px] text-muted-foreground/50">
        {rightNo}
      </span>
      {/* +/- prefix */}
      <span
        className={cn(
          "w-5 shrink-0 select-none text-center",
          isAdded && "text-green-600 dark:text-green-400",
          isRemoved && "text-red-600 dark:text-red-400",
        )}
      >
        {prefix}
      </span>
      {/* Content */}
      <span
        className={cn(
          "min-w-0 flex-1 whitespace-pre px-1",
          isAdded && "text-green-700 dark:text-green-300",
          isRemoved && "text-red-700 dark:text-red-300",
        )}
      >
        {line.text || "\u00a0"}
      </span>
    </div>
  );
}

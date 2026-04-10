import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CheckCircle2,
  XCircle,
  Trash2,
  History,
  Loader2,
  Copy,
  CornerDownLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useHistory, useDeleteHistory, useClearHistory } from "@/hooks/use-history";
import type { HistoryEntry } from "@/services/tauri-commands";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** If set, only show history for this connection */
  connectionId?: string;
  /** Called when the user clicks "插入" on an entry */
  onInsert: (sql: string) => void;
  /** Called when the user clicks "执行" on an entry */
  onExecute: (sql: string) => void;
}

function relativeTime(isoStr: string): string {
  const ts = new Date(isoStr + "Z").getTime(); // SQLite stores UTC without Z
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  return new Date(isoStr).toLocaleDateString("zh-CN");
}

function SqlPreview({ sql }: { sql: string }) {
  // Show first line(s), truncate at 120 chars
  const preview = sql.replace(/\s+/g, " ").trim().slice(0, 140);
  return (
    <span className="block truncate font-mono text-[11px] text-foreground">
      {preview}
      {sql.length > 140 && "…"}
    </span>
  );
}

function EntryRow({
  entry,
  onInsert,
  onExecute,
  onDelete,
}: {
  entry: HistoryEntry;
  onInsert: (sql: string) => void;
  onExecute: (sql: string) => void;
  onDelete: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="group flex items-start gap-2 border-b border-border/50 px-3 py-2 hover:bg-muted/40"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Status icon */}
      <span className="mt-0.5 shrink-0">
        {entry.status === "success" ? (
          <CheckCircle2 className="size-3.5 text-green-500" />
        ) : (
          <XCircle className="size-3.5 text-destructive" />
        )}
      </span>

      {/* SQL + meta */}
      <div className="min-w-0 flex-1">
        <SqlPreview sql={entry.sql} />
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{relativeTime(entry.executedAt)}</span>
          {entry.executionMs != null && (
            <span>{entry.executionMs} ms</span>
          )}
          {entry.status === "success" && entry.rowsAffected != null && (
            <span>{entry.rowsAffected} 行</span>
          )}
          {entry.status === "error" && entry.errorMessage && (
            <span className="truncate text-destructive" title={entry.errorMessage}>
              {entry.errorMessage.slice(0, 60)}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons — visible on hover */}
      <div
        className={cn(
          "flex shrink-0 gap-0.5 transition-opacity",
          hovered ? "opacity-100" : "opacity-0",
        )}
      >
        <button
          className="rounded p-1 hover:bg-accent"
          title="插入到编辑器"
          onClick={() => onInsert(entry.sql)}
        >
          <Copy className="size-3" />
        </button>
        <button
          className="rounded p-1 hover:bg-accent"
          title="插入并立即执行"
          onClick={() => onExecute(entry.sql)}
        >
          <CornerDownLeft className="size-3" />
        </button>
        <button
          className="rounded p-1 hover:bg-destructive/20 hover:text-destructive"
          title="删除此条记录"
          onClick={() => onDelete(entry.id)}
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </div>
  );
}

export function HistoryDialog({
  open,
  onOpenChange,
  connectionId,
  onInsert,
  onExecute,
}: Props) {
  const { data: entries = [], isLoading } = useHistory(
    open ? connectionId : undefined,
  );
  const deleteMutation = useDeleteHistory();
  const clearMutation = useClearHistory();

  const handleInsert = (sql: string) => {
    onInsert(sql);
    onOpenChange(false);
  };

  const handleExecute = (sql: string) => {
    onExecute(sql);
    onOpenChange(false);
  };

  const handleClear = () => {
    clearMutation.mutate(connectionId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[620px] flex-col gap-0 p-0 sm:max-w-[640px]">
        <DialogHeader className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <History className="size-4" />
            执行历史
          </DialogTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-muted-foreground hover:text-destructive"
            onClick={handleClear}
            disabled={entries.length === 0 || clearMutation.isPending}
          >
            <Trash2 className="size-3" />
            清空
          </Button>
        </DialogHeader>

        <ScrollArea className="flex-1">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              加载中...
            </div>
          )}

          {!isLoading && entries.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <History className="size-8 opacity-30" />
              <p className="text-sm">暂无执行历史</p>
            </div>
          )}

          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onInsert={handleInsert}
              onExecute={handleExecute}
              onDelete={(id) => deleteMutation.mutate(id)}
            />
          ))}
        </ScrollArea>

        {entries.length > 0 && (
          <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            {entries.length} 条记录 · 点击
            <Copy className="mx-1 inline size-3" />
            插入编辑器，点击
            <CornerDownLeft className="mx-1 inline size-3" />
            直接执行
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

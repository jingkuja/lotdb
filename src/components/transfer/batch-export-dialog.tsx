import { useState, useEffect, useRef, useCallback } from "react";
import { Download, Loader2, CheckCircle2, XCircle, FolderOpen } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  batchExportTables,
  type ExportFormat,
  type TableExportStatus,
  type BatchExportProgressEvent,
} from "@/services/tauri-commands";
import { downloadDir } from "@tauri-apps/api/path";
import { useTaskStore, newTaskId } from "@/stores/task-store";

// ─── Format options ───────────────────────────────────────────────

const FORMATS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: "csv", label: "CSV", ext: "csv" },
  { value: "json", label: "JSON", ext: "json" },
  { value: "sql_insert", label: "SQL INSERT", ext: "sql" },
  { value: "excel", label: "Excel (.xlsx)", ext: "xlsx" },
];

// ─── BatchExportDialog ────────────────────────────────────────────

interface BatchExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  database: string;
  schema?: string;
  tables: string[];
}

type ExportStatus = "idle" | "exporting" | "done";

export function BatchExportDialog({
  open,
  onOpenChange,
  connectionId,
  database,
  schema,
  tables,
}: BatchExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState("0");
  const [outputDir, setOutputDir] = useState("");
  const [status, setStatus] = useState<ExportStatus>("idle");
  const [results, setResults] = useState<TableExportStatus[]>([]);
  const [exportProgress, setExportProgress] = useState<BatchExportProgressEvent | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const addTask = useTaskStore((s) => s.addTask);
  const updateTask = useTaskStore((s) => s.updateTask);

  // Initialize on open
  useEffect(() => {
    if (!open) return;
    setSelectedTables(new Set(tables));
    setStatus("idle");
    setResults([]);
    setExportProgress(null);
    downloadDir()
      .then(setOutputDir)
      .catch(() => setOutputDir(""));
  }, [open, tables]);

  const toggleTable = (name: string) => {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAll = useCallback(() => setSelectedTables(new Set(tables)), [tables]);
  const selectNone = useCallback(() => setSelectedTables(new Set()), []);

  const handleExport = async () => {
    const total = selectedTables.size;
    const taskId = newTaskId();
    addTask({
      id: taskId,
      kind: "export",
      description: `批量导出 ${total} 张表`,
      status: "running",
      progress: null,
      rowsDone: 0,
      rowsPerSec: 0,
      errorMessage: null,
    });

    if (mountedRef.current) {
      setStatus("exporting");
      setResults([]);
      setExportProgress(null);
    }

    const unlisten = await listen<BatchExportProgressEvent>("export-batch-progress", (ev) => {
      const p = ev.payload;
      if (mountedRef.current) setExportProgress(p);
      updateTask(taskId, {
        progress: Math.round(((p.tableIndex + 1) / p.totalTables) * 100),
        description: `批量导出 ${p.tableIndex + 1}/${p.totalTables}: ${p.table}`,
      });
    });

    try {
      const limitNum = parseInt(limit, 10);
      const res = await batchExportTables(
        connectionId,
        database,
        schema,
        [...selectedTables],
        format,
        isNaN(limitNum) || limitNum < 0 ? 0 : limitNum,
        outputDir,
      );
      const successCount = res.filter((r) => r.error === null).length;
      const failCount = res.filter((r) => r.error !== null).length;
      updateTask(taskId, {
        status: failCount > 0 && successCount === 0 ? "error" : "done",
        progress: 100,
        rowsDone: successCount,
        description: `批量导出完成（${successCount} 成功${failCount > 0 ? `，${failCount} 失败` : ""}）`,
        errorMessage: failCount > 0 ? `${failCount} 张表导出失败` : null,
      });
      if (mountedRef.current) {
        setResults(res);
        setStatus("done");
      }
    } catch (e) {
      updateTask(taskId, { status: "error", errorMessage: String(e) });
      if (mountedRef.current) {
        setResults([{ table: "(batch)", rowsExported: 0, filePath: "", error: String(e) }]);
        setStatus("done");
      }
    } finally {
      unlisten();
    }
  };

  const canExport =
    status !== "exporting" &&
    selectedTables.size > 0 &&
    outputDir.trim() !== "";

  const successCount = results.filter((r) => r.error === null).length;
  const failCount = results.filter((r) => r.error !== null).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[620px] max-w-[95vw] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">
            批量导出 — {database}{schema ? `.${schema}` : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5 overflow-auto px-4 py-4">
          {/* Format */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              导出格式
            </label>
            <div className="flex gap-2">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs transition-colors",
                    format === f.value
                      ? "border-primary bg-primary/10 text-primary font-medium"
                      : "border-border hover:border-primary/50 hover:bg-muted",
                  )}
                  onClick={() => setFormat(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Table selection */}
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                选择表 ({selectedTables.size}/{tables.length})
              </span>
              <button
                className="text-[11px] text-primary hover:underline"
                onClick={selectAll}
              >
                全选
              </button>
              <button
                className="text-[11px] text-muted-foreground hover:underline"
                onClick={selectNone}
              >
                清空
              </button>
            </div>
            <div className="flex max-h-36 flex-col gap-0.5 overflow-auto rounded-md border border-border p-2">
              {tables.map((name) => {
                const isSel = selectedTables.has(name);
                return (
                  <label
                    key={name}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggleTable(name)}
                      className="size-3 accent-primary"
                    />
                    <span className="font-mono text-[11px]">{name}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Limit */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              每张表最大行数（0 = 全部导出）
            </label>
            <Input
              className="h-7 w-36 font-mono text-xs"
              placeholder="0"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </div>

          {/* Output directory */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              输出目录
            </label>
            <div className="flex gap-2">
              <Input
                className="h-7 flex-1 font-mono text-xs"
                value={outputDir}
                onChange={(e) => setOutputDir(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                onClick={async () => {
                  const dir = await downloadDir().catch(() => "");
                  setOutputDir(dir);
                }}
              >
                <FolderOpen className="size-3" />
                下载目录
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              每张表将导出为 <span className="font-mono">表名.{FORMATS.find((f) => f.value === format)?.ext}</span>
            </p>
          </div>

          {/* Live progress */}
          {status === "exporting" && exportProgress && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" />
                  正在导出 <span className="font-mono font-medium text-foreground">{exportProgress.table}</span>
                </span>
                <span>
                  {exportProgress.tableIndex + 1} / {exportProgress.totalTables} 张表
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{
                    width: `${((exportProgress.tableIndex + 1) / exportProgress.totalTables) * 100}%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Results */}
          {results.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium">导出结果</span>
                {successCount > 0 && (
                  <span className="text-green-600 dark:text-green-400">
                    {successCount} 成功
                  </span>
                )}
                {failCount > 0 && (
                  <span className="text-destructive">{failCount} 失败</span>
                )}
              </div>
              <div className="max-h-48 overflow-auto rounded-md border border-border">
                {results.map((r, i) => (
                  <div
                    key={i}
                    className={cn(
                      "flex items-start gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0",
                      r.error ? "bg-destructive/5" : "bg-green-500/5",
                    )}
                  >
                    {r.error ? (
                      <XCircle className="mt-0.5 size-3 shrink-0 text-destructive" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-green-600 dark:text-green-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-[11px] font-medium">{r.table}</p>
                      {r.error ? (
                        <p className="text-[10px] text-destructive opacity-80">{r.error}</p>
                      ) : (
                        <p className="text-[10px] text-muted-foreground">
                          {r.rowsExported} 行 → {r.filePath}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={!canExport}
            onClick={handleExport}
          >
            {status === "exporting" ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                导出中…
              </>
            ) : (
              <>
                <Download className="size-3" />
                批量导出
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

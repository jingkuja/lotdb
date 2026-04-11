import { useState, useEffect, useRef, useCallback } from "react";
import { Upload, Loader2, CheckCircle2, AlertCircle, FileText, ChevronRight } from "lucide-react";
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
  importTableData,
  previewImportFile,
  type ImportFormat,
  type ImportResult,
  type ImportProgressEvent,
} from "@/services/tauri-commands";
import type { ColumnDef } from "@/services/tauri-commands";
import { useTaskStore, newTaskId } from "@/stores/task-store";

// ─── Constants ────────────────────────────────────────────────────

const FORMATS: { value: ImportFormat; label: string; exts: string[] }[] = [
  { value: "csv", label: "CSV", exts: ["csv", "tsv", "txt"] },
  { value: "json", label: "JSON", exts: ["json"] },
  { value: "sql", label: "SQL", exts: ["sql"] },
];

const SKIP = "__skip__";

function detectFormat(path: string): ImportFormat {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  for (const f of FORMATS) {
    if (f.exts.includes(ext)) return f.value;
  }
  return "csv";
}

// ─── Progress bar ─────────────────────────────────────────────────

function formatSpeed(rps: number): string {
  if (rps >= 1000) return `${(rps / 1000).toFixed(1)}k 行/秒`;
  return `${Math.round(rps)} 行/秒`;
}

function formatEta(sec: number): string {
  if (sec < 1) return "< 1 秒";
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function ImportProgressBar({ progress }: { progress: ImportProgressEvent | null }) {
  const pct = progress ? Math.min(100, (progress.current / progress.total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {progress
            ? `${progress.current.toLocaleString()} / ${progress.total.toLocaleString()} 行`
            : "准备中…"}
        </span>
        <span className="flex items-center gap-3">
          {progress && progress.rowsPerSec > 0 && (
            <span>{formatSpeed(progress.rowsPerSec)}</span>
          )}
          {progress && progress.etaSec > 0 && (
            <span>剩余 {formatEta(progress.etaSec)}</span>
          )}
          <span className="font-medium">{Math.round(pct)}%</span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── ImportDialog ─────────────────────────────────────────────────

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  database: string;
  schema?: string;
  table: string;
  /** Table column definitions (already fetched by parent) */
  columnDefs: ColumnDef[];
  onSuccess?: () => void;
}

type Step = "config" | "mapping" | "done";
type ImportStatus = "idle" | "loading" | "importing" | "done" | "error";

export function ImportDialog({
  open,
  onOpenChange,
  connectionId,
  database,
  schema,
  table,
  columnDefs,
  onSuccess,
}: ImportDialogProps) {
  // ── Config state ──────────────────────────────────────────────
  const [filePath, setFilePath] = useState("");
  const [format, setFormat] = useState<ImportFormat>("csv");
  const [hasHeader, setHasHeader] = useState(true);
  const [truncateFirst, setTruncateFirst] = useState(false);

  // ── Step / status ─────────────────────────────────────────────
  const [step, setStep] = useState<Step>("config");
  const [status, setStatus] = useState<ImportStatus>("idle");

  // ── Preview + mapping state ───────────────────────────────────
  const [srcColumns, setSrcColumns] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<(string | null)[][]>([]);
  // mapping[i] = target column name or SKIP
  const [mapping, setMapping] = useState<string[]>([]);

  // ── Import result ─────────────────────────────────────────────
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // ── Progress ──────────────────────────────────────────────────
  const [progress, setProgress] = useState<ImportProgressEvent | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track mounted state to safely update dialog state after potential close
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const addTask = useTaskStore((s) => s.addTask);
  const updateTask = useTaskStore((s) => s.updateTask);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setFilePath("");
    setFormat("csv");
    setHasHeader(true);
    setTruncateFirst(false);
    setStep("config");
    setStatus("idle");
    setSrcColumns([]);
    setPreviewRows([]);
    setMapping([]);
    setImportResult(null);
    setProgress(null);
  }, [open]);

  // Auto-detect format when path changes
  useEffect(() => {
    if (filePath) setFormat(detectFormat(filePath));
  }, [filePath]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const path = (file as unknown as { path?: string }).path ?? file.name;
    setFilePath(path);
    e.target.value = "";
  };

  // ── Parse file → go to mapping step ──────────────────────────
  const handleParse = useCallback(async () => {
    if (format === "sql") {
      // SQL: no mapping needed, go straight to import config
      setStep("mapping");
      return;
    }
    setStatus("loading");
    try {
      const preview = await previewImportFile(filePath.trim(), format, hasHeader, 5);
      setSrcColumns(preview.columns);
      setPreviewRows(preview.rows);
      // Default mapping: try to match source column name to a target column (case-insensitive)
      const defaultMapping = preview.columns.map((col) => {
        const lower = col.toLowerCase();
        const match = columnDefs.find((c) => c.name.toLowerCase() === lower);
        return match ? match.name : SKIP;
      });
      setMapping(defaultMapping);
      setStep("mapping");
      setStatus("idle");
    } catch (e) {
      setImportResult({ rowsImported: 0, rowsFailed: 0, errorMessage: String(e) });
      setStatus("error");
    }
  }, [filePath, format, hasHeader, columnDefs]);

  // ── Execute import ────────────────────────────────────────────
  const handleImport = async () => {
    const taskId = newTaskId();
    addTask({
      id: taskId,
      kind: "import",
      description: `导入 ${table}`,
      status: "running",
      progress: null,
      rowsDone: 0,
      rowsPerSec: 0,
      errorMessage: null,
    });

    if (mountedRef.current) {
      setStatus("importing");
      setImportResult(null);
      setProgress(null);
    }

    // Subscribe to progress events
    const unlisten = await listen<ImportProgressEvent>("import-progress", (ev) => {
      const p = ev.payload;
      if (mountedRef.current) setProgress(p);
      updateTask(taskId, {
        progress: p.total > 0 ? Math.min(100, Math.round((p.current / p.total) * 100)) : null,
        rowsDone: p.current,
        rowsPerSec: p.rowsPerSec,
      });
    });

    try {
      const colMapping = format === "sql"
        ? []
        : mapping.map((m) => (m === SKIP ? null : m));
      const res = await importTableData(
        connectionId,
        database,
        schema,
        table,
        filePath.trim(),
        format,
        hasHeader,
        truncateFirst,
        colMapping,
      );
      updateTask(taskId, { status: "done", rowsDone: res.rowsImported, progress: 100 });
      if (mountedRef.current) {
        setImportResult(res);
        setStatus("done");
        setStep("done");
        if (res.rowsImported > 0) onSuccess?.();
      }
    } catch (e) {
      updateTask(taskId, { status: "error", errorMessage: String(e) });
      if (mountedRef.current) {
        setImportResult({ rowsImported: 0, rowsFailed: 0, errorMessage: String(e) });
        setStatus("error");
      }
    } finally {
      unlisten();
    }
  };

  const mappedCount = format === "sql" ? 1 : mapping.filter((m) => m !== SKIP).length;

  // ─────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[620px] max-w-[95vw] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">
            导入数据 — {table}
            {step !== "config" && (
              <span className="ml-2 text-muted-foreground">
                / {step === "mapping" ? "字段映射" : "完成"}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5 overflow-auto px-4 py-4">
          {/* ── Step 1: Config ───────────────────────────────── */}
          {step === "config" && (
            <>
              {/* File path */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  文件路径
                </label>
                <div className="flex gap-2">
                  <Input
                    className="h-7 flex-1 font-mono text-xs"
                    placeholder="/path/to/file.csv"
                    value={filePath}
                    onChange={(e) => setFilePath(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <FileText className="size-3" />
                    浏览
                  </Button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".csv,.tsv,.txt,.json,.sql"
                  onChange={handleFileSelect}
                />
              </div>

              {/* Format */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  文件格式
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

              {/* CSV options */}
              {format === "csv" && (
                <div>
                  <label className="mb-2 block text-xs font-medium text-muted-foreground">
                    CSV 选项
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={hasHeader}
                      onChange={(e) => setHasHeader(e.target.checked)}
                      className="size-3.5 accent-primary"
                    />
                    首行为列名（标题行）
                  </label>
                </div>
              )}

              {/* Parse error */}
              {status === "error" && importResult?.errorMessage && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <div className="flex items-center gap-1.5 font-medium">
                    <AlertCircle className="size-3" />
                    解析失败
                  </div>
                  <p className="mt-0.5 text-[11px] opacity-80">{importResult.errorMessage}</p>
                </div>
              )}
            </>
          )}

          {/* ── Step 2: Mapping ──────────────────────────────── */}
          {step === "mapping" && (
            <>
              {/* SQL: no mapping, just options */}
              {format === "sql" ? (
                <p className="text-xs text-muted-foreground">
                  SQL 文件将逐条执行其中的语句，无需字段映射。
                </p>
              ) : (
                <>
                  {/* Mapping table */}
                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        字段映射（{mappedCount}/{srcColumns.length} 列将被导入）
                      </span>
                      <div className="flex gap-2">
                        <button
                          className="text-[11px] text-primary hover:underline"
                          onClick={() => {
                            // Map each source col to same-name target if exists, else first unmapped
                            const used = new Set<string>();
                            const next = srcColumns.map((col) => {
                              const exact = columnDefs.find(
                                (c) => c.name.toLowerCase() === col.toLowerCase(),
                              );
                              if (exact && !used.has(exact.name)) {
                                used.add(exact.name);
                                return exact.name;
                              }
                              return SKIP;
                            });
                            setMapping(next);
                          }}
                        >
                          自动匹配
                        </button>
                        <button
                          className="text-[11px] text-muted-foreground hover:underline"
                          onClick={() => setMapping(srcColumns.map(() => SKIP))}
                        >
                          全部跳过
                        </button>
                      </div>
                    </div>

                    <div className="max-h-52 overflow-auto rounded-md border border-border">
                      <table className="w-full text-[11px]">
                        <thead className="border-b border-border bg-muted/50">
                          <tr>
                            <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">
                              文件列
                            </th>
                            <th className="px-2 py-1.5 text-center text-muted-foreground">→</th>
                            <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">
                              目标列
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {srcColumns.map((col, i) => (
                            <tr
                              key={i}
                              className="border-b border-border/50 last:border-b-0 hover:bg-muted/30"
                            >
                              <td className="px-3 py-1 font-mono">{col}</td>
                              <td className="px-2 py-1 text-center text-muted-foreground">→</td>
                              <td className="px-3 py-1">
                                <select
                                  className={cn(
                                    "w-full rounded border border-border bg-background px-1.5 py-0.5 text-[11px] outline-none",
                                    "focus:border-primary",
                                    mapping[i] === SKIP
                                      ? "text-muted-foreground"
                                      : "text-foreground",
                                  )}
                                  value={mapping[i] ?? SKIP}
                                  onChange={(e) => {
                                    const next = [...mapping];
                                    next[i] = e.target.value;
                                    setMapping(next);
                                  }}
                                >
                                  <option value={SKIP}>— 跳过 —</option>
                                  {columnDefs.map((c) => (
                                    <option key={c.name} value={c.name}>
                                      {c.name}
                                      {c.dataType ? ` (${c.dataType})` : ""}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Data preview */}
                  {previewRows.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                        数据预览（前 {previewRows.length} 行）
                      </p>
                      <div className="max-h-36 overflow-auto rounded-md border border-border">
                        <table className="w-full text-[11px]">
                          <thead className="border-b border-border bg-muted/50">
                            <tr>
                              {srcColumns.map((col, i) => (
                                <th
                                  key={i}
                                  className="min-w-[80px] px-2 py-1 text-left font-medium text-muted-foreground"
                                >
                                  {col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {previewRows.map((row, ri) => (
                              <tr
                                key={ri}
                                className="border-b border-border/50 last:border-b-0"
                              >
                                {row.map((cell, ci) => (
                                  <td
                                    key={ci}
                                    className="max-w-[160px] truncate px-2 py-1 font-mono"
                                    title={cell ?? "NULL"}
                                  >
                                    {cell === null ? (
                                      <span className="text-muted-foreground italic">NULL</span>
                                    ) : (
                                      cell
                                    )}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Common options (truncate) */}
              <div>
                <label className="mb-2 block text-xs font-medium text-muted-foreground">
                  导入选项
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={truncateFirst}
                    onChange={(e) => setTruncateFirst(e.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  <span>
                    导入前清空表{" "}
                    <span className="text-destructive">（TRUNCATE — 不可撤销）</span>
                  </span>
                </label>
              </div>

              {/* Progress bar */}
              {status === "importing" && (
                <ImportProgressBar progress={progress} />
              )}

              {/* Import error */}
              {status === "error" && importResult?.errorMessage && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <div className="flex items-center gap-1.5 font-medium">
                    <AlertCircle className="size-3" />
                    导入失败
                  </div>
                  <p className="mt-0.5 text-[11px] opacity-80">{importResult.errorMessage}</p>
                </div>
              )}
            </>
          )}

          {/* ── Step 3: Done ─────────────────────────────────── */}
          {step === "done" && importResult && (
            <div
              className={cn(
                "rounded-md px-3 py-3 text-xs",
                importResult.errorMessage
                  ? "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
                  : "bg-green-500/10 text-green-700 dark:text-green-400",
              )}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="size-3.5" />
                导入完成
              </div>
              <p className="mt-1 text-[11px]">
                成功导入 <strong>{importResult.rowsImported}</strong> 行
                {importResult.rowsFailed > 0 && (
                  <>，失败 <strong>{importResult.rowsFailed}</strong> 行</>
                )}
              </p>
              {importResult.errorMessage && (
                <p className="mt-1 text-[11px] text-destructive opacity-90">
                  {importResult.errorMessage}
                </p>
              )}
              <Button
                size="sm"
                variant="outline"
                className="mt-3 h-7 text-xs"
                onClick={() => {
                  setStep("config");
                  setStatus("idle");
                  setImportResult(null);
                }}
              >
                再次导入
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              if (step === "mapping") {
                setStep("config");
                setStatus("idle");
              } else {
                onOpenChange(false);
              }
            }}
          >
            {step === "mapping" ? "上一步" : "关闭"}
          </Button>

          {step === "config" && (
            <Button
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={!filePath.trim() || status === "loading"}
              onClick={handleParse}
            >
              {status === "loading" ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  解析中…
                </>
              ) : (
                <>
                  下一步
                  <ChevronRight className="size-3" />
                </>
              )}
            </Button>
          )}

          {step === "mapping" && (
            <Button
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={
                status === "importing" ||
                (format !== "sql" && mappedCount === 0)
              }
              onClick={handleImport}
            >
              {status === "importing" ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  导入中…
                </>
              ) : (
                <>
                  <Upload className="size-3" />
                  开始导入
                </>
              )}
            </Button>
          )}

          {step === "done" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

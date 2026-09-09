import { useState, useEffect, useCallback, useRef } from "react";
import { Download, Check, Loader2 } from "lucide-react";
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
import { exportTableData, type ExportFormat } from "@/services/tauri-commands";
import type { ColumnDef } from "@/services/tauri-commands";
import { downloadDir, join } from "@tauri-apps/api/path";

// ─── Format options ───────────────────────────────────────────────

const FORMATS: { value: ExportFormat; label: string; ext: string }[] = [
  { value: "csv", label: "CSV", ext: "csv" },
  { value: "json", label: "JSON", ext: "json" },
  { value: "sql_insert", label: "SQL INSERT", ext: "sql" },
  { value: "excel", label: "Excel (.xlsx)", ext: "xlsx" },
];

// ─── Export dialog ────────────────────────────────────────────────

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  database: string;
  schema?: string;
  table: string;
  /** Already-fetched column definitions */
  columnDefs: ColumnDef[];
}

type ExportStatus = "idle" | "exporting" | "done" | "error";

export function ExportDialog(props: ExportDialogProps) {
  return props.open ? (
    <ExportDialogBody
      key={JSON.stringify(props.columnDefs.map((c) => c.name))}
      {...props}
    />
  ) : null;
}

function ExportDialogBody({
  open,
  onOpenChange,
  connectionId,
  database,
  schema,
  table,
  columnDefs,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const formatRef = useRef<ExportFormat>("csv");
  const [selectedCols, setSelectedCols] = useState<Set<string>>(
    () => new Set(columnDefs.map((c) => c.name)),
  );
  const [whereClause, setWhereClause] = useState("");
  const [limit, setLimit] = useState("10000");
  const [filePath, setFilePath] = useState("");
  const [status, setStatus] = useState<ExportStatus>("idle");
  const [result, setResult] = useState<{ rows: number; path: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  // Initialize: select all columns, build default file path
  useEffect(() => {
    let cancelled = false;
    // Build default path asynchronously
    const stamp = new Date()
      .toISOString()
      .replace(/[:\-T]/g, "")
      .slice(0, 14);
    const ext = "csv";
    downloadDir()
      .then((dir) => join(dir, `${table}_${stamp}.${ext}`))
      .then((path) => {
        if (!cancelled)
          setFilePath(
            (previous) =>
              previous ||
              path.replace(
                /\.[^.]+$/,
                `.${FORMATS.find((f) => f.value === formatRef.current)?.ext ?? ext}`,
              ),
          );
      })
      .catch(() => {
        if (!cancelled)
          setFilePath(
            (previous) =>
              previous ||
              `${table}_export.${FORMATS.find((f) => f.value === formatRef.current)?.ext ?? ext}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [table]);

  const changeFormat = (next: ExportFormat) => {
    formatRef.current = next;
    setFormat(next);
    const ext = FORMATS.find((f) => f.value === next)?.ext ?? "csv";
    setFilePath((path) => path.replace(/\.[^.]+$/, `.${ext}`));
  };

  const toggleCol = (name: string) => {
    setSelectedCols((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAll = useCallback(() => {
    setSelectedCols(new Set(columnDefs.map((c) => c.name)));
  }, [columnDefs]);

  const selectNone = useCallback(() => setSelectedCols(new Set()), []);

  const handleExport = async () => {
    setStatus("exporting");
    setError(null);
    try {
      const cols = [...selectedCols];
      // If all selected, pass empty (= SELECT *)
      const colsArg = cols.length === columnDefs.length ? [] : cols;
      const limitNum = parseInt(limit, 10);
      const res = await exportTableData({
        connectionId,
        database,
        schema,
        table,
        format,
        columns: colsArg,
        whereClause: whereClause.trim() || undefined,
        limit: isNaN(limitNum) || limitNum <= 0 ? 0 : limitNum,
        filePath,
      });
      setResult({ rows: res.rowsExported, path: res.filePath });
      setStatus("done");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  const canExport =
    status !== "exporting" && selectedCols.size > 0 && filePath.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[580px] max-w-[95vw] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">
            导出数据 — {table}
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
                  onClick={() => changeFormat(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Columns */}
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                选择列 ({selectedCols.size}/{columnDefs.length})
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
            <div className="flex max-h-28 flex-wrap gap-1 overflow-auto rounded-md border border-border p-2">
              {columnDefs.map((col) => {
                const isSel = selectedCols.has(col.name);
                return (
                  <button
                    key={col.name}
                    className={cn(
                      "rounded border px-2 py-0.5 text-[11px] transition-colors",
                      isSel
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:border-primary/50 hover:bg-muted text-muted-foreground",
                    )}
                    onClick={() => toggleCol(col.name)}
                  >
                    {col.name}
                  </button>
                );
              })}
            </div>
          </div>

          {/* WHERE clause */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              WHERE 条件（可选）
            </label>
            <Input
              className="h-7 font-mono text-xs"
              placeholder="e.g. status = 'active' AND created_at > '2024-01-01'"
              value={whereClause}
              onChange={(e) => setWhereClause(e.target.value)}
            />
          </div>

          {/* Limit */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              最大行数（留空或 0 = 全部导出）
            </label>
            <Input
              className="h-7 w-36 font-mono text-xs"
              placeholder="10000"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </div>

          {/* File path */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              输出文件路径
            </label>
            <Input
              className="h-7 font-mono text-xs"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
            />
          </div>

          {/* Result / Error */}
          {status === "done" && result && (
            <div className="rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-400">
              <p className="font-medium">导出成功</p>
              <p className="mt-0.5 font-mono text-[11px] opacity-80">
                {result.rows} 行 → {result.path}
              </p>
            </div>
          )}
          {status === "error" && error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
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
            ) : status === "done" ? (
              <>
                <Check className="size-3" />
                再次导出
              </>
            ) : (
              <>
                <Download className="size-3" />
                导出
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

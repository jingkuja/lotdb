import { useState, useEffect, useRef, useCallback } from "react";
import { ArrowRight, Loader2, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  listDatabases,
  listObjects,
  getTableColumns,
  transferTableData,
  type ColumnMap,
} from "@/services/tauri-commands";
import type { ConnectionConfig } from "@/types/database";
import { useTaskStore, newTaskId } from "@/stores/task-store";

// ─── Progress helpers ─────────────────────────────────────────────

function formatSpeed(rps: number): string {
  if (rps >= 1000) return `${(rps / 1000).toFixed(1)}k 行/秒`;
  return `${Math.round(rps)} 行/秒`;
}

function formatEta(sec: number): string {
  if (sec < 1) return "< 1 秒";
  if (sec < 60) return `${Math.round(sec)} 秒`;
  return `${Math.round(sec / 60)} 分钟`;
}

interface TransferProgressEvent {
  current: number;
  total: number;
  rowsPerSec: number;
  etaSec: number;
}

// ─── Side selector ────────────────────────────────────────────────

interface SideConfig {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
}

const EMPTY_SIDE: SideConfig = { connectionId: "", database: "", schema: "", table: "" };

interface SideSelectorProps {
  label: string;
  connections: ConnectionConfig[];
  value: SideConfig;
  onChange: (v: SideConfig) => void;
  disabled?: boolean;
}

function SideSelector({ label, connections, value, onChange, disabled }: SideSelectorProps) {
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [loadingTbls, setLoadingTbls] = useState(false);

  const selectedConn = connections.find((c) => c.id === value.connectionId);
  const isPg = selectedConn?.dbType === "postgres";

  const loadDatabases = useCallback(async (connectionId: string) => {
    if (!connectionId) return;
    setLoadingDbs(true);
    try {
      const dbs = await listDatabases(connectionId);
      setDatabases(dbs);
    } catch {
      setDatabases([]);
    } finally {
      setLoadingDbs(false);
    }
  }, []);

  const loadTables = useCallback(async (connectionId: string, database: string, schema: string) => {
    if (!connectionId || !database) return;
    setLoadingTbls(true);
    try {
      const objs = await listObjects(connectionId, database, schema || undefined);
      setTables(objs.tables);
    } catch {
      setTables([]);
    } finally {
      setLoadingTbls(false);
    }
  }, []);

  const handleConnectionChange = (connectionId: string) => {
    onChange({ ...EMPTY_SIDE, connectionId });
    setDatabases([]);
    setTables([]);
    if (connectionId) loadDatabases(connectionId);
  };

  const handleDatabaseChange = (database: string) => {
    onChange({ ...value, database, schema: isPg ? "public" : "", table: "" });
    setTables([]);
    if (database) loadTables(value.connectionId, database, isPg ? "public" : "");
  };

  const handleSchemaChange = (schema: string) => {
    onChange({ ...value, schema, table: "" });
    setTables([]);
    if (schema) loadTables(value.connectionId, value.database, schema);
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
      {/* Connection */}
      <div>
        <Label className="text-xs mb-1 block">连接</Label>
        <select
          disabled={disabled}
          value={value.connectionId}
          onChange={(e) => handleConnectionChange(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
        >
          <option value="">-- 选择连接 --</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.dbType})
            </option>
          ))}
        </select>
      </div>
      {/* Database */}
      {value.connectionId && (
        <div>
          <Label className="text-xs mb-1 block">
            数据库 {loadingDbs && <Loader2 className="inline size-3 animate-spin ml-1" />}
          </Label>
          <select
            disabled={disabled || loadingDbs}
            value={value.database}
            onChange={(e) => handleDatabaseChange(e.target.value)}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
          >
            <option value="">-- 选择数据库 --</option>
            {databases.map((db) => (
              <option key={db} value={db}>{db}</option>
            ))}
          </select>
        </div>
      )}
      {/* Schema (PG only) */}
      {isPg && value.database && (
        <div>
          <Label className="text-xs mb-1 block">Schema</Label>
          <Input
            disabled={disabled}
            value={value.schema}
            onChange={(e) => handleSchemaChange(e.target.value)}
            placeholder="public"
            className="h-7 text-xs"
          />
        </div>
      )}
      {/* Table */}
      {value.database && (
        <div>
          <Label className="text-xs mb-1 block">
            表 {loadingTbls && <Loader2 className="inline size-3 animate-spin ml-1" />}
          </Label>
          <select
            disabled={disabled || loadingTbls}
            value={value.table}
            onChange={(e) => onChange({ ...value, table: e.target.value })}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
          >
            <option value="">-- 选择表 --</option>
            {tables.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// ─── Column mapping row ───────────────────────────────────────────

interface ColMapRowProps {
  srcCol: string;
  tgtColumns: string[];
  value: string | null; // null = skip
  onChange: (v: string | null) => void;
  disabled?: boolean;
}

const SKIP = "__skip__";

function ColMapRow({ srcCol, tgtColumns, value, onChange, disabled }: ColMapRowProps) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
      <span className="truncate rounded bg-muted px-2 py-0.5 font-mono text-xs">{srcCol}</span>
      <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
      <select
        disabled={disabled}
        value={value ?? SKIP}
        onChange={(e) => onChange(e.target.value === SKIP ? null : e.target.value)}
        className="w-full rounded border border-border bg-background px-2 py-0.5 text-xs disabled:opacity-50"
      >
        <option value={SKIP}>-- 跳过 --</option>
        {tgtColumns.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
    </div>
  );
}

// ─── Main dialog ──────────────────────────────────────────────────

type Step = "config" | "mapping" | "running" | "done";

interface DataTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connections: ConnectionConfig[];
  /** Pre-fill source side when opened from a table context */
  defaultSrc?: { connectionId: string; database: string; schema?: string; table: string };
}

export function DataTransferDialog({
  open,
  onOpenChange,
  connections,
  defaultSrc,
}: DataTransferDialogProps) {
  const [step, setStep] = useState<Step>("config");
  const [src, setSrc] = useState<SideConfig>(EMPTY_SIDE);
  const [tgt, setTgt] = useState<SideConfig>(EMPTY_SIDE);
  const [whereClause, setWhereClause] = useState("");
  const [limitStr, setLimitStr] = useState("0");
  const [truncateFirst, setTruncateFirst] = useState(false);

  // Column mapping
  const [srcColumns, setSrcColumns] = useState<string[]>([]);
  const [tgtColumns, setTgtColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [loadingCols, setLoadingCols] = useState(false);

  // Progress
  const [progress, setProgress] = useState(0);
  const [rowsDone, setRowsDone] = useState(0);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [eta, setEta] = useState(0);
  const [resultError, setResultError] = useState<string | null>(null);
  const [resultRows, setResultRows] = useState(0);

  const mountedRef = useRef(true);
  const addTask = useTaskStore((s) => s.addTask);
  const updateTask = useTaskStore((s) => s.updateTask);

  // Reset on open
  useEffect(() => {
    if (open) {
      mountedRef.current = true;
      setStep("config");
      setSrc(
        defaultSrc
          ? {
              connectionId: defaultSrc.connectionId,
              database: defaultSrc.database,
              schema: defaultSrc.schema ?? "",
              table: defaultSrc.table,
            }
          : EMPTY_SIDE,
      );
      setTgt(EMPTY_SIDE);
      setWhereClause("");
      setLimitStr("0");
      setTruncateFirst(false);
      setSrcColumns([]);
      setTgtColumns([]);
      setMapping([]);
      setProgress(0);
      setRowsDone(0);
      setRowsTotal(0);
      setSpeed(0);
      setEta(0);
      setResultError(null);
      setResultRows(0);
    }
    return () => {
      mountedRef.current = false;
    };
  }, [open, defaultSrc]);

  const canGoToMapping =
    src.connectionId && src.database && src.table &&
    tgt.connectionId && tgt.database && tgt.table;

  const loadColumns = useCallback(async () => {
    if (!canGoToMapping) return;
    setLoadingCols(true);
    try {
      const [srcCols, tgtCols] = await Promise.all([
        getTableColumns(src.connectionId, src.database, src.schema || undefined, src.table),
        getTableColumns(tgt.connectionId, tgt.database, tgt.schema || undefined, tgt.table),
      ]);
      const srcNames = srcCols.map((c) => c.name);
      const tgtNames = tgtCols.map((c) => c.name);
      setSrcColumns(srcNames);
      setTgtColumns(tgtNames);
      // Auto-match by name
      const autoMap = srcNames.map((s) => (tgtNames.includes(s) ? s : null));
      setMapping(autoMap);
      setStep("mapping");
    } catch (e) {
      alert(`加载列失败: ${e}`);
    } finally {
      setLoadingCols(false);
    }
  }, [src, tgt, canGoToMapping]);

  const handleTransfer = useCallback(async () => {
    const colMapping: ColumnMap[] = srcColumns
      .map((s, i) => ({ src: s, tgt: mapping[i] ?? null }))
      .filter((m): m is ColumnMap => m.tgt !== null);

    if (colMapping.length === 0) {
      alert("至少需要映射一列");
      return;
    }

    const limit = parseInt(limitStr, 10) || 0;
    const taskId = newTaskId();
    addTask({
      id: taskId,
      kind: "transfer",
      description: `传输 ${src.table} → ${tgt.table}`,
      status: "running",
      progress: null,
      rowsDone: 0,
      rowsPerSec: 0,
      errorMessage: null,
    });

    if (mountedRef.current) {
      setStep("running");
      setProgress(0);
      setRowsDone(0);
      setRowsTotal(0);
    }

    const unlisten = await listen<TransferProgressEvent>("transfer-progress", (event) => {
      const p = event.payload;
      const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
      updateTask(taskId, { progress: pct, rowsDone: p.current, rowsPerSec: p.rowsPerSec });
      if (mountedRef.current) {
        setProgress(pct);
        setRowsDone(p.current);
        setRowsTotal(p.total);
        setSpeed(p.rowsPerSec);
        setEta(p.etaSec);
      }
    });

    try {
      const res = await transferTableData(
        src.connectionId, src.database, src.schema || undefined, src.table,
        tgt.connectionId, tgt.database, tgt.schema || undefined, tgt.table,
        colMapping,
        truncateFirst,
        whereClause || undefined,
        limit,
      );
      updateTask(taskId, { status: "done", rowsDone: res.rowsTransferred, progress: 100 });
      if (mountedRef.current) {
        setProgress(100);
        setResultRows(res.rowsTransferred);
        setResultError(res.errorMessage);
        setStep("done");
      }
    } catch (e) {
      const msg = String(e);
      updateTask(taskId, { status: "error", errorMessage: msg });
      if (mountedRef.current) {
        setResultError(msg);
        setStep("done");
      }
    } finally {
      unlisten();
    }
  }, [
    src, tgt, srcColumns, mapping, limitStr, whereClause, truncateFirst,
    addTask, updateTask,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>跨连接数据传输</DialogTitle>
        </DialogHeader>

        {/* ── Step: config ── */}
        {step === "config" && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-6">
              <SideSelector
                label="源"
                connections={connections}
                value={src}
                onChange={setSrc}
              />
              <SideSelector
                label="目标"
                connections={connections}
                value={tgt}
                onChange={setTgt}
              />
            </div>

            {/* Options */}
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs mb-1 block">WHERE 条件（可选）</Label>
                  <Input
                    value={whereClause}
                    onChange={(e) => setWhereClause(e.target.value)}
                    placeholder="id > 100"
                    className="h-7 text-xs"
                  />
                </div>
                <div>
                  <Label className="text-xs mb-1 block">限制行数（0 = 不限）</Label>
                  <Input
                    value={limitStr}
                    onChange={(e) => setLimitStr(e.target.value)}
                    className="h-7 text-xs"
                    type="number"
                    min={0}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={truncateFirst}
                  onChange={(e) => setTruncateFirst(e.target.checked)}
                />
                传输前清空目标表（TRUNCATE）
              </label>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                disabled={!canGoToMapping || loadingCols}
                onClick={loadColumns}
              >
                {loadingCols ? (
                  <><Loader2 className="size-3.5 mr-1.5 animate-spin" />加载列…</>
                ) : (
                  <>下一步：列映射</>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ── Step: mapping ── */}
        {step === "mapping" && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              将源表列映射到目标表列。选择"跳过"则不传输该列。
            </p>
            <div className="max-h-72 overflow-y-auto flex flex-col gap-1.5 pr-1">
              {srcColumns.map((col, i) => (
                <ColMapRow
                  key={col}
                  srcCol={col}
                  tgtColumns={tgtColumns}
                  value={mapping[i] ?? null}
                  onChange={(v) => {
                    const next = [...mapping];
                    next[i] = v;
                    setMapping(next);
                  }}
                />
              ))}
            </div>
            <div className="flex gap-1.5 text-xs text-muted-foreground">
              <button
                className="underline"
                onClick={() => setMapping(srcColumns.map((s) => (tgtColumns.includes(s) ? s : null)))}
              >
                自动匹配
              </button>
              <span>·</span>
              <button
                className="underline"
                onClick={() => setMapping(srcColumns.map(() => null))}
              >
                全部跳过
              </button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("config")}>
                上一步
              </Button>
              <Button onClick={handleTransfer}>
                开始传输
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ── Step: running ── */}
        {step === "running" && (
          <div className="flex flex-col gap-4 py-4">
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-primary" />
              <span className="text-sm">
                正在传输 {src.table} → {tgt.table}…
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{rowsDone.toLocaleString()} / {rowsTotal > 0 ? rowsTotal.toLocaleString() : "?"} 行</span>
                <span>{formatSpeed(speed)}{eta > 0 ? `，剩余 ${formatEta(eta)}` : ""}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">传输在后台进行，可关闭此对话框</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                后台运行
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ── Step: done ── */}
        {step === "done" && (
          <div className="flex flex-col gap-4 py-4">
            {resultError ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">传输出现错误</span>
                  <span className="text-xs">{resultError}</span>
                  {resultRows > 0 && (
                    <span className="text-xs text-muted-foreground">{resultRows.toLocaleString()} 行已成功传输</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="size-4 shrink-0" />
                <span className="text-sm">
                  成功传输 <strong>{resultRows.toLocaleString()}</strong> 行
                </span>
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setStep("config");
                }}
              >
                <RefreshCw className="size-3.5 mr-1.5" />
                再次传输
              </Button>
              <Button onClick={() => onOpenChange(false)}>关闭</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

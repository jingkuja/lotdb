import { useState, useEffect, useCallback, useRef } from "react";
import {
  Loader2,
  RefreshCw,
  X,
  StopCircle,
  Activity,
  AlertCircle,
  Play,
  Pause,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  listProcesses,
  killProcess,
  type ProcessInfo,
} from "@/services/tauri-commands";
import type { DatabaseType } from "@/types/database";

// ─── Helpers ──────────────────────────────────────────────────────

function formatDuration(sec: number): string {
  if (sec < 1) return "< 1s";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function truncate(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const STATE_COLORS: Record<string, string> = {
  active:    "text-green-600 dark:text-green-400",
  idle:      "text-muted-foreground",
  "idle in transaction": "text-amber-600 dark:text-amber-400",
  "idle in transaction (aborted)": "text-destructive",
  Query:     "text-green-600 dark:text-green-400",
  Sleep:     "text-muted-foreground",
  Connect:   "text-blue-600 dark:text-blue-400",
  Killed:    "text-destructive",
};

function stateColor(state: string): string {
  return STATE_COLORS[state] ?? "text-foreground";
}

// ─── Summary bar ──────────────────────────────────────────────────

function SummaryBar({
  processes,
  dbType,
}: {
  processes: ProcessInfo[];
  dbType: DatabaseType;
}) {
  const total = processes.length;
  const active = processes.filter(
    (p) => (dbType === "mysql" ? p.command === "Query" : p.state === "active"),
  ).length;
  const idle = total - active;

  return (
    <div className="flex items-center gap-4 border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1">
        <Activity className="size-3" />
        <strong className="text-foreground">{total}</strong> 个连接
      </span>
      <span>
        <strong className="text-green-600 dark:text-green-400">{active}</strong> 活跃
      </span>
      <span>
        <strong>{idle}</strong> 空闲
      </span>
    </div>
  );
}

// ─── ProcessListTab ───────────────────────────────────────────────

interface ProcessListTabProps {
  connectionId: string;
  dbType: DatabaseType;
}

const REFRESH_INTERVALS = [
  { label: "3s", value: 3 },
  { label: "5s", value: 5 },
  { label: "10s", value: 10 },
  { label: "30s", value: 30 },
];

export function ProcessListTab({ connectionId, dbType }: ProcessListTabProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [intervalSec, setIntervalSec] = useState(5);
  const [filter, setFilter] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Patch kill handlers to pass connectionId
  const killHandler = useCallback(
    async (procId: number, killType: "query" | "connection") => {
      await killProcess(connectionId, procId, killType);
    },
    [connectionId],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listProcesses(connectionId);
      setProcesses(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh timer
  useEffect(() => {
    if (!autoRefresh) return;
    timerRef.current = setInterval(refresh, intervalSec * 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, intervalSec, refresh]);

  const filtered = filter
    ? processes.filter(
        (p) =>
          p.user.toLowerCase().includes(filter.toLowerCase()) ||
          (p.database ?? "").toLowerCase().includes(filter.toLowerCase()) ||
          (p.info ?? "").toLowerCase().includes(filter.toLowerCase()),
      )
    : processes;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <span className="text-xs font-medium text-muted-foreground">活跃查询</span>

        {/* Filter */}
        <input
          className="h-7 flex-1 max-w-52 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary placeholder:text-muted-foreground"
          placeholder="过滤用户/数据库/SQL…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <div className="ml-auto flex items-center gap-2">
          {/* Auto-refresh interval */}
          <div className="flex items-center gap-1">
            {REFRESH_INTERVALS.map((iv) => (
              <button
                key={iv.value}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] transition-colors",
                  intervalSec === iv.value
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-muted",
                )}
                onClick={() => setIntervalSec(iv.value)}
              >
                {iv.label}
              </button>
            ))}
          </div>

          {/* Pause/Resume auto-refresh */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? (
              <>
                <Pause className="size-3" /> 暂停
              </>
            ) : (
              <>
                <Play className="size-3" /> 自动刷新
              </>
            )}
          </Button>

          {/* Manual refresh */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={refresh}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            刷新
          </Button>
        </div>
      </div>

      {/* Summary */}
      <SummaryBar processes={processes} dbType={dbType} />

      {/* Error */}
      {error && (
        <div className="flex items-center gap-1.5 border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <AlertCircle className="size-3" />
          {error}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 border-b border-border bg-muted/80 backdrop-blur-sm">
            <tr>
              <th className="px-3 py-2 text-[11px] font-semibold text-muted-foreground">ID</th>
              <th className="px-3 py-2 text-[11px] font-semibold text-muted-foreground">用户</th>
              <th className="px-3 py-2 text-[11px] font-semibold text-muted-foreground">来源</th>
              <th className="px-3 py-2 text-[11px] font-semibold text-muted-foreground">数据库</th>
              <th className="px-3 py-2 text-[11px] font-semibold text-muted-foreground">状态</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold text-muted-foreground">时长</th>
              <th className="px-3 py-2 text-[11px] font-semibold text-muted-foreground">SQL</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold text-muted-foreground">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((proc) => (
              <BoundProcessRow
                key={proc.id}
                proc={proc}
                dbType={dbType}
                onKilled={refresh}
                killHandler={killHandler}
              />
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-xs text-muted-foreground">
                  {filter ? "没有匹配的进程" : "没有活跃进程"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: last refresh time */}
      <div className="border-t border-border px-4 py-1.5 text-[10px] text-muted-foreground">
        {autoRefresh
          ? `自动刷新：每 ${intervalSec} 秒`
          : "自动刷新已暂停"}
        {" · "}共 {filtered.length} 条{filter ? `（已过滤，共 ${processes.length} 条）` : ""}
      </div>
    </div>
  );
}

// ─── BoundProcessRow — injected connectionId for kill ─────────────

function BoundProcessRow({
  proc,
  dbType,
  onKilled,
  killHandler,
}: {
  proc: ProcessInfo;
  dbType: DatabaseType;
  onKilled: () => void;
  killHandler: (id: number, type: "query" | "connection") => Promise<void>;
}) {
  const [killing, setKilling] = useState<"query" | "connection" | null>(null);

  const doKill = async (type: "query" | "connection") => {
    setKilling(type);
    try {
      await killHandler(proc.id, type);
      onKilled();
    } catch (e) {
      alert(String(e));
    } finally {
      setKilling(null);
    }
  };

  return (
    <tr className="border-b border-border/50 hover:bg-muted/30">
      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{proc.id}</td>
      <td className="px-3 py-1.5 text-xs font-medium">{proc.user}</td>
      <td className="max-w-[120px] truncate px-3 py-1.5 text-xs text-muted-foreground">
        {proc.host || "—"}
      </td>
      <td className="px-3 py-1.5 text-xs">{proc.database ?? "—"}</td>
      <td className="px-3 py-1.5 text-xs">
        <span className={cn("font-medium", stateColor(proc.command))}>
          {proc.command}
        </span>
      </td>
      <td className="px-3 py-1.5 text-right font-mono text-xs">
        {formatDuration(proc.timeSec)}
      </td>
      <td className="max-w-[260px] px-3 py-1.5 text-xs">
        {proc.info ? (
          <span
            className="block truncate font-mono text-[11px] text-muted-foreground"
            title={proc.info}
          >
            {truncate(proc.info)}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </td>
      <td className="px-3 py-1.5">
        <div className="flex items-center justify-end gap-1">
          <button
            className="rounded p-0.5 text-muted-foreground hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400"
            title={dbType === "mysql" ? "KILL QUERY (中止 SQL)" : "pg_cancel_backend (取消查询)"}
            disabled={killing !== null}
            onClick={() => doKill("query")}
          >
            {killing === "query" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <StopCircle className="size-3" />
            )}
          </button>
          <button
            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title={dbType === "mysql" ? "KILL CONNECTION (断开连接)" : "pg_terminate_backend (终止连接)"}
            disabled={killing !== null}
            onClick={() => doKill("connection")}
          >
            {killing === "connection" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <X className="size-3" />
            )}
          </button>
        </div>
      </td>
    </tr>
  );
}

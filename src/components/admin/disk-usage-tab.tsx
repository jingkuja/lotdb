import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  AlertCircle,
  RefreshCw,
  HardDrive,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getDiskUsage,
  getTableSizes,
  type DbSizeInfo,
} from "@/services/tauri-commands";
import type { DatabaseType } from "@/types/database";

// ─── Helpers ──────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRows(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

type SortCol = "name" | "data" | "index" | "total" | "rows";
type SortDir = "asc" | "desc";

// ─── Database list (left panel) ───────────────────────────────────

interface DbListProps {
  items: DbSizeInfo[];
  selected: string | null;
  onSelect: (db: string) => void;
}

function DbList({ items, selected, onSelect }: DbListProps) {
  const maxBytes = Math.max(...items.map((i) => i.sizeBytes), 1);

  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          数据库 ({items.length})
        </span>
      </div>
      <div className="flex-1 overflow-auto py-0.5">
        {items.map((item) => {
          const pct = (item.sizeBytes / maxBytes) * 100;
          const isSelected = selected === item.database;
          return (
            <div
              key={item.database}
              className={cn(
                "cursor-pointer px-3 py-2 hover:bg-sidebar-accent/60",
                isSelected &&
                  "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              onClick={() => onSelect(item.database)}
            >
              <div className="flex items-center justify-between">
                <span className="truncate text-xs font-medium font-mono">
                  {item.database}
                </span>
                <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                  {formatBytes(item.sizeBytes)}
                </span>
              </div>
              {/* Size bar */}
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    isSelected ? "bg-primary" : "bg-primary/50",
                  )}
                  style={{ width: `${Math.max(pct, 1)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Sort header cell ─────────────────────────────────────────────

function SortTh({
  col,
  label,
  sortCol,
  sortDir,
  onSort,
  className,
}: {
  col: SortCol;
  label: string;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (col: SortCol) => void;
  className?: string;
}) {
  const active = sortCol === col;
  return (
    <th
      className={cn(
        "cursor-pointer select-none whitespace-nowrap px-3 py-2 text-[11px] font-semibold text-muted-foreground hover:text-foreground",
        className,
      )}
      onClick={() => onSort(col)}
    >
      <span className="flex items-center gap-1">
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ChevronUp className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )
        ) : (
          <ChevronsUpDown className="size-3 opacity-30" />
        )}
      </span>
    </th>
  );
}

// ─── Table sizes panel (right) ────────────────────────────────────

interface TableSizePanelProps {
  connectionId: string;
  database: string;
  dbType: DatabaseType;
}

function TableSizePanel({
  connectionId,
  database,
  dbType,
}: TableSizePanelProps) {
  const queryClient = useQueryClient();
  const [sortCol, setSortCol] = useState<SortCol>("total");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const key = ["table-sizes", connectionId, database];
  const {
    data: tables = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: key,
    queryFn: () => getTableSizes(connectionId, database),
    staleTime: 30_000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  };

  const sorted = [...tables].sort((a, b) => {
    let av: number | string, bv: number | string;
    switch (sortCol) {
      case "name":
        av = a.tableName;
        bv = b.tableName;
        break;
      case "data":
        av = a.dataBytes;
        bv = b.dataBytes;
        break;
      case "index":
        av = a.indexBytes;
        bv = b.indexBytes;
        break;
      case "rows":
        av = a.rowCount ?? -1;
        bv = b.rowCount ?? -1;
        break;
      default:
        av = a.totalBytes;
        bv = b.totalBytes;
        break;
    }
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const totalData = tables.reduce((s, t) => s + t.dataBytes, 0);
  const totalIndex = tables.reduce((s, t) => s + t.indexBytes, 0);
  const totalAll = tables.reduce((s, t) => s + t.totalBytes, 0);
  const maxTotal = Math.max(...tables.map((t) => t.totalBytes), 1);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{database}</span>
          <span className="text-xs text-muted-foreground">
            {tables.length} 张表 · 共 {formatBytes(totalAll)}
          </span>
        </div>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={refresh}
          title="刷新"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {/* Summary row */}
      {tables.length > 0 && (
        <div className="flex gap-6 border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          <span>
            数据：
            <strong className="text-foreground">
              {formatBytes(totalData)}
            </strong>
          </span>
          <span>
            索引：
            <strong className="text-foreground">
              {formatBytes(totalIndex)}
            </strong>
          </span>
          <span>
            合计：
            <strong className="text-foreground">{formatBytes(totalAll)}</strong>
          </span>
        </div>
      )}

      {/* Loading / error */}
      {isLoading && (
        <div className="flex items-center gap-1.5 px-4 py-4 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          加载中…
        </div>
      )}
      {isError && (
        <div className="flex items-center gap-1.5 px-4 py-4 text-xs text-destructive">
          <AlertCircle className="size-3" />
          加载失败
        </div>
      )}

      {/* Table */}
      {!isLoading && !isError && (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left">
            <thead className="sticky top-0 border-b border-border bg-muted/80 backdrop-blur-sm">
              <tr>
                <SortTh
                  col="name"
                  label="表名"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <SortTh
                  col="data"
                  label="数据"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="text-right"
                />
                <SortTh
                  col="index"
                  label="索引"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="text-right"
                />
                <SortTh
                  col="total"
                  label="合计"
                  sortCol={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                  className="text-right"
                />
                {dbType === "mysql" && (
                  <SortTh
                    col="rows"
                    label="预估行数"
                    sortCol={sortCol}
                    sortDir={sortDir}
                    onSort={handleSort}
                    className="text-right"
                  />
                )}
                <th className="px-3 py-2 text-[11px] font-semibold text-muted-foreground">
                  占比
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => {
                const pct = (t.totalBytes / maxTotal) * 100;
                return (
                  <tr
                    key={t.tableName}
                    className="border-b border-border/50 hover:bg-muted/30"
                  >
                    <td className="px-3 py-1.5 font-mono text-xs font-medium">
                      {t.tableName}
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">
                      {formatBytes(t.dataBytes)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">
                      {formatBytes(t.indexBytes)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs font-medium">
                      {formatBytes(t.totalBytes)}
                    </td>
                    {dbType === "mysql" && (
                      <td className="px-3 py-1.5 text-right font-mono text-xs text-muted-foreground">
                        {formatRows(t.rowCount)}
                      </td>
                    )}
                    <td className="w-32 px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary/60"
                            style={{ width: `${Math.max(pct, 1)}%` }}
                          />
                        </div>
                        <span className="w-8 text-right text-[10px] text-muted-foreground">
                          {pct.toFixed(0)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td
                    colSpan={dbType === "mysql" ? 6 : 5}
                    className="px-4 py-8 text-center text-xs text-muted-foreground"
                  >
                    没有表数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── DiskUsageTab — top-level export ─────────────────────────────

interface DiskUsageTabProps {
  connectionId: string;
  dbType: DatabaseType;
}

export function DiskUsageTab({ connectionId, dbType }: DiskUsageTabProps) {
  const queryClient = useQueryClient();
  const [selectedDb, setSelectedDb] = useState<string | null>(null);

  const key = useMemo(() => ["disk-usage", connectionId], [connectionId]);
  const {
    data: dbSizes = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: key,
    queryFn: () => getDiskUsage(connectionId),
    staleTime: 30_000,
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: key });
    if (selectedDb) {
      queryClient.invalidateQueries({
        queryKey: ["table-sizes", connectionId, selectedDb],
      });
    }
  }, [queryClient, key, connectionId, selectedDb]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin opacity-50" />
        <span className="text-sm">加载磁盘统计…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-destructive">
        <AlertCircle className="size-5" />
        <span className="text-sm">加载失败</span>
      </div>
    );
  }

  const totalAll = dbSizes.reduce((s, d) => s + d.sizeBytes, 0);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <HardDrive className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">
          磁盘占用 · 总计{" "}
          <strong className="text-foreground">{formatBytes(totalAll)}</strong>
          {" · "}
          {dbSizes.length} 个数据库
        </span>
        <button
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={refresh}
          title="刷新"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>

      {/* Split panel */}
      <div className="flex flex-1 overflow-hidden">
        <DbList
          items={dbSizes}
          selected={selectedDb}
          onSelect={setSelectedDb}
        />

        {selectedDb ? (
          <TableSizePanel
            key={selectedDb}
            connectionId={connectionId}
            database={selectedDb}
            dbType={dbType}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <HardDrive className="size-10 opacity-20" />
            <p className="text-sm">选择数据库查看表级别明细</p>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Loader2,
  AlertCircle,
  Filter,
  X,
  Plus,
  Eye,
  RotateCcw,
  Copy,
  Check,
  Download,
  Upload,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { copyAsInsert, copyAsCsv, copyAsJson, copyAsMarkdown } from "@/lib/copy-as";
import { Button } from "@/components/ui/button";
import { DataGrid, type SortState, type SortDir, type PendingEdit, type NewRow, type CellViewTarget, editKey } from "./data-grid";
import { ChangePreviewDialog } from "./change-preview-dialog";
import { CellViewerDialog } from "./cell-viewer-dialog";
import { ExportDialog } from "@/components/transfer/export-dialog";
import { ImportDialog } from "@/components/transfer/import-dialog";
import { getTableData, getTableColumns, executeStatements, type ColumnFilter } from "@/services/tauri-commands";
import { generateChangeSql } from "@/lib/generate-change-sql";
import { useConnections } from "@/hooks/use-connections";
import type { DatabaseType } from "@/types/database";
import { usePreferencesStore } from "@/stores/preferences-store";

interface TableDataTabProps {
  connectionId: string;
  database: string;
  schema?: string;
  table: string;
}

export function TableDataTab({ connectionId, database, schema, table }: TableDataTabProps) {
  const qc = useQueryClient();
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [showFilterRow, setShowFilterRow] = useState(false);
  const [filterMap, setFilterMap] = useState<Record<string, ColumnFilter>>({});
  const [pendingEdits, setPendingEdits] = useState<Record<string, PendingEdit>>({});
  const [pendingDeletes, setPendingDeletes] = useState<Set<number>>(new Set());
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [cellView, setCellView] = useState<CellViewTarget | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const { data: connections = [] } = useConnections();
  const conn = connections.find((c) => c.id === connectionId);
  const dbType: DatabaseType = conn?.dbType ?? "mysql";
  const { pageSize: PAGE_SIZE, gridFontSize, confirmDml } = usePreferencesStore((s) => s.prefs);

  const activeFilters = Object.values(filterMap);
  const offset = page * PAGE_SIZE;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["table-data", connectionId, database, schema, table, page, sort, activeFilters],
    queryFn: () =>
      getTableData(
        connectionId, database, schema, table,
        PAGE_SIZE, offset, sort?.column, sort?.dir,
        activeFilters.length > 0 ? activeFilters : undefined,
      ),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // Fetch PK info (stale is fine — schema rarely changes)
  const { data: columnDefs = [] } = useQuery({
    queryKey: ["table-columns", connectionId, database, schema, table],
    queryFn: () => getTableColumns(connectionId, database, schema, table),
    staleTime: 5 * 60_000,
  });
  const pkColumns = useMemo(
    () => columnDefs.filter((c) => c.isPrimaryKey).map((c) => c.name),
    [columnDefs],
  );

  const totalPages = data ? Math.ceil(data.totalCount / PAGE_SIZE) : 0;
  const rowStart = offset + 1;
  const rowEnd = data ? Math.min(offset + data.rows.length, data.totalCount) : 0;

  // ── Change helpers ────────────────────────────────────────────────

  const handleSort = useCallback((col: string, dir: SortDir | null) => {
    setPage(0);
    setSelectedRows(new Set());
    setSort(dir ? { column: col, dir } : undefined);
  }, []);

  const handleRowSelectToggle = useCallback((rowIndex: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex); else next.add(rowIndex);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback((selectAll: boolean) => {
    if (!data) return;
    setSelectedRows(selectAll ? new Set(data.rows.map((_, i) => i)) : new Set());
  }, [data]);

  const handleCopyAs = useCallback((format: "insert" | "csv" | "json" | "markdown") => {
    if (!data) return;
    const targetRows = selectedRows.size > 0
      ? data.rows.filter((_, i) => selectedRows.has(i))
      : data.rows;

    let text = "";
    if (format === "insert") {
      text = copyAsInsert(database, schema, table, data.columns, targetRows, dbType);
    } else if (format === "csv") {
      text = copyAsCsv(data.columns, targetRows);
    } else if (format === "json") {
      text = copyAsJson(data.columns, targetRows);
    } else {
      text = copyAsMarkdown(data.columns, targetRows);
    }
    void navigator.clipboard.writeText(text);
    setCopyHint(format);
    setTimeout(() => setCopyHint(null), 1800);
  }, [data, selectedRows, database, schema, table, dbType]);

  const handleFilterChange = useCallback((col: string, filter: ColumnFilter | null) => {
    setPage(0);
    setFilterMap((prev) => {
      const next = { ...prev };
      if (filter) next[col] = filter; else delete next[col];
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => { setFilterMap({}); setPage(0); }, []);

  const handleEditCommit = useCallback((edit: PendingEdit) => {
    setPendingEdits((prev) => ({ ...prev, [editKey(edit.rowIndex, edit.column)]: edit }));
  }, []);

  const handleDeleteToggle = useCallback((rowIndex: number) => {
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex); else next.add(rowIndex);
      return next;
    });
  }, []);

  const handleAddRow = useCallback(() => {
    if (!data) return;
    // New rows default all columns to null
    setNewRows((prev) => [...prev, Object.fromEntries(data.columns.map((c) => [c, null]))]);
  }, [data]);

  const handleNewRowChange = useCallback((idx: number, col: string, value: string | null) => {
    setNewRows((prev) => prev.map((row, i) => (i === idx ? { ...row, [col]: value } : row)));
  }, []);

  // ── Rollback ──────────────────────────────────────────────────────

  const handleRollback = useCallback(() => {
    setPendingEdits({});
    setPendingDeletes(new Set());
    setNewRows([]);
  }, []);

  // ── SQL generation ─────────────────────────────────────────────

  const changeSqls = useMemo(() => {
    if (!data) return [];
    return generateChangeSql({
      dbType,
      database,
      schema,
      table,
      columns: data.columns,
      pkColumns,
      rows: data.rows,
      pendingEdits,
      pendingDeletes,
      newRows,
    });
  }, [data, dbType, database, schema, table, pkColumns, pendingEdits, pendingDeletes, newRows]);

  // ── Commit ────────────────────────────────────────────────────────

  const handleCommit = useCallback(async () => {
    await executeStatements(connectionId, changeSqls, database);
    // Reset pending state and refresh data
    setPendingEdits({});
    setPendingDeletes(new Set());
    setNewRows([]);
    await qc.invalidateQueries({ queryKey: ["table-data", connectionId, database, schema, table] });
  }, [connectionId, changeSqls, qc, database, schema, table]);

  const pendingCount = Object.keys(pendingEdits).length + pendingDeletes.size + newRows.length;

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ "--grid-font-size": `${gridFontSize}px` } as React.CSSProperties}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Button
          variant="ghost" size="sm" className="h-7 w-7 p-0"
          title="刷新" onClick={() => refetch()} disabled={isFetching}
        >
          <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </Button>

        <Button
          variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs"
          onClick={handleAddRow} disabled={!data} title="新增行"
        >
          <Plus className="size-3" />新增行
        </Button>

        {/* Copy-as dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={!data}>
              {copyHint ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
              复制为
              {selectedRows.size > 0 && (
                <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                  {selectedRows.size}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="text-xs">
            <DropdownMenuItem onClick={() => handleCopyAs("insert")}>INSERT SQL</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCopyAs("csv")}>CSV</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCopyAs("json")}>JSON</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCopyAs("markdown")}>Markdown</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs"
          onClick={() => setExportOpen(true)} title="导出数据"
        >
          <Download className="size-3" />导出
        </Button>
        <Button
          variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs"
          onClick={() => setImportOpen(true)} title="导入数据"
        >
          <Upload className="size-3" />导入
        </Button>

        <Button
          variant={showFilterRow ? "secondary" : "ghost"} size="sm"
          className="h-7 gap-1 px-2 text-xs" onClick={() => setShowFilterRow((v) => !v)}
        >
          <Filter className="size-3" />
          筛选
          {activeFilters.length > 0 && (
            <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
              {activeFilters.length}
            </span>
          )}
        </Button>

        {activeFilters.length > 0 && (
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={clearFilters}>
            <X className="size-3" />清除筛选
          </Button>
        )}

        {/* Pending change controls */}
        {pendingCount > 0 && (
          <>
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
              {pendingCount} 处变更
            </span>
            <Button
              variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs"
              onClick={() => setPreviewOpen(true)} title="预览 SQL"
            >
              <Eye className="size-3" />预览
            </Button>
            {!confirmDml && (
              <Button
                variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-emerald-600 dark:text-emerald-400"
                onClick={() => void handleCommit()} title="直接提交（已关闭 DML 确认）"
              >
                提交
              </Button>
            )}
            <Button
              variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground"
              onClick={handleRollback} title="回滚所有变更"
            >
              <RotateCcw className="size-3" />回滚
            </Button>
          </>
        )}

        {sort && (
          <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
            排序: {sort.column} {sort.dir}
          </span>
        )}

        <div className="flex-1" />

        {data && data.totalCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {rowStart}–{rowEnd} / {data.totalCount.toLocaleString()} 行
          </span>
        )}

        <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
          disabled={page === 0 || isFetching} onClick={() => setPage((p) => p - 1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-[3rem] text-center text-xs text-muted-foreground">
          {totalPages > 0 ? `${page + 1} / ${totalPages}` : "—"}
        </span>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
          disabled={page >= totalPages - 1 || isFetching} onClick={() => setPage((p) => p + 1)}>
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {isLoading && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />加载中…
          </div>
        )}
        {isError && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-destructive">
            <AlertCircle className="size-4" />{String(error)}
          </div>
        )}
        {data && data.rows.length === 0 && !isLoading && (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {activeFilters.length > 0 ? "筛选条件下无匹配数据" : "表中无数据"}
          </div>
        )}
        {data && (data.rows.length > 0 || newRows.length > 0) && (
          <DataGrid
            columns={data.columns}
            rows={data.rows}
            sort={sort}
            onSort={handleSort}
            filters={filterMap}
            onFilterChange={handleFilterChange}
            showFilterRow={showFilterRow}
            pendingEdits={pendingEdits}
            onEditCommit={handleEditCommit}
            pendingDeletes={pendingDeletes}
            onDeleteToggle={handleDeleteToggle}
            newRows={newRows}
            onNewRowChange={handleNewRowChange}
            onCellView={setCellView}
            selectedRows={selectedRows}
            onRowSelectToggle={handleRowSelectToggle}
            onSelectAll={handleSelectAll}
          />
        )}
      </div>

      <ChangePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        sqls={changeSqls}
        onCommit={handleCommit}
      />

      <CellViewerDialog
        open={cellView !== null}
        onOpenChange={(open) => { if (!open) setCellView(null); }}
        columnName={cellView?.columnName ?? ""}
        value={cellView?.value}
      />

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        connectionId={connectionId}
        database={database}
        schema={schema}
        table={table}
        columnDefs={columnDefs}
      />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        connectionId={connectionId}
        database={database}
        schema={schema}
        table={table}
        columnDefs={columnDefs}
        onSuccess={() => qc.invalidateQueries({ queryKey: ["table-data"] })}
      />
    </div>
  );
}

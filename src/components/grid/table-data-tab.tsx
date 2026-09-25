import { useWorkspaceGuard } from "@/hooks/use-workspace-guard";
import { useState, useCallback, useMemo } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
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
import {
  copyAsInsert,
  copyAsCsv,
  copyAsJson,
  copyAsMarkdown,
} from "@/lib/copy-as";
import { Button } from "@/components/ui/button";
import {
  DataGrid,
  type SortState,
  type SortDir,
  type PendingEdit,
  type NewRow,
  type CellViewTarget,
  editKey,
} from "./data-grid";
import { ChangePreviewDialog } from "./change-preview-dialog";
import { CellViewerDialog } from "./cell-viewer-dialog";
import { ExportDialog } from "@/components/transfer/export-dialog";
import { ImportDialog } from "@/components/transfer/import-dialog";
import {
  getTableData,
  getTableColumns,
  executeStatements,
  type ColumnFilter,
  type TableDataResult,
} from "@/services/tauri-commands";
import { generateChangeSql } from "@/lib/generate-change-sql";
import { useConnections } from "@/hooks/use-connections";
import { useConnectionStore } from "@/stores/connection-store";
import { openConnection } from "@/services/tauri-commands";
import { formatDbError, isConnectionError } from "@/lib/error";
import type { DatabaseType } from "@/types/database";
import { usePreferencesStore } from "@/stores/preferences-store";

interface TableDataTabProps {
  tabId?: string;
  connectionId: string;
  database: string;
  schema?: string;
  table: string;
}

export function TableDataTab({
  tabId,
  connectionId,
  database,
  schema,
  table,
}: TableDataTabProps) {
  const qc = useQueryClient();
  const [draftData, setDraftData] = useState<TableDataResult | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pageCursors, setPageCursors] = useState<Record<number, string>>({});
  const [countRequested, setCountRequested] = useState(false);
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [showFilterRow, setShowFilterRow] = useState(false);
  const [filterMap, setFilterMap] = useState<Record<string, ColumnFilter>>({});
  const [pendingEdits, setPendingEdits] = useState<Record<string, PendingEdit>>(
    {},
  );
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
  const markPoolOpen = useConnectionStore((s) => s.markPoolOpen);

  const handleReconnect = async () => {
    if (!conn) return;
    await openConnection(conn);
    markPoolOpen(conn.id);
    await refetch();
  };
  const {
    pageSize: PAGE_SIZE,
    gridFontSize,
    confirmDml,
  } = usePreferencesStore((s) => s.prefs);

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

  const binaryColumns = useMemo(
    () =>
      columnDefs
        .filter((c) =>
          /^(bytea|(?:tiny|medium|long)?blob|(?:var)?binary)(?:\(|$)/i.test(
            c.dataType,
          ),
        )
        .map((c) => c.name),
    [columnDefs],
  );

  const activeFilters = Object.values(filterMap);
  const offset = page * PAGE_SIZE;
  const cursorKey = pkColumns.length === 1 && (!sort || sort.column === pkColumns[0]) ? pkColumns[0] : undefined;
  const cursor = pageCursors[page];
  const pageFilters: ColumnFilter[] = cursorKey && cursor !== undefined
    ? [...activeFilters, { column: cursorKey, op: sort?.dir === "DESC" ? "<" : ">", value: cursor }]
    : activeFilters;
  const { data: countData, isFetching: counting, error: countError } = useQuery({
    queryKey: ["table-count", connectionId, database, schema, table, activeFilters],
    queryFn: () => getTableData(connectionId, database, schema, table, 0, 0, undefined, undefined, activeFilters, { includeCount: true }),
    enabled: countRequested,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const {
    data: fetchedData,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: [
      "table-data",
      connectionId,
      database,
      schema,
      table,
      page,
      PAGE_SIZE,
      sort,
      activeFilters,
      cursor,
      pkColumns,
    ],
    queryFn: () =>
      getTableData(
        connectionId,
        database,
        schema,
        table,
        PAGE_SIZE + 1,
        cursorKey && cursor !== undefined ? 0 : offset,
        sort?.column,
        sort?.dir,
        pageFilters.length > 0 ? pageFilters : undefined,
        { stableColumns: pkColumns },
      ),
    enabled: columnDefs.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const hasPending =
    Object.keys(pendingEdits).length > 0 ||
    pendingDeletes.size > 0 ||
    newRows.length > 0;
  useWorkspaceGuard(tabId ?? `${connectionId}/${database}/${schema}/${table}`, committing ? "数据正在提交，请等待完成。" : hasPending ? "此表有尚未提交的数据变更，关闭将丢弃变更。" : null);
  const pageData = useMemo(() => fetchedData ? {...fetchedData, rows: fetchedData.rows.slice(0, PAGE_SIZE)} : undefined, [fetchedData, PAGE_SIZE]);
  const data = hasPending ? (draftData ?? pageData) : pageData;

  const totalCount = countData?.totalCount ?? (data && data.totalCount >= 0 ? data.totalCount : undefined);
  const hasNextPage = fetchedData ? fetchedData.rows.length > PAGE_SIZE : false;
  const rowStart = data?.rows.length ? offset + 1 : 0;
  const rowEnd = offset + (data?.rows.length ?? 0);
  const nextPage = () => {
    if (cursorKey && data?.rows.length) {
      const value = data.rows[data.rows.length - 1]?.[data.columns.indexOf(cursorKey)];
      if (value != null) setPageCursors(prev => ({...prev, [page + 1]: String(value)}));
    }
    setSelectedRows(new Set());
    setPage(p => p + 1);
  };

  // ── Change helpers ────────────────────────────────────────────────

  const handleSort = useCallback(
    (col: string, dir: SortDir | null) => {
      if (hasPending || committing) return;
      setPage(0);
      setPageCursors({});
      setCountRequested(false);
      setSelectedRows(new Set());
      setSort(dir ? { column: col, dir } : undefined);
    },
    [hasPending, committing],
  );

  const handleRowSelectToggle = useCallback((rowIndex: number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(
    (selectAll: boolean) => {
      if (!data) return;
      setSelectedRows(
        selectAll ? new Set(data.rows.map((_, i) => i)) : new Set(),
      );
    },
    [data],
  );

  const handleCopyAs = useCallback(
    (format: "insert" | "csv" | "json" | "markdown") => {
      if (!data) return;
      const targetRows =
        selectedRows.size > 0
          ? data.rows.filter((_, i) => selectedRows.has(i))
          : data.rows;

      let text: string;
      if (format === "insert") {
        text = copyAsInsert(
          database,
          schema,
          table,
          data.columns,
          targetRows,
          dbType,
        );
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
    },
    [data, selectedRows, database, schema, table, dbType],
  );

  const handleFilterChange = useCallback(
    (col: string, filter: ColumnFilter | null) => {
      if (hasPending || committing) return;
      setPage(0);
      setPageCursors({});
      setCountRequested(false);
      setSelectedRows(new Set());
      setFilterMap((prev) => {
        const next = { ...prev };
        if (filter) next[col] = filter;
        else delete next[col];
        return next;
      });
    },
    [hasPending, committing],
  );

  const clearFilters = useCallback(() => {
    if (hasPending || committing) return;
    setFilterMap({});
    setPage(0);
    setPageCursors({});
    setCountRequested(false);
    setSelectedRows(new Set());
  }, [hasPending, committing]);

  const handleEditCommit = useCallback(
    (edit: PendingEdit) => {
      if (!data || pkColumns.length === 0 || committing) return;
      setDraftData((prev) => (hasPending ? (prev ?? data) : data));
      setPendingEdits((prev) => {
        const next = { ...prev };
        const original =
          edit.originalValue == null
            ? null
            : typeof edit.originalValue === "object"
              ? JSON.stringify(edit.originalValue)
              : String(edit.originalValue);
        const key = editKey(edit.rowIndex, edit.column);
        if (edit.newValue === original) delete next[key];
        else next[key] = edit;
        return next;
      });
    },
    [data, pkColumns.length, committing, hasPending],
  );

  const handleDeleteToggle = useCallback(
    (rowIndex: number) => {
      if (!data || pkColumns.length === 0 || committing) return;
      setDraftData((prev) => (hasPending ? (prev ?? data) : data));
      setPendingDeletes((prev) => {
        const next = new Set(prev);
        if (next.has(rowIndex)) next.delete(rowIndex);
        else next.add(rowIndex);
        return next;
      });
    },
    [data, pkColumns.length, committing, hasPending],
  );

  const handleAddRow = useCallback(() => {
    if (!data || committing) return;
    setDraftData((prev) => (hasPending ? (prev ?? data) : data));
    setNewRows((prev) => [...prev, {}]);
  }, [data, committing, hasPending]);

  const handleNewRowChange = useCallback(
    (idx: number, col: string, value: string | null | undefined) => {
      if (committing) return;
      setNewRows((prev) =>
        prev.map((row, i) => (i === idx ? { ...row, [col]: value } : row)),
      );
    },
    [committing],
  );

  // ── Rollback ──────────────────────────────────────────────────────

  const handleRollback = useCallback(() => {
    if (committing) return;
    setDraftData(null);
    setCommitError(null);
    setPendingEdits({});
    setPendingDeletes(new Set());
    setNewRows([]);
  }, [committing]);

  // ── SQL generation ─────────────────────────────────────────────

  const changeSqls = useMemo(() => {
    if (!data) return [];
    return generateChangeSql({
      dbType,
      database,
      schema,
      table,
      columns: data.columns,
      binaryColumns,
      pkColumns,
      rows: data.rows,
      pendingEdits,
      pendingDeletes,
      newRows,
    });
  }, [
    data,
    dbType,
    database,
    schema,
    table,
    pkColumns,
    binaryColumns,
    pendingEdits,
    pendingDeletes,
    newRows,
  ]);

  // ── Commit ────────────────────────────────────────────────────────

  const handleCommit = useCallback(async () => {
    if (committing || changeSqls.length === 0) return;
    setCommitting(true);
    setCommitError(null);
    try {
      await executeStatements(connectionId, changeSqls, database);
      // Reset pending state and refresh data
      setPendingEdits({});
      setPendingDeletes(new Set());
      setNewRows([]);
      setDraftData(null);
      setSelectedRows(new Set());
      await qc.invalidateQueries({ queryKey: ["table-count", connectionId, database, schema, table] });
      await qc.invalidateQueries({
        queryKey: ["table-data", connectionId, database, schema, table],
      });
    } catch (e) {
      setCommitError(formatDbError(e));
      throw e;
    } finally {
      setCommitting(false);
    }
  }, [connectionId, changeSqls, qc, database, schema, table, committing]);

  const pendingCount =
    Object.keys(pendingEdits).length + pendingDeletes.size + newRows.length;

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ "--grid-font-size": `${gridFontSize}px` } as React.CSSProperties}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          title="刷新"
          onClick={() => refetch()}
          disabled={isFetching || hasPending || committing}
        >
          <RefreshCw
            className={`size-3.5 ${isFetching ? "animate-spin" : ""}`}
          />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={handleAddRow}
          disabled={!data || committing || conn?.readonly}
          title="新增行"
        >
          <Plus className="size-3" />
          新增行
        </Button>

        {/* Copy-as dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              disabled={!data}
            >
              {copyHint ? (
                <Check className="size-3 text-emerald-500" />
              ) : (
                <Copy className="size-3" />
              )}
              复制为
              {selectedRows.size > 0 && (
                <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                  {selectedRows.size}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="text-xs">
            <DropdownMenuItem onClick={() => handleCopyAs("insert")}>
              INSERT SQL
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCopyAs("csv")}>
              CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCopyAs("json")}>
              JSON
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCopyAs("markdown")}>
              Markdown
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setExportOpen(true)}
          title="导出数据"
        >
          <Download className="size-3" />
          导出
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setImportOpen(true)}
          title="导入数据"
        >
          <Upload className="size-3" />
          导入
        </Button>

        <Button
          variant={showFilterRow ? "secondary" : "ghost"}
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setShowFilterRow((v) => !v)}
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
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={clearFilters}
          >
            <X className="size-3" />
            清除筛选
          </Button>
        )}

        {/* Pending change controls */}
        {pendingCount > 0 && (
          <>
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
              {pendingCount} 处变更
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setPreviewOpen(true)}
              title="预览 SQL"
            >
              <Eye className="size-3" />
              预览
            </Button>
            {!confirmDml && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-emerald-600 dark:text-emerald-400"
                disabled={committing}
                onClick={() => void handleCommit().catch(() => {})}
                title="直接提交（已关闭 DML 确认）"
              >
                提交
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground"
              onClick={handleRollback}
              title="回滚所有变更"
            >
              <RotateCcw className="size-3" />
              回滚
            </Button>
          </>
        )}

        {sort && (
          <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
            排序: {sort.column} {sort.dir}
          </span>
        )}

        <div className="flex-1" />

        {data && <span className="text-xs text-muted-foreground">{rowStart}–{rowEnd} 行{totalCount !== undefined ? ` / 共 ${totalCount.toLocaleString()} 行` : ""}</span>}
        <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={counting}
          onClick={() => setCountRequested(true)}>{counting ? "统计中…" : totalCount !== undefined ? "总数已统计" : "统计总行数"}</Button>
        {countError && <span role="alert" className="text-xs text-destructive">总数统计失败</span>}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          disabled={page === 0 || isFetching || hasPending || committing}
          aria-label="上一页"
          onClick={() => { setSelectedRows(new Set()); setPage((p) => p - 1); }}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-[3rem] text-center text-xs text-muted-foreground">
          第 {page + 1} 页
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          disabled={
            !hasNextPage || isFetching || hasPending || committing
          }
          aria-label="下一页"
          onClick={nextPage}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {data && (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          {conn?.readonly
            ? "只读连接，无法编辑数据。"
            : pkColumns.length === 0
              ? "此表无主键，无法编辑已有行。"
              : "双击单元格或点击铅笔编辑；Enter / Tab 暂存并移到下一格，Esc 取消。修改后预览并提交。"}
        </p>
      )}
      {hasPending && (
        <p className="px-3 py-1 text-xs text-amber-600">
          请提交或回滚变更后再翻页、排序或筛选。
        </p>
      )}
      {commitError && (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          {commitError}
        </p>
      )}
      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {isLoading && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            加载中…
          </div>
        )}
        {isError && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4" />
              {isConnectionError(error) ? "连接已断开" : "加载失败"}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatDbError(error)}
            </div>
            {isConnectionError(error) && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void handleReconnect()}
              >
                重新连接
              </Button>
            )}
          </div>
        )}
        {data &&
          data.rows.length === 0 &&
          newRows.length === 0 &&
          !isLoading && (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {activeFilters.length > 0 ? "筛选条件下无匹配数据" : "表中无数据"}
            </div>
          )}
        {data &&
          (data.rows.length > 0 || newRows.length > 0 || showFilterRow) && (
            <DataGrid
              columns={data.columns}
              rows={data.rows}
              sort={sort}
              onSort={handleSort}
              filters={filterMap}
              onFilterChange={handleFilterChange}
              showFilterRow={showFilterRow}
              pendingEdits={pendingEdits}
              onEditCommit={
                pkColumns.length > 0 && !conn?.readonly && !committing
                  ? handleEditCommit
                  : undefined
              }
              pendingDeletes={pendingDeletes}
              onDeleteToggle={
                pkColumns.length > 0 && !conn?.readonly && !committing
                  ? handleDeleteToggle
                  : undefined
              }
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
        onOpenChange={(open) => {
          if (!open) setCellView(null);
        }}
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

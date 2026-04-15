import { useRef, useMemo, useState, useCallback, useEffect } from "react";
import { useDebounce } from "@/hooks/use-debounce";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  type Table,
  type SortingState,
  type ColumnOrderState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, ArrowDown, ArrowUpDown, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ColumnFilter } from "@/services/tauri-commands";

export type GridRow = unknown[];
export type SortDir = "ASC" | "DESC";

export interface SortState {
  column: string;
  dir: SortDir;
}

export interface PendingEdit {
  rowIndex: number;
  column: string;
  originalValue: unknown;
  /** null = SQL NULL; string = literal value (including "") */
  newValue: string | null;
}

/** New row values: colName → value (null = NULL, "" = empty string) */
export type NewRow = Record<string, string | null>;

export function editKey(rowIndex: number, colName: string) {
  return `${rowIndex}:${colName}`;
}

// ─── Filter cell ──────────────────────────────────────────────────

type FilterOp = ColumnFilter["op"];
const OPS: FilterOp[] = ["=", "!=", "LIKE", "NOT LIKE", ">", "<", ">=", "<=", "IS NULL", "IS NOT NULL"];
const NO_VALUE_OPS: FilterOp[] = ["IS NULL", "IS NOT NULL"];

function FilterCell({
  colName, colWidth, filter, onChange,
}: {
  colName: string;
  colWidth: number;
  filter?: ColumnFilter;
  onChange: (f: ColumnFilter | null) => void;
}) {
  const op: FilterOp = filter?.op ?? "=";
  const noValue = NO_VALUE_OPS.includes(op);

  // Local input state so keystrokes don't lag; debounce propagation to parent
  const [localValue, setLocalValue] = useState(filter?.value ?? "");
  const debouncedValue = useDebounce(localValue, 300);

  // Propagate debounced value upstream
  useEffect(() => {
    if (noValue) return;
    onChange(debouncedValue === "" ? null : { column: colName, op, value: debouncedValue });
    // Only trigger when debounced value or op changes; onChange identity is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedValue, op, noValue, colName]);

  // Sync local value when external filter is cleared (e.g., "清除筛选" button)
  useEffect(() => {
    setLocalValue(filter?.value ?? "");
  }, [filter?.value]);

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0.5 border-r border-border/50 px-1",
        filter && "bg-primary/10",
      )}
      style={{ width: colWidth, height: "100%" }}
    >
      <select
        className="h-5 w-14 shrink-0 cursor-pointer rounded border-none bg-transparent text-[10px] text-muted-foreground outline-none"
        value={op}
        onChange={(e) => {
          const newOp = e.target.value as FilterOp;
          if (NO_VALUE_OPS.includes(newOp)) {
            setLocalValue("");
            onChange({ column: colName, op: newOp, value: "" });
          } else {
            onChange(null);
            setLocalValue("");
          }
        }}
      >
        {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {!noValue && (
        <input
          className="min-w-0 flex-1 rounded bg-transparent px-1 text-[11px] outline-none focus:ring-1 focus:ring-ring"
          placeholder="值…"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
        />
      )}
    </div>
  );
}

// ─── Cell editor ──────────────────────────────────────────────────

function CellEditor({
  initialValue,
  onCommit,
  onCancel,
  onMoveNext,
}: {
  initialValue: string | null;
  onCommit: (v: string | null) => void;
  onCancel: () => void;
  onMoveNext: () => void;
}) {
  const [isNull, setIsNull] = useState(initialValue === null);
  const [val, setVal] = useState(initialValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isNull) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isNull]);

  const commit = () => onCommit(isNull ? null : val);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      commit();
      onMoveNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const toggleNull = () => {
    setIsNull((v) => {
      if (!v) {
        // switching to NULL — commit immediately when toggle is clicked
        return true;
      }
      // switching back to value
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
      return false;
    });
  };

  return (
    <div className="flex h-full w-full items-center ring-2 ring-primary ring-inset">
      {isNull ? (
        <span className="flex-1 px-2 font-mono text-[11px] italic text-muted-foreground/70">
          NULL
        </span>
      ) : (
        <input
          ref={inputRef}
          className="h-full flex-1 bg-background px-2 text-xs outline-none"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commit}
        />
      )}
      {/* NULL toggle */}
      <button
        className={cn(
          "shrink-0 px-1.5 text-[10px] font-medium transition-colors",
          isNull
            ? "bg-primary/20 text-primary"
            : "text-muted-foreground/50 hover:text-muted-foreground",
        )}
        title={isNull ? "取消 NULL，改为字符串" : "设为 NULL"}
        onMouseDown={(e) => { e.preventDefault(); toggleNull(); }}
      >
        N
      </button>
    </div>
  );
}

// ─── Cell display ─────────────────────────────────────────────────

interface CellDisplayInfo {
  text: string;
  kind: "null" | "empty" | "normal";
}

function cellDisplay(value: unknown): CellDisplayInfo {
  if (value === null || value === undefined) return { text: "NULL", kind: "null" };
  if (typeof value === "string" && value === "") return { text: "", kind: "empty" };
  if (typeof value === "boolean") return { text: value ? "true" : "false", kind: "normal" };
  if (typeof value === "object") return { text: JSON.stringify(value), kind: "normal" };
  return { text: String(value), kind: "normal" };
}

function GridCell({
  value,
  isEditing,
  isEdited,
  isDeleted,
  onStartEdit,
  onCommit,
  onCancel,
  onMoveNext,
  onView,
}: {
  value: unknown;
  isEditing: boolean;
  isEdited: boolean;
  isDeleted: boolean;
  onStartEdit: () => void;
  onCommit: (v: string | null) => void;
  onCancel: () => void;
  onMoveNext: () => void;
  onView?: () => void;
}) {
  const { text, kind } = cellDisplay(value);

  if (isEditing) {
    return (
      <CellEditor
        initialValue={kind === "null" ? null : text}
        onCommit={onCommit}
        onCancel={onCancel}
        onMoveNext={onMoveNext}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex h-full w-full cursor-pointer items-center overflow-hidden px-2 py-1 text-xs",
        kind === "null" && !isEdited && "italic text-muted-foreground/50",
        kind === "empty" && !isEdited && "text-muted-foreground/40",
        isEdited && "bg-amber-500/15",
        isDeleted && "line-through opacity-40",
        !isEdited && !isDeleted && "hover:bg-primary/10",
      )}
      title={kind === "null" ? "NULL" : kind === "empty" ? "(empty string)" : text}
      onClick={!isDeleted ? onView : undefined}
      onDoubleClick={!isDeleted ? onStartEdit : undefined}
    >
      {isEdited && <span className="mr-1 size-1.5 shrink-0 rounded-full bg-amber-500" />}
      {kind === "null" ? (
        <span className="truncate">NULL</span>
      ) : kind === "empty" ? (
        <span className="truncate font-mono text-[10px]">(empty)</span>
      ) : (
        <span className="truncate">{text}</span>
      )}
    </div>
  );
}

// ─── New row cell ─────────────────────────────────────────────────

function NewRowCell({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const isNull = value === null;

  return (
    <div className="flex h-full w-full items-center bg-emerald-500/5">
      {isNull ? (
        <span className="flex-1 px-2 font-mono text-[11px] italic text-muted-foreground/50">
          NULL
        </span>
      ) : (
        <input
          className="h-full flex-1 bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground/30 focus:ring-1 focus:ring-emerald-500 focus:ring-inset"
          value={value}
          placeholder="(empty)"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <button
        className={cn(
          "shrink-0 px-1.5 text-[10px] font-medium transition-colors",
          isNull
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground/40 hover:text-muted-foreground",
        )}
        title={isNull ? "取消 NULL" : "设为 NULL"}
        onMouseDown={(e) => { e.preventDefault(); onChange(isNull ? "" : null); }}
      >
        N
      </button>
    </div>
  );
}

// ─── Constants ────────────────────────────────────────────────────

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;
const FILTER_ROW_HEIGHT = 28;

// ─── DataGrid ─────────────────────────────────────────────────────

export interface CellViewTarget {
  columnName: string;
  value: unknown;
}

interface DataGridProps {
  selectedRows?: Set<number>;
  onRowSelectToggle?: (rowIndex: number) => void;
  onSelectAll?: (selectAll: boolean) => void;
  columns: string[];
  rows: GridRow[];
  sort?: SortState;
  onSort?: (col: string, dir: SortDir | null) => void;
  filters?: Record<string, ColumnFilter>;
  onFilterChange?: (col: string, filter: ColumnFilter | null) => void;
  showFilterRow?: boolean;
  pendingEdits?: Record<string, PendingEdit>;
  onEditCommit?: (edit: PendingEdit) => void;
  pendingDeletes?: Set<number>;
  onDeleteToggle?: (rowIndex: number) => void;
  newRows?: NewRow[];
  onNewRowChange?: (newRowIndex: number, col: string, value: string | null) => void;
  onCellView?: (target: CellViewTarget) => void;
}

export function DataGrid({
  columns,
  rows,
  sort,
  onSort,
  filters = {},
  onFilterChange,
  showFilterRow = false,
  pendingEdits = {},
  onEditCommit,
  pendingDeletes = new Set(),
  onDeleteToggle,
  newRows = [],
  onNewRowChange,
  onCellView,
  selectedRows = new Set(),
  onRowSelectToggle,
  onSelectAll,
}: DataGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [activeEdit, setActiveEdit] = useState<{ rowIndex: number; colIndex: number } | null>(null);
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([]);
  const [draggingColId, setDraggingColId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId] = useState<string | null>(null);

  // Reset edit + column order when columns list changes (different table)
  useEffect(() => { setActiveEdit(null); }, [rows]);
  useEffect(() => { setColumnOrder([]); }, [columns]);

  const colDefs = useMemo<ColumnDef<GridRow>[]>(
    () =>
      columns.map((col, colIdx) => ({
        id: col || String(colIdx),
        accessorFn: (row: GridRow) => row[colIdx],
        header: col,
        size: 140,
        minSize: 60,
      })),
    [columns],
  );

  const sortingState: SortingState = sort ? [{ id: sort.column, desc: sort.dir === "DESC" }] : [];

  const table: Table<GridRow> = useReactTable({
    data: rows,
    columns: colDefs,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    state: { sorting: sortingState, columnOrder },
    onColumnOrderChange: setColumnOrder,
    manualSorting: true,
    enableSortingRemoval: true,
  });

  const { rows: tableRows } = table.getRowModel();

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom = totalHeight - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  const headerGroups = table.getHeaderGroups();

  const handleHeaderClick = (colId: string) => {
    if (!onSort) return;
    if (!sort || sort.column !== colId) onSort(colId, "ASC");
    else if (sort.dir === "ASC") onSort(colId, "DESC");
    else onSort(colId, null);
  };

  // ── Column drag-to-reorder ────────────────────────────────────────
  const handleDragStart = useCallback((colId: string) => {
    setDraggingColId(colId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, colId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverColId(colId);
  }, []);

  const handleDrop = useCallback((toColId: string) => {
    if (!draggingColId || draggingColId === toColId) return;
    const allIds = table.getAllLeafColumns().map((c) => c.id);
    const current = columnOrder.length > 0 ? columnOrder : allIds;
    const fromIdx = current.indexOf(draggingColId);
    const toIdx = current.indexOf(toColId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...current];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, draggingColId);
    setColumnOrder(next);
    setDraggingColId(null);
    setDragOverColId(null);
  }, [draggingColId, columnOrder, table]);

  const handleDragEnd = useCallback(() => {
    setDraggingColId(null);
    setDragOverColId(null);
  }, []);

  const handleCommit = useCallback(
    (rowIndex: number, colIndex: number, newValue: string | null) => {
      const colName = columns[colIndex] ?? "";
      const originalValue = rows[rowIndex]?.[colIndex];
      // Detect no-change: null→null or string→same string
      const origIsNull = originalValue === null || originalValue === undefined;
      const newIsNull = newValue === null;
      const origStr = origIsNull ? null : String(originalValue);
      if (newIsNull === origIsNull && newValue === origStr) {
        setActiveEdit(null);
        return;
      }
      onEditCommit?.({ rowIndex, column: colName, originalValue, newValue });
      setActiveEdit(null);
    },
    [columns, rows, onEditCommit],
  );

  const moveNext = useCallback(
    (rowIndex: number, colIndex: number) => {
      const nextCol = colIndex + 1;
      if (nextCol < columns.length) {
        setActiveEdit({ rowIndex, colIndex: nextCol });
      } else if (rowIndex + 1 < rows.length) {
        setActiveEdit({ rowIndex: rowIndex + 1, colIndex: 0 });
        virtualizer.scrollToIndex(rowIndex + 1);
      } else {
        setActiveEdit(null);
      }
    },
    [columns.length, rows.length, virtualizer],
  );

  const headerHeight = showFilterRow ? HEADER_HEIGHT + FILTER_ROW_HEIGHT : HEADER_HEIGHT;

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ fontSize: "var(--grid-font-size, 12px)" }}
    >
      {/* Sticky header */}
      <div
        ref={headerRef}
        className="shrink-0 overflow-hidden border-b border-border bg-muted/60"
        style={{ height: headerHeight }}
      >
        <div className="flex" style={{ height: HEADER_HEIGHT }}>
          {/* Select-all checkbox */}
          {onRowSelectToggle && (
            <div className="flex w-8 shrink-0 items-center justify-center border-r border-border">
              <input
                type="checkbox"
                className="size-3 cursor-pointer accent-primary"
                checked={rows.length > 0 && selectedRows.size === rows.length}
                ref={(el) => {
                  if (el) el.indeterminate = selectedRows.size > 0 && selectedRows.size < rows.length;
                }}
                onChange={(e) => onSelectAll?.(e.target.checked)}
              />
            </div>
          )}
          <div className="flex w-10 shrink-0 items-center justify-center border-r border-border text-[10px] text-muted-foreground/60">
            #
          </div>
          {headerGroups[0]?.headers.map((header) => {
            const colId = header.column.id;
            const isSorted = sort?.column === colId;
            const sortDir = isSorted ? sort?.dir : null;
            const isDragging = draggingColId === colId;
            const isDragOver = dragOverColId === colId && draggingColId !== colId;

            return (
              <div
                key={header.id}
                draggable
                className={cn(
                  "relative flex shrink-0 select-none items-center gap-1 border-r border-border px-2 transition-colors",
                  onSort && !isDragging && "cursor-grab hover:bg-muted",
                  isSorted && "bg-primary/10",
                  isDragging && "cursor-grabbing opacity-40",
                  isDragOver && "border-l-2 border-l-primary bg-primary/10",
                )}
                style={{ width: header.getSize() }}
                onClick={() => handleHeaderClick(colId)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  handleDragStart(colId);
                }}
                onDragOver={(e) => handleDragOver(e, colId)}
                onDrop={() => handleDrop(colId)}
                onDragEnd={handleDragEnd}
              >
                <span className="truncate text-xs font-medium">
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </span>
                {onSort && (
                  <span className="ml-auto shrink-0 text-muted-foreground/60">
                    {isSorted && sortDir === "ASC" ? (
                      <ArrowUp className="size-3 text-primary" />
                    ) : isSorted && sortDir === "DESC" ? (
                      <ArrowDown className="size-3 text-primary" />
                    ) : (
                      <ArrowUpDown className="size-3 opacity-30" />
                    )}
                  </span>
                )}
                {/* Column resize handle — prevents drag from starting here */}
                <div
                  className={cn(
                    "absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none opacity-0 hover:bg-primary hover:opacity-100",
                    header.column.getIsResizing() && "bg-primary opacity-100",
                  )}
                  draggable={false}
                  onMouseDown={(e) => { e.stopPropagation(); header.getResizeHandler()(e); }}
                  onTouchStart={(e) => { e.stopPropagation(); header.getResizeHandler()(e); }}
                />
              </div>
            );
          })}
        </div>

        {showFilterRow && (
          <div className="flex border-t border-border/50" style={{ height: FILTER_ROW_HEIGHT }}>
            {onRowSelectToggle && <div className="w-8 shrink-0 border-r border-border/50" />}
            <div className="w-10 shrink-0 border-r border-border/50" />
            {headerGroups[0]?.headers.map((header) => (
              <FilterCell
                key={header.id}
                colName={header.column.id}
                colWidth={header.getSize()}
                filter={filters[header.column.id]}
                onChange={(f) => onFilterChange?.(header.column.id, f)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto"
        onScroll={() => {
          if (headerRef.current && containerRef.current) {
            headerRef.current.scrollLeft = containerRef.current.scrollLeft;
          }
        }}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          {paddingTop > 0 && <div style={{ height: paddingTop }} />}

          {virtualItems.map((virtualRow) => {
            const row = tableRows[virtualRow.index]!;
            const rowIdx = virtualRow.index;
            const isEven = rowIdx % 2 === 0;
            const isDeleted = pendingDeletes.has(rowIdx);

            return (
              <div
                key={row.id}
                className={cn(
                  "group flex border-b border-border/50",
                  isDeleted ? "bg-destructive/10" : isEven ? "bg-background" : "bg-muted/20",
                  !isDeleted && "hover:bg-primary/5",
                )}
                style={{ height: ROW_HEIGHT }}
              >
                {/* Row checkbox */}
                {onRowSelectToggle && (
                  <div className="flex w-8 shrink-0 items-center justify-center border-r border-border/50">
                    <input
                      type="checkbox"
                      className="size-3 cursor-pointer accent-primary"
                      checked={selectedRows.has(rowIdx)}
                      onChange={() => onRowSelectToggle(rowIdx)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                )}
                <div
                  className="relative flex w-10 shrink-0 cursor-pointer items-center justify-center border-r border-border/50 text-[10px] text-muted-foreground/50 select-none"
                  onClick={() => onDeleteToggle?.(rowIdx)}
                  title={isDeleted ? "取消删除" : "标记删除"}
                >
                  <span className="group-hover:hidden">{rowIdx + 1}</span>
                  <Trash2 className={cn("hidden size-3 group-hover:block", isDeleted ? "text-destructive" : "text-muted-foreground/60")} />
                </div>

                {row.getVisibleCells().map((cell, colIdx) => {
                  const colName = columns[colIdx] ?? "";
                  const key = editKey(rowIdx, colName);
                  const isEditing = activeEdit?.rowIndex === rowIdx && activeEdit?.colIndex === colIdx;
                  const pending = pendingEdits[key];
                  const displayValue = pending !== undefined ? pending.newValue : cell.getValue();

                  return (
                    <div
                      key={cell.id}
                      className="shrink-0 border-r border-border/50"
                      style={{ width: cell.column.getSize() }}
                    >
                      <GridCell
                        value={displayValue}
                        isEditing={isEditing}
                        isEdited={!!pending}
                        isDeleted={isDeleted}
                        onStartEdit={() => setActiveEdit({ rowIndex: rowIdx, colIndex: colIdx })}
                        onCommit={(v) => handleCommit(rowIdx, colIdx, v)}
                        onCancel={() => setActiveEdit(null)}
                        onMoveNext={() => moveNext(rowIdx, colIdx)}
                        onView={onCellView ? () => onCellView({ columnName: colName, value: displayValue }) : undefined}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}

          {paddingBottom > 0 && <div style={{ height: paddingBottom }} />}
        </div>

        {/* New rows */}
        {newRows.map((newRow, newRowIdx) => (
          <div
            key={`new-${newRowIdx}`}
            className="flex border-b border-emerald-500/30 bg-emerald-500/10"
            style={{ height: ROW_HEIGHT }}
          >
            <div className="flex w-10 shrink-0 items-center justify-center border-r border-emerald-500/20 text-[10px] text-emerald-600 select-none dark:text-emerald-400">
              +{newRowIdx + 1}
            </div>
            {columns.map((col, colIdx) => {
              const header = headerGroups[0]?.headers[colIdx];
              const width = header?.getSize() ?? 140;
              return (
                <div key={col} className="shrink-0 border-r border-emerald-500/20" style={{ width }}>
                  <NewRowCell
                    value={newRow[col] ?? null}
                    onChange={(v) => onNewRowChange?.(newRowIdx, col, v)}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

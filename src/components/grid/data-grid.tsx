import { useRef, useMemo, useState, useCallback, useEffect } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  type Table,
  type SortingState,
  type ColumnOrderState,
  type ColumnSizingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Trash2,
  Eye,
  Pencil,
  Copy,
  Columns3,
  CircleSlash,
  Filter,
  FilterX,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ColumnFilter } from "@/services/tauri-commands";
import {
  cellDisplay,
  fitColumnWidth,
  MIN_COLUMN_WIDTH,
  toTsv,
} from "@/lib/grid-utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePreferencesStore } from "@/stores/preferences-store";

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
export type NewRow = Record<string, string | null | undefined>;

export function editKey(rowIndex: number, colName: string) {
  return `${rowIndex}:${colName}`;
}

// ─── Filter cell ──────────────────────────────────────────────────

type FilterOp = ColumnFilter["op"];
const OPS: FilterOp[] = [
  "=",
  "!=",
  "LIKE",
  "NOT LIKE",
  ">",
  "<",
  ">=",
  "<=",
  "IS NULL",
  "IS NOT NULL",
];
const NO_VALUE_OPS: FilterOp[] = ["IS NULL", "IS NOT NULL"];

function FilterCell({
  colName,
  colWidth,
  filter,
  onChange,
}: {
  colName: string;
  colWidth: number;
  filter?: ColumnFilter;
  onChange: (f: ColumnFilter | null) => void;
}) {
  const [op, setOp] = useState<FilterOp>(filter?.op ?? "=");
  const noValue = NO_VALUE_OPS.includes(op);
  const [localValue, setLocalValue] = useState(filter?.value ?? "");

  const committedKey = JSON.stringify(filter ?? null);
  const [previousKey, setPreviousKey] = useState(committedKey);
  if (previousKey !== committedKey) {
    setPreviousKey(committedKey);
    setOp(filter?.op ?? "=");
    setLocalValue(filter?.value ?? "");
  }

  const applyFilter = () => {
    onChange(
      noValue || localValue !== ""
        ? { column: colName, op, value: noValue ? "" : localValue }
        : null,
    );
  };

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
          setOp(newOp);
          if (NO_VALUE_OPS.includes(newOp)) {
            setLocalValue("");
            onChange({ column: colName, op: newOp, value: "" });
          }
        }}
      >
        {OPS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {!noValue && (
        <input
          className="min-w-0 flex-1 rounded bg-transparent px-1 text-[11px] outline-none focus:ring-1 focus:ring-ring"
          placeholder="值…（Enter 筛选）"
          aria-label={`${colName} 筛选值`}
          title="输入完成后按 Enter 执行筛选"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (
              e.key === "Enter" &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              applyFilter();
            }
          }}
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

  // Finishing moves focus back to the grid, which blurs the input; the
  // blur must not commit a second time (or after Escape).
  const finished = useRef(false);
  const commit = () => {
    if (finished.current) return;
    finished.current = true;
    onCommit(isNull ? null : val);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      commit();
      onMoveNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      finished.current = true;
      onCancel();
    }
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
          aria-label="编辑单元格"
          className="h-full min-w-0 flex-1 bg-background px-2 outline-none"
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
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          if (isNull) setIsNull(false);
          else if (!finished.current) {
            finished.current = true;
            onCommit(null);
          }
        }}
      >
        N
      </button>
    </div>
  );
}

// ─── Cell display ─────────────────────────────────────────────────

function GridCell({
  value,
  isEditing,
  isEdited,
  isDeleted,
  isSelected,
  isFocused,
  onStartEdit,
  onCommit,
  onCancel,
  onMoveNext,
  onView,
  onMouseDown,
  onMouseEnter,
  onContextMenu,
}: {
  value: unknown;
  isEditing: boolean;
  isEdited: boolean;
  isDeleted: boolean;
  isSelected: boolean;
  isFocused: boolean;
  onStartEdit?: () => void;
  onCommit: (v: string | null) => void;
  onCancel: () => void;
  onMoveNext: () => void;
  onView?: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseEnter: (e: React.MouseEvent) => void;
  onContextMenu: () => void;
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
        "group/cell relative flex h-full w-full cursor-default items-center overflow-hidden px-2 py-1",
        kind === "null" && !isEdited && "italic text-muted-foreground/50",
        kind === "empty" && !isEdited && "text-muted-foreground/40",
        isEdited && "bg-amber-500/15",
        isDeleted && "line-through opacity-40",
        isSelected && !isEdited && "bg-primary/15",
        !isSelected && !isEdited && !isDeleted && "hover:bg-primary/10",
        isFocused && "ring-1 ring-primary ring-inset",
      )}
      title={
        kind === "null"
          ? "NULL"
          : kind === "empty"
            ? "(empty string)"
            : text.slice(0, 512)
      }
      data-selected={isSelected || undefined}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onContextMenu={onContextMenu}
      onDoubleClick={!isDeleted ? (onStartEdit ?? onView) : undefined}
    >
      {isEdited && (
        <span className="mr-1 size-1.5 shrink-0 rounded-full bg-amber-500" />
      )}
      {kind === "null" ? (
        <span className="truncate">NULL</span>
      ) : kind === "empty" ? (
        <span className="truncate font-mono text-[10px]">(empty)</span>
      ) : (
        <span className="truncate">
          {text.length > 512 ? text.slice(0, 512) + "…" : text}
        </span>
      )}
      {!isDeleted && (onStartEdit || onView) && (
        // Overlaid, so hidden buttons don't take width from the text.
        <span className="absolute inset-y-0 right-0 flex items-center bg-background/90 pl-0.5 pr-1 opacity-0 group-hover/cell:opacity-100">
          {onStartEdit && (
            <button
              title="编辑单元格"
              className="p-0.5"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onStartEdit();
              }}
            >
              <Pencil className="size-3" />
            </button>
          )}
          {onView && (
            <button
              title="查看单元格"
              className="p-0.5"
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onView();
              }}
            >
              <Eye className="size-3" />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

// ─── New row cell ─────────────────────────────────────────────────

function NewRowCell({
  column,
  value,
  onChange,
}: {
  column: string;
  value: string | null | undefined;
  onChange: (v: string | null | undefined) => void;
}) {
  return (
    <div className="flex h-full w-full items-center bg-emerald-500/5">
      <input
        className="h-full min-w-0 flex-1 bg-transparent px-2 outline-none"
        aria-label={column}
        value={value ?? ""}
        placeholder={
          value === undefined ? "DEFAULT" : value === null ? "NULL" : "(empty)"
        }
        onChange={(e) => onChange(e.target.value)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="shrink-0 px-1 text-muted-foreground hover:text-foreground"
            aria-label={`${column} 的取值方式`}
            title="使用默认值、设为 NULL 或空字符串"
          >
            <ChevronDown className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-xs">
          <DropdownMenuItem onClick={() => onChange(undefined)}>
            使用默认值（DEFAULT）
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(null)}>
            设为 NULL
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange("")}>
            设为空字符串
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Constants ────────────────────────────────────────────────────

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;
const FILTER_ROW_HEIGHT = 28;

// ─── Selection ────────────────────────────────────────────────────

/** A cell by row index and *visual* column index (after reordering). */
interface CellPos {
  row: number;
  col: number;
}

interface GridSelection {
  anchor: CellPos;
  focus: CellPos;
}

interface SelectionRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function selectionRect(sel: GridSelection): SelectionRect {
  return {
    top: Math.min(sel.anchor.row, sel.focus.row),
    bottom: Math.max(sel.anchor.row, sel.focus.row),
    left: Math.min(sel.anchor.col, sel.focus.col),
    right: Math.max(sel.anchor.col, sel.focus.col),
  };
}

function inRect(rect: SelectionRect | null, row: number, col: number) {
  return (
    !!rect &&
    row >= rect.top &&
    row <= rect.bottom &&
    col >= rect.left &&
    col <= rect.right
  );
}

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
  onNewRowChange?: (
    newRowIndex: number,
    col: string,
    value: string | null | undefined,
  ) => void;
  onCellView?: (target: CellViewTarget) => void;
}

const EMPTY_FILTERS: Record<string, ColumnFilter> = {};
const EMPTY_EDITS: Record<string, PendingEdit> = {};
const EMPTY_SET = new Set<number>();
const EMPTY_NEW_ROWS: NewRow[] = [];

export function DataGrid({
  columns: columnsProp,
  rows,
  sort,
  onSort,
  filters = EMPTY_FILTERS,
  onFilterChange,
  showFilterRow = false,
  pendingEdits = EMPTY_EDITS,
  onEditCommit,
  pendingDeletes = EMPTY_SET,
  onDeleteToggle,
  newRows = EMPTY_NEW_ROWS,
  onNewRowChange,
  onCellView,
  selectedRows = EMPTY_SET,
  onRowSelectToggle,
  onSelectAll,
}: DataGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const fontSize = usePreferencesStore((s) => s.prefs.gridFontSize);
  const [activeEdit, setActiveEdit] = useState<{
    rowIndex: number;
    colIndex: number;
  } | null>(null);
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const draggingSelection = useRef(false);
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([]);
  const [draggingColId, setDraggingColId] = useState<string | null>(null);
  const [dragOverColId, setDragOverColId] = useState<string | null>(null);

  // Each page arrives as a new array with the same names; keep one identity
  // per column set so widths and order survive paging.
  const columnsKey = JSON.stringify(columnsProp);
  const columns = useMemo(
    () => JSON.parse(columnsKey) as string[],
    [columnsKey],
  );
  // Duplicate names (a.id, b.id) get distinct ids.
  const colIds = useMemo(
    () =>
      columns.map((col, i) =>
        columns.indexOf(col) === i ? col || String(i) : `${col} (${i + 1})`,
      ),
    [columns],
  );

  // Widths fitted to the first rows a column set arrives with; resizing (or
  // double-clicking a resize handle) adjusts them afterwards.
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [sizedFor, setSizedFor] = useState<{
    colIds: string[];
    fontSize: number;
  } | null>(null);
  if (sizedFor?.colIds !== colIds || sizedFor.fontSize !== fontSize) {
    setSizedFor({ colIds, fontSize });
    setColumnSizing(
      Object.fromEntries(
        colIds.map((id, i) => [
          id,
          fitColumnWidth(
            columns[i] ?? "",
            rows.map((row) => row[i]),
            fontSize,
          ),
        ]),
      ),
    );
  }

  // Reset edit + selection when the rows change; order when the columns do.
  useEffect(() => {
    setActiveEdit(null);
    setSelection(null);
  }, [rows]);
  useEffect(() => {
    setColumnOrder([]);
  }, [columns]);
  useEffect(() => {
    const stop = () => {
      draggingSelection.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  const colDefs = useMemo<ColumnDef<GridRow>[]>(
    () =>
      colIds.map((id, colIdx) => ({
        id,
        accessorFn: (row: GridRow) => row[colIdx],
        header: columns[colIdx],
        size: 140,
        minSize: MIN_COLUMN_WIDTH,
        maxSize: 2000,
      })),
    [colIds, columns],
  );

  const sortingState: SortingState = sort
    ? [{ id: sort.column, desc: sort.dir === "DESC" }]
    : [];

  const table: Table<GridRow> = useReactTable({
    data: rows,
    columns: colDefs,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    state: { sorting: sortingState, columnOrder, columnSizing },
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    manualSorting: true,
    enableSortingRemoval: true,
  });

  const { rows: tableRows } = table.getRowModel();
  /** Leaf columns in display order. */
  const visibleColumns = table.getVisibleLeafColumns();
  const originalIndex = (colId: string) => colIds.indexOf(colId);

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom =
    totalHeight - (virtualItems[virtualItems.length - 1]?.end ?? 0);

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

  const handleDrop = useCallback(
    (toColId: string) => {
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
    },
    [draggingColId, columnOrder, table],
  );

  const handleDragEnd = useCallback(() => {
    setDraggingColId(null);
    setDragOverColId(null);
  }, []);

  const autoFitColumn = (colId: string) => {
    const i = originalIndex(colId);
    if (i < 0) return;
    setColumnSizing((prev) => ({
      ...prev,
      [colId]: fitColumnWidth(
        columns[i] ?? "",
        rows.map((row) => row[i]),
        fontSize,
      ),
    }));
  };

  const handleCommit = useCallback(
    (rowIndex: number, colIndex: number, newValue: string | null) => {
      const colName = columns[colIndex] ?? "";
      const originalValue = rows[rowIndex]?.[colIndex];
      // Detect no-change: null→null or string→same string
      const origIsNull = originalValue === null || originalValue === undefined;
      const newIsNull = newValue === null;
      const origStr = origIsNull ? null : cellDisplay(originalValue).text;
      if (
        !pendingEdits[editKey(rowIndex, colName)] &&
        newIsNull === origIsNull &&
        newValue === origStr
      ) {
        setActiveEdit(null);
        return;
      }
      onEditCommit?.({ rowIndex, column: colName, originalValue, newValue });
      setActiveEdit(null);
    },
    [columns, rows, onEditCommit, pendingEdits],
  );

  /** Tab / Enter in the editor: next column in display order, then next row. */
  const moveNext = (rowIndex: number, colIndex: number) => {
    const visual = visibleColumns.findIndex(
      (c) => originalIndex(c.id) === colIndex,
    );
    const next = visibleColumns[visual + 1];
    if (next) {
      setActiveEdit({ rowIndex, colIndex: originalIndex(next.id) });
      setSelection({
        anchor: { row: rowIndex, col: visual + 1 },
        focus: { row: rowIndex, col: visual + 1 },
      });
    } else if (rowIndex + 1 < rows.length && visibleColumns[0]) {
      setActiveEdit({
        rowIndex: rowIndex + 1,
        colIndex: originalIndex(visibleColumns[0].id),
      });
      setSelection({
        anchor: { row: rowIndex + 1, col: 0 },
        focus: { row: rowIndex + 1, col: 0 },
      });
      virtualizer.scrollToIndex(rowIndex + 1);
    } else {
      setActiveEdit(null);
      containerRef.current?.focus();
    }
  };

  // ── Selection helpers ─────────────────────────────────────────────

  const rect = selection ? selectionRect(selection) : null;
  /** Value shown in a cell: a staged edit wins over the loaded one. */
  const valueAt = (row: number, colId: string) => {
    const pending = pendingEdits[editKey(row, colId)];
    return pending !== undefined
      ? pending.newValue
      : rows[row]?.[originalIndex(colId)];
  };

  const scrollIntoView = (pos: CellPos) => {
    virtualizer.scrollToIndex(pos.row, { align: "auto" });
    const el = containerRef.current;
    if (!el) return;
    let left = (onRowSelectToggle ? 32 : 0) + 40;
    for (let c = 0; c < pos.col; c++) left += visibleColumns[c]?.getSize() ?? 0;
    const right = left + (visibleColumns[pos.col]?.getSize() ?? 0);
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth)
      el.scrollLeft = right - el.clientWidth;
  };

  const copySelection = (withHeaders = false) => {
    if (!rect) return;
    const cols = visibleColumns.slice(rect.left, rect.right + 1);
    const block: unknown[][] = [];
    if (withHeaders) block.push(cols.map((c) => columns[originalIndex(c.id)]));
    for (let r = rect.top; r <= rect.bottom; r++)
      block.push(cols.map((c) => valueAt(r, c.id)));
    void navigator.clipboard.writeText(toTsv(block));
  };

  const focusCell = selection?.focus;
  const focusColumn = focusCell ? visibleColumns[focusCell.col] : undefined;
  const canEditFocus =
    !!onEditCommit &&
    !!focusCell &&
    !!focusColumn &&
    !pendingDeletes.has(focusCell.row);

  const startEditAtFocus = () => {
    if (!focusCell || !focusColumn) return;
    if (canEditFocus)
      setActiveEdit({
        rowIndex: focusCell.row,
        colIndex: originalIndex(focusColumn.id),
      });
    else
      onCellView?.({
        columnName: focusColumn.id,
        value: valueAt(focusCell.row, focusColumn.id),
      });
  };

  const setSelectionNull = () => {
    if (!rect || !onEditCommit) return;
    for (let r = rect.top; r <= rect.bottom; r++) {
      if (pendingDeletes.has(r)) continue;
      for (let c = rect.left; c <= rect.right; c++) {
        const col = visibleColumns[c];
        if (col) handleCommit(r, originalIndex(col.id), null);
      }
    }
  };

  const toggleDeleteSelectedRows = () => {
    if (!rect || !onDeleteToggle) return;
    for (let r = rect.top; r <= rect.bottom; r++) onDeleteToggle(r);
  };

  const filterByFocus = (op: "=" | "!=") => {
    if (!focusCell || !focusColumn || !onFilterChange) return;
    const value = valueAt(focusCell.row, focusColumn.id);
    const isNull = value === null || value === undefined;
    onFilterChange(focusColumn.id, {
      column: focusColumn.id,
      op: isNull ? (op === "=" ? "IS NULL" : "IS NOT NULL") : op,
      value: isNull ? "" : cellDisplay(value).text,
    });
  };

  const handleGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Keys typed into the cell editor or a new-row input stay there.
    if (e.target !== e.currentTarget) return;
    const mod = e.metaKey || e.ctrlKey;
    const lastRow = rows.length - 1;
    const lastCol = visibleColumns.length - 1;
    if (lastRow < 0 || lastCol < 0) return;

    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelection({
        anchor: { row: 0, col: 0 },
        focus: { row: lastRow, col: lastCol },
      });
      return;
    }
    if (mod && e.key.toLowerCase() === "c") {
      if (!selection) return;
      e.preventDefault();
      copySelection();
      return;
    }
    if (e.key === "Escape") {
      setSelection(null);
      return;
    }
    if (!selection) {
      if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        setSelection({
          anchor: { row: 0, col: 0 },
          focus: { row: 0, col: 0 },
        });
      }
      return;
    }
    if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEditAtFocus();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && onEditCommit) {
      e.preventDefault();
      setSelectionNull();
      return;
    }

    const page = Math.max(
      1,
      Math.floor((containerRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1,
    );
    const { row, col } = selection.focus;
    const moves: Record<string, CellPos> = {
      ArrowUp: { row: mod ? 0 : row - 1, col },
      ArrowDown: { row: mod ? lastRow : row + 1, col },
      ArrowLeft: { row, col: mod ? 0 : col - 1 },
      ArrowRight: { row, col: mod ? lastCol : col + 1 },
      Home: { row: mod ? 0 : row, col: 0 },
      End: { row: mod ? lastRow : row, col: lastCol },
      PageUp: { row: row - page, col },
      PageDown: { row: row + page, col },
      Tab: e.shiftKey
        ? col > 0
          ? { row, col: col - 1 }
          : { row: row - 1, col: lastCol }
        : col < lastCol
          ? { row, col: col + 1 }
          : { row: row + 1, col: 0 },
    };
    const target = moves[e.key];
    if (!target) return;
    e.preventDefault();
    const next = {
      row: Math.min(lastRow, Math.max(0, target.row)),
      col: Math.min(lastCol, Math.max(0, target.col)),
    };
    const extend = e.shiftKey && e.key !== "Tab";
    setSelection({ anchor: extend ? selection.anchor : next, focus: next });
    scrollIntoView(next);
  };

  const headerHeight = showFilterRow
    ? HEADER_HEIGHT + FILTER_ROW_HEIGHT
    : HEADER_HEIGHT;

  const multiCell =
    !!rect && (rect.top !== rect.bottom || rect.left !== rect.right);
  const rowCount = rect ? rect.bottom - rect.top + 1 : 0;

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ fontSize }}>
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
                  if (el)
                    el.indeterminate =
                      selectedRows.size > 0 && selectedRows.size < rows.length;
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
            const isDragOver =
              dragOverColId === colId && draggingColId !== colId;

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
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext(),
                  )}
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
                {/* Column resize handle — prevents drag from starting here;
                    double-click fits the column to its content. */}
                <div
                  className={cn(
                    "absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none opacity-0 hover:bg-primary hover:opacity-100",
                    header.column.getIsResizing() && "bg-primary opacity-100",
                  )}
                  title="拖动调整列宽，双击按内容适应"
                  draggable={false}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    autoFitColumn(colId);
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    header.getResizeHandler()(e);
                  }}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    header.getResizeHandler()(e);
                  }}
                />
              </div>
            );
          })}
        </div>

        {showFilterRow && (
          <div
            className="flex border-t border-border/50"
            style={{ height: FILTER_ROW_HEIGHT }}
          >
            {onRowSelectToggle && (
              <div className="w-8 shrink-0 border-r border-border/50" />
            )}
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
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            className="flex-1 overflow-auto outline-none"
            tabIndex={0}
            role="grid"
            aria-label="数据表格"
            aria-rowcount={rows.length}
            onKeyDown={handleGridKeyDown}
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
                      isDeleted
                        ? "bg-destructive/10"
                        : isEven
                          ? "bg-background"
                          : "bg-muted/20",
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
                      className={cn(
                        "relative flex w-10 shrink-0 items-center justify-center border-r border-border/50 text-[10px] text-muted-foreground/50 select-none",
                        onDeleteToggle && "cursor-pointer",
                      )}
                      onClick={() => onDeleteToggle?.(rowIdx)}
                      title={
                        onDeleteToggle
                          ? isDeleted
                            ? "取消删除"
                            : "标记删除"
                          : undefined
                      }
                    >
                      <span
                        className={cn(onDeleteToggle && "group-hover:hidden")}
                      >
                        {rowIdx + 1}
                      </span>
                      {onDeleteToggle && (
                        <Trash2
                          className={cn(
                            "hidden size-3 group-hover:block",
                            isDeleted
                              ? "text-destructive"
                              : "text-muted-foreground/60",
                          )}
                        />
                      )}
                    </div>

                    {row.getVisibleCells().map((cell, visualCol) => {
                      const colName = cell.column.id;
                      const originalColIdx = originalIndex(colName);
                      const key = editKey(rowIdx, colName);
                      const isEditing =
                        activeEdit?.rowIndex === rowIdx &&
                        activeEdit?.colIndex === originalColIdx;
                      const pending = pendingEdits[key];
                      const displayValue =
                        pending !== undefined
                          ? pending.newValue
                          : cell.getValue();
                      const pos = { row: rowIdx, col: visualCol };

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
                            isSelected={inRect(rect, rowIdx, visualCol)}
                            isFocused={
                              focusCell?.row === rowIdx &&
                              focusCell?.col === visualCol
                            }
                            onStartEdit={
                              onEditCommit
                                ? () => {
                                    setSelection({ anchor: pos, focus: pos });
                                    setActiveEdit({
                                      rowIndex: rowIdx,
                                      colIndex: originalColIdx,
                                    });
                                  }
                                : undefined
                            }
                            onCommit={(v) =>
                              handleCommit(rowIdx, originalColIdx, v)
                            }
                            onCancel={() => {
                              setActiveEdit(null);
                              containerRef.current?.focus();
                            }}
                            onMoveNext={() => moveNext(rowIdx, originalColIdx)}
                            onView={
                              onCellView
                                ? () =>
                                    onCellView({
                                      columnName: colName,
                                      value: displayValue,
                                    })
                                : undefined
                            }
                            onMouseDown={(e) => {
                              if (e.button !== 0) return;
                              draggingSelection.current = true;
                              setSelection((prev) =>
                                e.shiftKey && prev
                                  ? { anchor: prev.anchor, focus: pos }
                                  : { anchor: pos, focus: pos },
                              );
                              // Keep keyboard focus on the grid, not lost to
                              // the body, so arrows and Cmd+C work next.
                              e.preventDefault();
                              containerRef.current?.focus();
                            }}
                            onMouseEnter={(e) => {
                              if (draggingSelection.current && e.buttons === 1)
                                setSelection((prev) =>
                                  prev
                                    ? { anchor: prev.anchor, focus: pos }
                                    : prev,
                                );
                            }}
                            onContextMenu={() => {
                              // Right-click inside the selection keeps it;
                              // elsewhere it selects that cell.
                              if (!inRect(rect, rowIdx, visualCol))
                                setSelection({ anchor: pos, focus: pos });
                              containerRef.current?.focus();
                            }}
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
                {onRowSelectToggle && (
                  <div className="w-8 shrink-0 border-r border-emerald-500/20" />
                )}
                <div className="flex w-10 shrink-0 items-center justify-center border-r border-emerald-500/20 text-[10px] text-emerald-600 select-none dark:text-emerald-400">
                  +{newRowIdx + 1}
                </div>
                {headerGroups[0]?.headers.map((header) => {
                  const col = header.column.id;
                  const width = header.getSize();
                  return (
                    <div
                      key={col}
                      className="shrink-0 border-r border-emerald-500/20"
                      style={{ width }}
                    >
                      <NewRowCell
                        column={col}
                        value={newRow[col]}
                        onChange={(v) => onNewRowChange?.(newRowIdx, col, v)}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={!rect} onSelect={() => copySelection()}>
            <Copy />
            复制
            <ContextMenuShortcut>⌘C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!rect}
            onSelect={() => copySelection(true)}
          >
            <Copy />
            复制（含列名）
          </ContextMenuItem>
          {focusColumn && (
            <ContextMenuItem
              onSelect={() =>
                void navigator.clipboard.writeText(
                  columns[originalIndex(focusColumn.id)] ?? "",
                )
              }
            >
              <Columns3 />
              复制列名
            </ContextMenuItem>
          )}
          {(onCellView || onEditCommit) && focusColumn && (
            <ContextMenuSeparator />
          )}
          {onCellView && focusCell && focusColumn && (
            <ContextMenuItem
              onSelect={() =>
                onCellView({
                  columnName: focusColumn.id,
                  value: valueAt(focusCell.row, focusColumn.id),
                })
              }
            >
              <Eye />
              查看值
            </ContextMenuItem>
          )}
          {onEditCommit && focusColumn && (
            <>
              <ContextMenuItem
                disabled={!canEditFocus || multiCell}
                onSelect={startEditAtFocus}
              >
                <Pencil />
                编辑
                <ContextMenuShortcut>↵</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onSelect={setSelectionNull}>
                <CircleSlash />
                设为 NULL
                <ContextMenuShortcut>⌫</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          )}
          {onFilterChange && focusColumn && !multiCell && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => filterByFocus("=")}>
                <Filter />
                按此值筛选
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => filterByFocus("!=")}>
                <FilterX />
                排除此值
              </ContextMenuItem>
            </>
          )}
          {onDeleteToggle && rect && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onSelect={toggleDeleteSelectedRows}
              >
                <Trash2 />
                {rowCount > 1
                  ? `标记删除 / 取消删除 ${rowCount} 行`
                  : pendingDeletes.has(rect.top)
                    ? "取消删除此行"
                    : "删除此行"}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

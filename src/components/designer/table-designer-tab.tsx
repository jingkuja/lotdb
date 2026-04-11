import { useState, useCallback, useId } from "react";
import { Plus, Trash2, GripVertical, ArrowUp, ArrowDown, Code2, GitCompare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  emptyColumn,
  emptyState,
  type DesignerColumn,
  type DesignerIndex,
  type DesignerForeignKey,
  type DesignerState,
} from "@/types/designer";
import { IndexEditor } from "./index-editor";
import { ForeignKeyEditor } from "./foreign-key-editor";
import { DdlPreviewDialog } from "./ddl-preview-dialog";
import { DdlDiffDialog } from "./ddl-diff-dialog";
import {
  getTypeGroups,
  supportsLength,
  supportsAutoIncrement,
  supportsUnsigned,
} from "@/lib/column-types";
import type { DatabaseType } from "@/types/database";

// ─── Type selector ────────────────────────────────────────────────

function TypeSelect({
  value,
  dbType,
  onChange,
}: {
  value: string;
  dbType: DatabaseType;
  onChange: (v: string) => void;
}) {
  const groups = getTypeGroups(dbType);
  return (
    <select
      className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.types.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

// ─── Checkbox cell ────────────────────────────────────────────────

function CheckCell({
  checked,
  disabled,
  onChange,
  title,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <div className="flex items-center justify-center" title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
      />
    </div>
  );
}

// ─── Column row ───────────────────────────────────────────────────

interface ColRowProps {
  col: DesignerColumn;
  index: number;
  total: number;
  dbType: DatabaseType;
  onChange: (col: DesignerColumn) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  dragHandleProps: {
    draggable: boolean;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: () => void;
    onDragEnd: () => void;
    isDragOver: boolean;
  };
}

function ColRow({ col, index, total, dbType, onChange, onDelete, onMove, dragHandleProps }: ColRowProps) {
  const set = <K extends keyof DesignerColumn>(key: K, val: DesignerColumn[K]) =>
    onChange({ ...col, [key]: val });

  const hasLength = supportsLength(col.type);
  const hasAI = supportsAutoIncrement(col.type, dbType);
  const hasUnsigned = supportsUnsigned(col.type, dbType);

  return (
    <div
      className={cn(
        "group flex items-center gap-0 border-b border-border/60 hover:bg-muted/30",
        dragHandleProps.isDragOver && "border-t-2 border-t-primary",
        col.isPrimaryKey && "bg-primary/5",
      )}
      onDragOver={dragHandleProps.onDragOver}
      onDrop={dragHandleProps.onDrop}
    >
      {/* Drag handle */}
      <div
        draggable={dragHandleProps.draggable}
        onDragStart={dragHandleProps.onDragStart}
        onDragEnd={dragHandleProps.onDragEnd}
        className="flex w-7 shrink-0 cursor-grab items-center justify-center text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-3.5" />
      </div>

      {/* Row index */}
      <div className="flex w-7 shrink-0 items-center justify-center text-[10px] text-muted-foreground/50">
        {index + 1}
      </div>

      {/* Name */}
      <div className="w-36 shrink-0 px-1">
        <Input
          className="h-7 border-0 bg-transparent px-1 text-xs focus-visible:ring-1"
          placeholder="列名"
          value={col.name}
          onChange={(e) => set("name", e.target.value)}
        />
      </div>

      {/* Type */}
      <div className="w-36 shrink-0 px-1">
        <TypeSelect value={col.type} dbType={dbType} onChange={(v) => set("type", v)} />
      </div>

      {/* Length */}
      <div className="w-20 shrink-0 px-1">
        <Input
          className="h-7 border-0 bg-transparent px-1 font-mono text-xs focus-visible:ring-1"
          placeholder={hasLength ? "长度" : "—"}
          disabled={!hasLength}
          value={hasLength ? col.length : ""}
          onChange={(e) => set("length", e.target.value)}
        />
      </div>

      {/* Nullable */}
      <div className="w-12 shrink-0">
        <CheckCell
          checked={col.nullable}
          onChange={(v) => set("nullable", v)}
          title="允许 NULL"
        />
      </div>

      {/* Default value */}
      <div className="w-28 shrink-0 px-1">
        <Input
          className="h-7 border-0 bg-transparent px-1 font-mono text-xs focus-visible:ring-1"
          placeholder="默认值"
          value={col.defaultValue}
          onChange={(e) => set("defaultValue", e.target.value)}
        />
      </div>

      {/* PK */}
      <div className="w-10 shrink-0">
        <CheckCell
          checked={col.isPrimaryKey}
          onChange={(v) => {
            onChange({
              ...col,
              isPrimaryKey: v,
              nullable: v ? false : col.nullable,
            });
          }}
          title="主键"
        />
      </div>

      {/* Auto Increment */}
      <div className="w-10 shrink-0">
        <CheckCell
          checked={col.isAutoIncrement}
          disabled={!hasAI}
          onChange={(v) => set("isAutoIncrement", v)}
          title="自增"
        />
      </div>

      {/* Unique */}
      <div className="w-10 shrink-0">
        <CheckCell
          checked={col.isUnique}
          disabled={col.isPrimaryKey}
          onChange={(v) => set("isUnique", v)}
          title="唯一"
        />
      </div>

      {/* Unsigned (MySQL only) */}
      {dbType === "mysql" && (
        <div className="w-10 shrink-0">
          <CheckCell
            checked={col.unsigned}
            disabled={!hasUnsigned}
            onChange={(v) => set("unsigned", v)}
            title="无符号"
          />
        </div>
      )}

      {/* Comment */}
      <div className="min-w-0 flex-1 px-1">
        <Input
          className="h-7 border-0 bg-transparent px-1 text-xs focus-visible:ring-1"
          placeholder="注释"
          value={col.comment}
          onChange={(e) => set("comment", e.target.value)}
        />
      </div>

      {/* Actions */}
      <div className="flex w-16 shrink-0 items-center justify-end gap-0.5 pr-1 opacity-0 group-hover:opacity-100">
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          title="上移"
        >
          <ArrowUp className="size-3" />
        </button>
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          title="下移"
        >
          <ArrowDown className="size-3" />
        </button>
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
          onClick={onDelete}
          title="删除列"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </div>
  );
}

// ─── Header row ───────────────────────────────────────────────────

function HeaderRow({ dbType }: { dbType: DatabaseType }) {
  const th = (label: string, w: string, extra?: string) => (
    <div className={cn("shrink-0 px-1 text-[10px] font-medium text-muted-foreground", w, extra)}>
      {label}
    </div>
  );
  return (
    <div className="flex items-center border-b border-border bg-muted/60 py-1.5">
      <div className="w-7 shrink-0" /> {/* drag handle */}
      <div className="w-7 shrink-0" /> {/* index */}
      {th("列名", "w-36")}
      {th("类型", "w-36")}
      {th("长度", "w-20")}
      {th("NULL", "w-12", "text-center")}
      {th("默认值", "w-28")}
      {th("PK", "w-10", "text-center")}
      {th("AI", "w-10", "text-center")}
      {th("唯一", "w-10", "text-center")}
      {dbType === "mysql" && th("无符号", "w-10", "text-center")}
      {th("注释", "flex-1")}
      <div className="w-16 shrink-0" />
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────

interface TableDesignerTabProps {
  connectionId: string;
  dbType: DatabaseType;
  /** If editing an existing table, pre-fill with its columns */
  initialState?: DesignerState;
}

type PanelTab = "columns" | "indexes" | "foreign-keys";

export function TableDesignerTab({ dbType, initialState }: TableDesignerTabProps) {
  const uid = useId();
  // Freeze original state at mount for ALTER TABLE diff
  const [originalState] = useState<DesignerState | undefined>(initialState);
  const [state, setState] = useState<DesignerState>(initialState ?? emptyState());
  const [activePanel, setActivePanel] = useState<PanelTab>("columns");
  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [ddlOpen, setDdlOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  const nextId = () => `${uid}-${Date.now()}-${Math.random()}`;

  const addColumn = useCallback(() => {
    setState((prev) => ({
      ...prev,
      columns: [...prev.columns, emptyColumn(nextId())],
    }));
  }, []);

  const updateColumn = useCallback((index: number, col: DesignerColumn) => {
    setState((prev) => {
      const cols = [...prev.columns];
      cols[index] = col;
      return { ...prev, columns: cols };
    });
  }, []);

  const deleteColumn = useCallback((index: number) => {
    setState((prev) => ({
      ...prev,
      columns: prev.columns.filter((_, i) => i !== index),
    }));
  }, []);

  const updateIndexes = useCallback((indexes: DesignerIndex[]) => {
    setState((prev) => ({ ...prev, indexes }));
  }, []);

  const updateForeignKeys = useCallback((foreignKeys: DesignerForeignKey[]) => {
    setState((prev) => ({ ...prev, foreignKeys }));
  }, []);

  const moveColumn = useCallback((index: number, dir: -1 | 1) => {
    setState((prev) => {
      const cols = [...prev.columns];
      const target = index + dir;
      if (target < 0 || target >= cols.length) return prev;
      [cols[index], cols[target]] = [cols[target]!, cols[index]!];
      return { ...prev, columns: cols };
    });
  }, []);

  const handleDrop = useCallback((toIdx: number) => {
    if (dragFromIdx === null || dragFromIdx === toIdx) return;
    setState((prev) => {
      const cols = [...prev.columns];
      const [moved] = cols.splice(dragFromIdx, 1);
      cols.splice(toIdx, 0, moved!);
      return { ...prev, columns: cols };
    });
    setDragFromIdx(null);
    setDragOverIdx(null);
  }, [dragFromIdx]);

  const { columns, indexes, foreignKeys, tableName, tableComment } = state;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        {/* Panel tabs */}
        <div className="flex rounded-md border border-border text-xs">
          {(["columns", "indexes", "foreign-keys"] as PanelTab[]).map((tab) => (
            <button
              key={tab}
              className={cn(
                "px-3 py-1 transition-colors first:rounded-l-md last:rounded-r-md",
                activePanel === tab
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50",
                tab !== "columns" && "border-l border-border",
              )}
              onClick={() => setActivePanel(tab)}
            >
              {tab === "columns"
                ? `列 (${columns.length})`
                : tab === "indexes"
                  ? `索引 (${indexes.length})`
                  : `外键 (${foreignKeys.length})`}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-border" />

        {activePanel === "columns" && (
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={addColumn}>
            <Plus className="size-3" />添加列
          </Button>
        )}
        {activePanel === "indexes" && (
          <Button
            size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs"
            onClick={() => updateIndexes([...indexes, { id: `idx-${Date.now()}`, name: "", type: "INDEX", columns: [], method: "BTREE", comment: "" }])}
          >
            <Plus className="size-3" />添加索引
          </Button>
        )}
        {activePanel === "foreign-keys" && (
          <Button
            size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs"
            onClick={() => updateForeignKeys([...foreignKeys, { id: `fk-${Date.now()}`, name: "", columns: [], refTable: "", refColumns: [], onDelete: "NO ACTION", onUpdate: "NO ACTION" }])}
          >
            <Plus className="size-3" />添加外键
          </Button>
        )}

        <div className="flex-1" />

        {originalState && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => setDiffOpen(true)}
          >
            <GitCompare className="size-3" />
            DDL 对比
          </Button>
        )}

        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => setDdlOpen(true)}
        >
          <Code2 className="size-3" />
          预览 DDL
        </Button>
      </div>

      {/* Table meta */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">表名</label>
          <Input
            className="h-7 w-48 text-xs"
            placeholder="table_name"
            value={tableName}
            onChange={(e) => setState((s) => ({ ...s, tableName: e.target.value }))}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">注释</label>
          <Input
            className="h-7 w-64 text-xs"
            placeholder="表注释（可选）"
            value={tableComment}
            onChange={(e) => setState((s) => ({ ...s, tableComment: e.target.value }))}
          />
        </div>
      </div>

      {/* Panel content */}
      {activePanel === "indexes" && (
        <div className="flex-1 overflow-auto">
          <IndexEditor
            indexes={indexes}
            columns={columns}
            dbType={dbType}
            onChange={updateIndexes}
          />
        </div>
      )}

      {activePanel === "foreign-keys" && (
        <div className="flex-1 overflow-auto">
          <ForeignKeyEditor
            foreignKeys={foreignKeys}
            columns={columns}
            onChange={updateForeignKeys}
          />
        </div>
      )}

      {/* Column editor */}
      {activePanel === "columns" && <div className="flex-1 overflow-auto">
        <div className="min-w-max">
          <HeaderRow dbType={dbType} />

          {columns.length === 0 ? (
            <div
              className="flex cursor-pointer flex-col items-center gap-2 py-16 text-muted-foreground hover:text-foreground"
              onClick={addColumn}
            >
              <Plus className="size-8 opacity-30" />
              <p className="text-sm">点击添加第一列</p>
            </div>
          ) : (
            columns.map((col, idx) => (
              <ColRow
                key={col.id}
                col={col}
                index={idx}
                total={columns.length}
                dbType={dbType}
                onChange={(c) => updateColumn(idx, c)}
                onDelete={() => deleteColumn(idx)}
                onMove={(dir) => moveColumn(idx, dir)}
                dragHandleProps={{
                  draggable: true,
                  isDragOver: dragOverIdx === idx && dragFromIdx !== idx,
                  onDragStart: (e) => {
                    e.dataTransfer.effectAllowed = "move";
                    setDragFromIdx(idx);
                  },
                  onDragOver: (e) => { e.preventDefault(); setDragOverIdx(idx); },
                  onDrop: () => handleDrop(idx),
                  onDragEnd: () => { setDragFromIdx(null); setDragOverIdx(null); },
                }}
              />
            ))
          )}
        </div>
      </div>}

      <DdlPreviewDialog
        open={ddlOpen}
        onOpenChange={setDdlOpen}
        state={state}
        originalState={originalState}
        dbType={dbType}
      />

      {originalState && (
        <DdlDiffDialog
          open={diffOpen}
          onOpenChange={setDiffOpen}
          originalState={originalState}
          currentState={state}
          dbType={dbType}
        />
      )}
    </div>
  );
}

import { useState, useCallback } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  type DesignerIndex,
  type DesignerColumn,
  type IndexType,
  type IndexMethod,
  emptyIndex,
} from "@/types/designer";
import type { DatabaseType } from "@/types/database";

// ─── Available options per DB ─────────────────────────────────────

const MYSQL_TYPES: IndexType[] = ["INDEX", "UNIQUE", "FULLTEXT", "SPATIAL"];
const PG_TYPES: IndexType[] = ["INDEX", "UNIQUE"];

const PG_METHODS: IndexMethod[] = ["BTREE", "HASH", "GIN", "GIST", "BRIN", "SPGIST"];

function getTypes(dbType: DatabaseType): IndexType[] {
  return dbType === "postgres" ? PG_TYPES : MYSQL_TYPES;
}
function getMethods(dbType: DatabaseType, type: IndexType): IndexMethod[] {
  if (dbType === "postgres") return PG_METHODS;
  if (type === "FULLTEXT") return ["FULLTEXT"];
  if (type === "SPATIAL") return ["SPATIAL"];
  return ["BTREE", "HASH"];
}

// ─── Column picker (ordered multi-select) ────────────────────────

function ColumnPicker({
  selected,
  available,
  onChange,
}: {
  selected: string[];
  available: DesignerColumn[];
  onChange: (cols: string[]) => void;
}) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((c) => c !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  const handleDrop = (toIdx: number) => {
    if (dragFrom === null || dragFrom === toIdx) return;
    const next = [...selected];
    const [moved] = next.splice(dragFrom, 1);
    next.splice(toIdx, 0, moved!);
    onChange(next);
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <div className="flex gap-4">
      {/* Available columns */}
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[10px] text-muted-foreground">可选列</p>
        <div className="flex flex-wrap gap-1">
          {available.length === 0 && (
            <span className="text-[11px] text-muted-foreground/60">无列可选（先添加列）</span>
          )}
          {available.map((col) => {
            const isSelected = selected.includes(col.name);
            return (
              <button
                key={col.id}
                className={cn(
                  "rounded border px-2 py-0.5 text-[11px] transition-colors",
                  isSelected
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:border-primary/50 hover:bg-muted",
                  !col.name && "opacity-40",
                )}
                disabled={!col.name}
                onClick={() => col.name && toggle(col.name)}
                title={isSelected ? "取消选择" : "添加到索引"}
              >
                {col.name || "(未命名)"}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected order */}
      {selected.length > 0 && (
        <div className="w-36 shrink-0">
          <p className="mb-1 text-[10px] text-muted-foreground">索引列顺序</p>
          <div className="flex flex-col gap-0.5">
            {selected.map((colName, idx) => (
              <div
                key={colName}
                draggable
                className={cn(
                  "flex items-center gap-1 rounded border border-border bg-muted/30 px-1.5 py-0.5 text-[11px]",
                  dragOver === idx && dragFrom !== idx && "border-primary",
                )}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragFrom(idx); }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(idx); }}
                onDrop={() => handleDrop(idx)}
                onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
              >
                <GripVertical className="size-3 shrink-0 cursor-grab text-muted-foreground/40" />
                <span className="flex-1 truncate">{colName}</span>
                <span className="shrink-0 text-[9px] text-muted-foreground/50">{idx + 1}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Single index row (collapsible) ──────────────────────────────

function IndexRow({
  index,
  columns,
  dbType,
  onChange,
  onDelete,
}: {
  index: DesignerIndex;
  columns: DesignerColumn[];
  dbType: DatabaseType;
  onChange: (idx: DesignerIndex) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const set = <K extends keyof DesignerIndex>(key: K, val: DesignerIndex[K]) =>
    onChange({ ...index, [key]: val });

  const types = getTypes(dbType);
  const methods = getMethods(dbType, index.type);

  // Auto-generate name from columns if name is empty
  const namePlaceholder = index.columns.length > 0
    ? `idx_${index.columns.join("_")}`
    : "索引名称";

  return (
    <div className="rounded-md border border-border">
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? <ChevronDown className="size-3.5" />
            : <ChevronRight className="size-3.5" />}
        </button>

        {/* Name */}
        <Input
          className="h-7 w-44 text-xs"
          placeholder={namePlaceholder}
          value={index.name}
          onChange={(e) => set("name", e.target.value)}
        />

        {/* Type */}
        <select
          className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          value={index.type}
          onChange={(e) => {
            const newType = e.target.value as IndexType;
            const newMethods = getMethods(dbType, newType);
            onChange({
              ...index,
              type: newType,
              method: newMethods[0] ?? "BTREE",
            });
          }}
        >
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        {/* Method */}
        <select
          className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          value={index.method}
          onChange={(e) => set("method", e.target.value as IndexMethod)}
        >
          {methods.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        {/* Columns summary */}
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {index.columns.length === 0
            ? "（未选列）"
            : index.columns.join(", ")}
        </span>

        {/* Comment */}
        <Input
          className="h-7 w-36 text-xs"
          placeholder="注释"
          value={index.comment}
          onChange={(e) => set("comment", e.target.value)}
        />

        <button
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {/* Expanded column picker */}
      {expanded && (
        <div className="border-t border-border/50 bg-muted/20 px-4 py-3">
          <ColumnPicker
            selected={index.columns}
            available={columns}
            onChange={(cols) => set("columns", cols)}
          />
        </div>
      )}
    </div>
  );
}

// ─── Index editor panel ───────────────────────────────────────────

interface IndexEditorProps {
  indexes: DesignerIndex[];
  columns: DesignerColumn[];
  dbType: DatabaseType;
  onChange: (indexes: DesignerIndex[]) => void;
}

export function IndexEditor({ indexes, columns, dbType, onChange }: IndexEditorProps) {
  const addIndex = useCallback(() => {
    onChange([...indexes, emptyIndex(`idx-${Date.now()}`)]);
  }, [indexes, onChange]);

  const updateIndex = useCallback((i: number, idx: DesignerIndex) => {
    onChange(indexes.map((x, j) => (j === i ? idx : x)));
  }, [indexes, onChange]);

  const deleteIndex = useCallback((i: number) => {
    onChange(indexes.filter((_, j) => j !== i));
  }, [indexes, onChange]);

  return (
    <div className="flex flex-col gap-3 p-4">
      {indexes.length === 0 ? (
        <div
          className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-muted-foreground hover:border-primary/50 hover:text-foreground"
          onClick={addIndex}
        >
          <Plus className="size-6 opacity-40" />
          <p className="text-sm">点击添加索引</p>
        </div>
      ) : (
        indexes.map((idx, i) => (
          <IndexRow
            key={idx.id}
            index={idx}
            columns={columns}
            dbType={dbType}
            onChange={(updated) => updateIndex(i, updated)}
            onDelete={() => deleteIndex(i)}
          />
        ))
      )}

      {indexes.length > 0 && (
        <Button variant="ghost" size="sm" className="self-start gap-1 text-xs" onClick={addIndex}>
          <Plus className="size-3" />
          添加索引
        </Button>
      )}
    </div>
  );
}

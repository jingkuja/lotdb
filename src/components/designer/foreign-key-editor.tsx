import { useState, useCallback } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  type DesignerForeignKey,
  type DesignerColumn,
  type FKAction,
  emptyForeignKey,
} from "@/types/designer";

const FK_ACTIONS: FKAction[] = [
  "NO ACTION",
  "RESTRICT",
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
];

// ─── Single FK row (collapsible) ─────────────────────────────────

function FKRow({
  fk,
  columns,
  onChange,
  onDelete,
}: {
  fk: DesignerForeignKey;
  columns: DesignerColumn[];
  onChange: (fk: DesignerForeignKey) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const set = <K extends keyof DesignerForeignKey>(key: K, val: DesignerForeignKey[K]) =>
    onChange({ ...fk, [key]: val });

  const namePlaceholder =
    fk.columns.length > 0 && fk.refTable
      ? `fk_${fk.columns.join("_")}_${fk.refTable}`
      : "外键名称";

  const toggleLocalColumn = (colName: string) => {
    if (fk.columns.includes(colName)) {
      const idx = fk.columns.indexOf(colName);
      onChange({
        ...fk,
        columns: fk.columns.filter((_, i) => i !== idx),
        refColumns: fk.refColumns.filter((_, i) => i !== idx),
      });
    } else {
      onChange({
        ...fk,
        columns: [...fk.columns, colName],
        refColumns: [...fk.refColumns, ""],
      });
    }
  };

  const updateRefColumn = (localIdx: number, val: string) => {
    const next = [...fk.refColumns];
    next[localIdx] = val;
    set("refColumns", next);
  };

  const summary =
    fk.columns.length === 0
      ? "（未选本地列）"
      : fk.refTable
        ? `(${fk.columns.join(", ")}) → ${fk.refSchema ? `${fk.refSchema}.` : ""}${fk.refTable}(${fk.refColumns.join(", ")})`
        : `(${fk.columns.join(", ")}) → ?`;

  return (
    <div className="rounded-md border border-border">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? <ChevronDown className="size-3.5" />
            : <ChevronRight className="size-3.5" />}
        </button>

        <Input
          className="h-7 w-44 text-xs"
          placeholder={namePlaceholder}
          value={fk.name}
          onChange={(e) => set("name", e.target.value)}
        />

        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {summary}
        </span>

        <button
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
          onClick={onDelete}
          title="删除外键"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {/* Body */}
      {expanded && (
        <div className="space-y-4 border-t border-border/50 bg-muted/20 px-4 py-3">
          {/* Local column picker */}
          <div>
            <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">本地列</p>
            <div className="flex flex-wrap gap-1">
              {columns.length === 0 && (
                <span className="text-[11px] text-muted-foreground/60">
                  无列可选（先在"列"面板添加列）
                </span>
              )}
              {columns.map((col) => {
                const isSel = fk.columns.includes(col.name);
                return (
                  <button
                    key={col.id}
                    className={cn(
                      "rounded border px-2 py-0.5 text-[11px] transition-colors",
                      isSel
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:border-primary/50 hover:bg-muted",
                      !col.name && "opacity-40",
                    )}
                    disabled={!col.name}
                    onClick={() => col.name && toggleLocalColumn(col.name)}
                    title={isSel ? "取消选择" : "添加到外键"}
                  >
                    {col.name || "(未命名)"}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Referenced table */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                引用表
              </label>
              <Input
                className="h-7 text-xs"
                placeholder="referenced_table"
                value={fk.refTable}
                onChange={(e) => set("refTable", e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                引用 Schema（PG 可选）
              </label>
              <Input
                className="h-7 text-xs"
                placeholder="public"
                value={fk.refSchema ?? ""}
                onChange={(e) =>
                  set("refSchema", e.target.value || undefined)
                }
              />
            </div>
          </div>

          {/* Column mapping */}
          {fk.columns.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-medium text-muted-foreground">
                列映射（本地列 → 引用列）
              </p>
              <div className="space-y-1">
                {fk.columns.map((localCol, i) => (
                  <div key={localCol} className="flex items-center gap-2">
                    <span className="w-32 shrink-0 truncate rounded border border-border/50 bg-muted px-2 py-1 text-[11px]">
                      {localCol}
                    </span>
                    <span className="text-xs text-muted-foreground">→</span>
                    <Input
                      className="h-7 w-40 text-xs"
                      placeholder="ref_column"
                      value={fk.refColumns[i] ?? ""}
                      onChange={(e) => updateRefColumn(i, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ON DELETE / ON UPDATE */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                ON DELETE
              </label>
              <select
                className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                value={fk.onDelete}
                onChange={(e) => set("onDelete", e.target.value as FKAction)}
              >
                {FK_ACTIONS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium text-muted-foreground">
                ON UPDATE
              </label>
              <select
                className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                value={fk.onUpdate}
                onChange={(e) => set("onUpdate", e.target.value as FKAction)}
              >
                {FK_ACTIONS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Foreign key editor panel ─────────────────────────────────────

interface ForeignKeyEditorProps {
  foreignKeys: DesignerForeignKey[];
  columns: DesignerColumn[];
  onChange: (fks: DesignerForeignKey[]) => void;
}

export function ForeignKeyEditor({
  foreignKeys,
  columns,
  onChange,
}: ForeignKeyEditorProps) {
  const addFK = useCallback(() => {
    onChange([...foreignKeys, emptyForeignKey(`fk-${Date.now()}`)]);
  }, [foreignKeys, onChange]);

  const updateFK = useCallback(
    (i: number, fk: DesignerForeignKey) => {
      onChange(foreignKeys.map((x, j) => (j === i ? fk : x)));
    },
    [foreignKeys, onChange],
  );

  const deleteFK = useCallback(
    (i: number) => {
      onChange(foreignKeys.filter((_, j) => j !== i));
    },
    [foreignKeys, onChange],
  );

  return (
    <div className="flex flex-col gap-3 p-4">
      {foreignKeys.length === 0 ? (
        <div
          className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border py-12 text-muted-foreground hover:border-primary/50 hover:text-foreground"
          onClick={addFK}
        >
          <Plus className="size-6 opacity-40" />
          <p className="text-sm">点击添加外键</p>
        </div>
      ) : (
        foreignKeys.map((fk, i) => (
          <FKRow
            key={fk.id}
            fk={fk}
            columns={columns}
            onChange={(updated) => updateFK(i, updated)}
            onDelete={() => deleteFK(i)}
          />
        ))
      )}

      {foreignKeys.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start gap-1 text-xs"
          onClick={addFK}
        >
          <Plus className="size-3" />
          添加外键
        </Button>
      )}
    </div>
  );
}

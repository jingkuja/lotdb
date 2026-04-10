import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bookmark,
  Plus,
  Pencil,
  Trash2,
  ChevronLeft,
  Loader2,
  Search,
  Copy,
  CornerDownLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useSnippets,
  useCreateSnippet,
  useUpdateSnippet,
  useDeleteSnippet,
} from "@/hooks/use-snippets";
import type { SnippetEntry } from "@/services/tauri-commands";
import { useDebounce } from "@/hooks/use-debounce";

// ─── Types ────────────────────────────────────────────────────────

type Mode = "list" | "create" | "edit";

interface FormState {
  name: string;
  description: string;
  sql: string;
}

const EMPTY_FORM: FormState = { name: "", description: "", sql: "" };

// ─── Snippet Form (create / edit) ─────────────────────────────────

function SnippetForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: FormState;
  onSave: (form: FormState) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState(initial);

  useEffect(() => setForm(initial), [initial]);

  const set = (key: keyof FormState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="grid gap-1.5">
        <Label className="text-xs">名称 *</Label>
        <Input
          autoFocus
          value={form.name}
          onChange={set("name")}
          placeholder="片段名称"
          className="h-8 text-sm"
        />
      </div>

      <div className="grid gap-1.5">
        <Label className="text-xs">说明（可选）</Label>
        <Input
          value={form.description}
          onChange={set("description")}
          placeholder="简短描述"
          className="h-8 text-sm"
        />
      </div>

      <div className="grid gap-1.5">
        <Label className="text-xs">SQL *</Label>
        <textarea
          value={form.sql}
          onChange={set("sql")}
          placeholder="SELECT * FROM ..."
          rows={8}
          className={cn(
            "w-full resize-none rounded-md border border-input bg-transparent px-3 py-2",
            "font-mono text-xs outline-none focus:ring-1 focus:ring-ring",
          )}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button
          size="sm"
          onClick={() => onSave(form)}
          disabled={!form.name.trim() || !form.sql.trim() || saving}
        >
          {saving && <Loader2 className="mr-1.5 size-3 animate-spin" />}
          保存
        </Button>
      </div>
    </div>
  );
}

// ─── Snippet Row ──────────────────────────────────────────────────

function SnippetRow({
  entry,
  onInsert,
  onExecute,
  onEdit,
  onDelete,
}: {
  entry: SnippetEntry;
  onInsert: (sql: string) => void;
  onExecute: (sql: string) => void;
  onEdit: (entry: SnippetEntry) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="group flex items-start gap-2 border-b border-border/50 px-3 py-2.5 hover:bg-muted/40">
      <Bookmark className="mt-0.5 size-3.5 shrink-0 text-primary/60" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.name}</p>
        {entry.description && (
          <p className="truncate text-[11px] text-muted-foreground">
            {entry.description}
          </p>
        )}
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
          {entry.sql.replace(/\s+/g, " ").trim().slice(0, 100)}
          {entry.sql.length > 100 && "…"}
        </p>
      </div>

      <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
        <button
          className="rounded p-1 hover:bg-accent"
          title="插入到编辑器"
          onClick={() => onInsert(entry.sql)}
        >
          <Copy className="size-3" />
        </button>
        <button
          className="rounded p-1 hover:bg-accent"
          title="插入并执行"
          onClick={() => onExecute(entry.sql)}
        >
          <CornerDownLeft className="size-3" />
        </button>
        <button
          className="rounded p-1 hover:bg-accent"
          title="编辑"
          onClick={() => onEdit(entry)}
        >
          <Pencil className="size-3" />
        </button>
        <button
          className="rounded p-1 hover:bg-destructive/20 hover:text-destructive"
          title="删除"
          onClick={() => onDelete(entry.id)}
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </div>
  );
}

// ─── Main Dialog ──────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (sql: string) => void;
  onExecute: (sql: string) => void;
  /** Pre-fill SQL when opening in create mode */
  initialSql?: string;
  /** If true, open directly in create mode */
  createMode?: boolean;
}

export function SnippetsDialog({
  open,
  onOpenChange,
  onInsert,
  onExecute,
  initialSql = "",
  createMode = false,
}: Props) {
  const [mode, setMode] = useState<Mode>(createMode ? "create" : "list");
  const [editingEntry, setEditingEntry] = useState<SnippetEntry | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 200);

  const { data: snippets = [], isLoading } = useSnippets(
    debouncedSearch || undefined,
  );
  const createMutation = useCreateSnippet();
  const updateMutation = useUpdateSnippet();
  const deleteMutation = useDeleteSnippet();

  // Reset to list mode when dialog closes
  useEffect(() => {
    if (!open) {
      setMode("list");
      setEditingEntry(null);
      setSearchInput("");
    } else if (createMode) {
      setMode("create");
    }
  }, [open, createMode]);

  const handleSave = (form: FormState) => {
    if (mode === "create") {
      createMutation.mutate(
        {
          name: form.name,
          sql: form.sql,
          description: form.description || undefined,
        },
        { onSuccess: () => setMode("list") },
      );
    } else if (mode === "edit" && editingEntry) {
      updateMutation.mutate(
        {
          id: editingEntry.id,
          name: form.name,
          sql: form.sql,
          description: form.description || undefined,
        },
        { onSuccess: () => { setMode("list"); setEditingEntry(null); } },
      );
    }
  };

  const handleEdit = (entry: SnippetEntry) => {
    setEditingEntry(entry);
    setMode("edit");
  };

  const handleInsert = (sql: string) => {
    onInsert(sql);
    onOpenChange(false);
  };

  const handleExecute = (sql: string) => {
    onExecute(sql);
    onOpenChange(false);
  };

  const formInitial: FormState =
    mode === "edit" && editingEntry
      ? {
          name: editingEntry.name,
          sql: editingEntry.sql,
          description: editingEntry.description ?? "",
        }
      : { ...EMPTY_FORM, sql: initialSql };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[640px] flex-col gap-0 p-0 sm:max-w-[580px]">
        {/* Header */}
        <DialogHeader className="flex-row items-center border-b border-border px-4 py-3">
          {mode !== "list" && (
            <button
              className="mr-2 rounded p-0.5 hover:bg-muted"
              onClick={() => { setMode("list"); setEditingEntry(null); }}
            >
              <ChevronLeft className="size-4" />
            </button>
          )}
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Bookmark className="size-4" />
            {mode === "list"
              ? "代码片段"
              : mode === "create"
                ? "新建片段"
                : "编辑片段"}
          </DialogTitle>
          {mode === "list" && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 gap-1 text-xs"
              onClick={() => setMode("create")}
            >
              <Plus className="size-3" />
              新建
            </Button>
          )}
        </DialogHeader>

        {/* List mode */}
        {mode === "list" && (
          <>
            {/* Search bar */}
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="搜索片段..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="h-7 border-none bg-transparent px-0 shadow-none focus-visible:ring-0"
              />
            </div>

            <ScrollArea className="flex-1">
              {isLoading && (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                </div>
              )}
              {!isLoading && snippets.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                  <Bookmark className="size-8 opacity-30" />
                  <p className="text-sm">
                    {debouncedSearch ? "未找到匹配片段" : "暂无片段，点击「新建」添加"}
                  </p>
                </div>
              )}
              {snippets.map((entry) => (
                <SnippetRow
                  key={entry.id}
                  entry={entry}
                  onInsert={handleInsert}
                  onExecute={handleExecute}
                  onEdit={handleEdit}
                  onDelete={(id) => deleteMutation.mutate(id)}
                />
              ))}
            </ScrollArea>

            {snippets.length > 0 && (
              <div className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
                {snippets.length} 个片段 · 点击
                <Copy className="mx-1 inline size-3" />
                插入 ·
                <CornerDownLeft className="mx-1 inline size-3" />
                执行
              </div>
            )}
          </>
        )}

        {/* Create / Edit mode */}
        {(mode === "create" || mode === "edit") && (
          <ScrollArea className="flex-1">
            <SnippetForm
              initial={formInitial}
              onSave={handleSave}
              onCancel={() => { setMode("list"); setEditingEntry(null); }}
              saving={isSaving}
            />
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}

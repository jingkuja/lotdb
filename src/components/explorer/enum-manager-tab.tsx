import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Loader2,
  Plus,
  Shapes,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { addEnumValue, createEnumType, dropEnumType } from "@/services/tauri-commands";
import { useEnums } from "@/hooks/use-objects";

interface EnumManagerTabProps {
  connectionId: string;
  database: string;
  schema?: string;
}

export function EnumManagerTab({ connectionId, database, schema }: EnumManagerTabProps) {
  const { data: rows = [], isLoading, error } = useEnums(connectionId, database, schema, true);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createLabels, setCreateLabels] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["enums", connectionId, database] });

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleCreate = () => {
    const labels = createLabels
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!createName.trim() || labels.length === 0) return;
    void withBusy("create", async () => {
      await createEnumType(connectionId, database, schema, createName.trim(), labels);
      setCreateOpen(false);
      setCreateName("");
      setCreateLabels("");
    });
  };

  const handleAddValue = (name: string) => {
    const label = window.prompt(`向枚举 "${name}" 添加新值：`);
    if (!label?.trim()) return;
    void withBusy(`add:${name}`, async () => {
      await addEnumValue(connectionId, database, schema, name, label.trim());
    });
  };

  const handleDrop = (name: string) => {
    if (!confirm(`确定要删除枚举类型 "${name}" 吗？`)) return;
    void withBusy(`drop:${name}`, async () => {
      try {
        await dropEnumType(connectionId, database, schema, name, false);
      } catch (e) {
        const msg = String(e);
        if (
          msg.includes("dependent objects") &&
          confirm(
            `枚举 "${name}" 正被其他对象使用。\n强制级联删除（CASCADE）将同时删除依赖列，确定吗？`,
          )
        ) {
          await dropEnumType(connectionId, database, schema, name, true);
        } else {
          throw e;
        }
      }
    });
  };

  const qualifier = schema ? `${database} › ${schema}` : database;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Shapes className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{qualifier}</span>
        <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          枚举类型
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1.5 px-2.5 text-xs"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="size-3" />
          新建枚举
        </Button>
      </div>

      {actionError && (
        <div className="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5" />
          {actionError}
        </div>
      )}

      {/* Body */}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-sm">加载枚举类型中…</span>
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="size-5" />
          <p className="text-sm">{String(error)}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          无枚举类型，点击右上角"新建枚举"创建
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <div className="flex flex-col divide-y divide-border/50">
            {rows.map((e) => (
              <div
                key={e.name}
                className="group flex items-start gap-3 px-4 py-2 hover:bg-muted/30"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs font-medium">{e.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {e.labels.map((l, idx) => (
                      <span
                        key={l + idx}
                        className="rounded bg-violet-100 px-1.5 py-0.5 font-mono text-[10px] text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
                      >
                        {idx + 1}. {l}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
                  <button
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="添加枚举值"
                    disabled={busy !== null}
                    onClick={() => handleAddValue(e.name)}
                  >
                    {busy === `add:${e.name}` ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Plus className="size-3" />
                    )}
                  </button>
                  <button
                    className="rounded p-1 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                    title="删除枚举类型"
                    disabled={busy !== null}
                    onClick={() => handleDrop(e.name)}
                  >
                    {busy === `drop:${e.name}` ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Trash2 className="size-3" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>新建枚举类型</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-[90px_1fr] items-center gap-3">
              <Label>名称</Label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="color"
              />
            </div>
            <div className="grid grid-cols-[90px_1fr] items-start gap-3">
              <Label className="pt-2">枚举值</Label>
              <textarea
                value={createLabels}
                onChange={(e) => setCreateLabels(e.target.value)}
                placeholder={"每行一个值：\nred\ngreen\nblue"}
                rows={5}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!createName.trim() || !createLabels.trim() || busy === "create"}
            >
              {busy === "create" && <Loader2 className="size-3 animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  ListOrdered,
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
import {
  createSequence,
  dropSequence,
  restartSequence,
} from "@/services/tauri-commands";
import { useSequences } from "@/hooks/use-objects";

interface SequenceManagerTabProps {
  connectionId: string;
  database: string;
  schema?: string;
}

interface CreateForm {
  name: string;
  start: string;
  increment: string;
  min: string;
  max: string;
  cycle: boolean;
}

const EMPTY_FORM: CreateForm = {
  name: "",
  start: "",
  increment: "",
  min: "",
  max: "",
  cycle: false,
};

export function SequenceManagerTab({
  connectionId,
  database,
  schema,
}: SequenceManagerTabProps) {
  const { data: rows = [], isLoading, error } = useSequences(connectionId, database, schema, true);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ["sequences", connectionId, database],
    });

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
    if (!form.name.trim()) return;
    void withBusy("create", async () => {
      await createSequence(connectionId, database, schema, form.name.trim(), {
        start: form.start ? Number(form.start) : null,
        increment: form.increment ? Number(form.increment) : null,
        min: form.min ? Number(form.min) : null,
        max: form.max ? Number(form.max) : null,
        cycle: form.cycle,
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
    });
  };

  const handleRestart = (name: string) => {
    const input = window.prompt(
      `重置序列 "${name}" 到指定值（留空则回到 START 值）：`,
      "",
    );
    if (input === null) return;
    void withBusy(`restart:${name}`, async () => {
      const v = input.trim();
      await restartSequence(connectionId, database, schema, name, v ? Number(v) : null);
    });
  };

  const handleDrop = (name: string) => {
    if (!confirm(`确定要删除序列 "${name}" 吗？`)) return;
    void withBusy(`drop:${name}`, async () => {
      await dropSequence(connectionId, database, schema, name);
    });
  };

  const qualifier = schema ? `${database} › ${schema}` : database;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <ListOrdered className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{qualifier}</span>
        <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          序列
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1.5 px-2.5 text-xs"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="size-3" />
          新建序列
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
          <span className="text-sm">加载序列中…</span>
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="size-5" />
          <p className="text-sm">{String(error)}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          无序列，点击右上角"新建序列"创建
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/60">
                <th className="px-3 py-1.5 text-left font-medium">名称</th>
                <th className="px-3 py-1.5 text-left font-medium">类型</th>
                <th className="px-3 py-1.5 text-right font-medium">当前值</th>
                <th className="px-3 py-1.5 text-right font-medium">起始</th>
                <th className="px-3 py-1.5 text-right font-medium">增量</th>
                <th className="px-3 py-1.5 text-right font-medium">最小/最大</th>
                <th className="px-3 py-1.5 text-left font-medium">循环</th>
                <th className="px-3 py-1.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => (
                <tr
                  key={s.name}
                  className={
                    "border-b border-border/40 hover:bg-muted/30 " +
                    (i % 2 === 1 ? "bg-muted/10" : "")
                  }
                >
                  <td className="px-3 py-1.5 font-mono font-medium">{s.name}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{s.dataType}</td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {s.lastValue ?? <span className="italic opacity-50">未使用</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                    {s.startValue}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                    {s.incrementBy}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                    {s.minValue} / {s.maxValue}
                  </td>
                  <td className="px-3 py-1.5">
                    {s.cycle && (
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                        CYCLE
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <div className="flex justify-end gap-0.5">
                      <button
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="重置（RESTART）"
                        disabled={busy !== null}
                        onClick={() => handleRestart(s.name)}
                      >
                        {busy === `restart:${s.name}` ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <RotateCcw className="size-3" />
                        )}
                      </button>
                      <button
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                        title="删除"
                        disabled={busy !== null}
                        onClick={() => handleDrop(s.name)}
                      >
                        {busy === `drop:${s.name}` ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Trash2 className="size-3" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>新建序列</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-[90px_1fr] items-center gap-3">
            <Label>名称</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="my_sequence"
            />
            <Label>起始值</Label>
            <Input
              type="number"
              value={form.start}
              onChange={(e) => setForm({ ...form, start: e.target.value })}
              placeholder="默认 1"
            />
            <Label>增量</Label>
            <Input
              type="number"
              value={form.increment}
              onChange={(e) => setForm({ ...form, increment: e.target.value })}
              placeholder="默认 1"
            />
            <Label>最小值</Label>
            <Input
              type="number"
              value={form.min}
              onChange={(e) => setForm({ ...form, min: e.target.value })}
              placeholder="可选"
            />
            <Label>最大值</Label>
            <Input
              type="number"
              value={form.max}
              onChange={(e) => setForm({ ...form, max: e.target.value })}
              placeholder="可选"
            />
            <Label>循环</Label>
            <input
              type="checkbox"
              className="size-4"
              checked={form.cycle}
              onChange={(e) => setForm({ ...form, cycle: e.target.checked })}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreate} disabled={!form.name.trim() || busy === "create"}>
              {busy === "create" && <Loader2 className="size-3 animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

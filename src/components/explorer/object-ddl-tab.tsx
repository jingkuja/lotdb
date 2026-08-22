import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Copy,
  Check,
  Loader2,
  Trash2,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useObjectDdl, type DdlKind } from "@/hooks/use-objects";
import { dropTrigger } from "@/services/tauri-commands";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

interface ObjectDdlTabProps {
  connectionId: string;
  database: string;
  schema?: string;
  /** View / function name, or trigger name. */
  name: string;
  kind: DdlKind;
  /** Table the trigger is attached to (triggers only). */
  triggerTable?: string;
}

const KIND_LABEL: Record<DdlKind, string> = {
  view: "视图",
  function: "函数",
  trigger: "触发器",
};

export function ObjectDdlTab({
  connectionId,
  database,
  schema,
  name,
  kind,
  triggerTable,
}: ObjectDdlTabProps) {
  const { data, isLoading, error } = useObjectDdl({
    connectionId,
    database,
    schema,
    name,
    kind,
    table: triggerTable,
  });
  const [copied, setCopied] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [dropped, setDropped] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const setContent = useEditorStore((s) => s.setContent);
  const addTab = useWorkspaceStore((s) => s.addTab);
  const queryClient = useQueryClient();

  const handleCopy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.ddl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — no-op
    }
  };

  // "编辑执行" — open a query tab pre-filled with the DDL.
  const handleEditInQuery = () => {
    if (!data) return;
    const tabId = `query-${connectionId}-ddl-${name}-${Date.now()}`;
    setContent(tabId, data.ddl);
    addTab({
      id: tabId,
      title: `${name} (DDL)`,
      type: "query",
      connectionId,
    });
  };

  const handleDropTrigger = async () => {
    if (!confirm(`确定要删除触发器 "${name}" 吗？`)) return;
    setDropping(true);
    setDropError(null);
    try {
      await dropTrigger(connectionId, database, schema, triggerTable ?? "", name);
      setDropped(true);
      queryClient.invalidateQueries({
        queryKey: ["triggers", connectionId, database],
      });
    } catch (e) {
      setDropError(String(e));
    } finally {
      setDropping(false);
    }
  };

  const qualifier = schema ? `${database} › ${schema} › ${name}` : `${database}.${name}`;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-sm font-medium">{qualifier}</span>
        <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          {KIND_LABEL[kind]}源码（只读）
        </span>
        <div className="ml-auto flex items-center gap-1">
          {kind === "function" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={handleEditInQuery}
              disabled={!data}
              title="在查询标签页中打开 DDL，可编辑后执行"
            >
              <Terminal className="size-3" />
              编辑执行
            </Button>
          )}
          {kind === "trigger" && !dropped && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs text-destructive hover:text-destructive"
              onClick={handleDropTrigger}
              disabled={dropping}
            >
              {dropping ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Trash2 className="size-3" />
              )}
              删除
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            onClick={handleCopy}
            disabled={!data}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            {copied ? "已复制" : "复制"}
          </Button>
        </div>
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-sm">加载 DDL 中…</span>
        </div>
      ) : error || !data ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="size-5" />
          <p className="text-sm">{String(error ?? "未找到对象")}</p>
        </div>
      ) : dropped ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Check className="size-4 text-green-500" />
          <span className="text-sm">触发器已删除</span>
        </div>
      ) : (
        <ScrollArea className="flex-1">
          <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-5">
            {data.ddl}
          </pre>
        </ScrollArea>
      )}

      {dropError && (
        <div className="border-t border-border px-4 py-2 text-xs text-destructive">
          {dropError}
        </div>
      )}
    </div>
  );
}

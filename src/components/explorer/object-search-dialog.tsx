import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table2,
  Eye,
  FunctionSquare,
  Loader2,
  SearchX,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { searchObjects, type SearchResult } from "@/services/tauri-commands";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDebounce } from "@/hooks/use-debounce";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active connection id to search within. Null = no connection open. */
  connectionId: string | null;
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  table: <Table2 className="size-3.5 text-blue-500" />,
  view: <Eye className="size-3.5 text-purple-500" />,
  function: <FunctionSquare className="size-3.5 text-green-500" />,
  procedure: <FunctionSquare className="size-3.5 text-green-500" />,
};

const TYPE_LABEL: Record<string, string> = {
  table: "表",
  view: "视图",
  function: "函数",
  procedure: "存储过程",
};

const TYPE_COLOR: Record<string, string> = {
  table: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  view: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  function: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  procedure: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

export function ObjectSearchDialog({ open, onOpenChange, connectionId }: Props) {
  const [input, setInput] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debouncedQuery = useDebounce(input, 250);

  const addTab = useWorkspaceStore((s) => s.addTab);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);

  // Reset state whenever dialog opens
  useEffect(() => {
    if (open) {
      setInput("");
      setSelectedIndex(0);
    }
  }, [open]);

  const { data: results = [], isFetching } = useQuery({
    queryKey: ["search", connectionId, debouncedQuery],
    queryFn: () => searchObjects(connectionId!, debouncedQuery),
    enabled: !!connectionId && debouncedQuery.length >= 1,
    placeholderData: (prev) => prev,
  });

  // Reset selection when results change
  useEffect(() => setSelectedIndex(0), [results]);

  const openResult = useCallback(
    (result: SearchResult) => {
      const tabId = [
        connectionId,
        result.database,
        result.schema,
        result.objectType,
        result.name,
      ]
        .filter(Boolean)
        .join("/");

      const existing = tabs.find((t) => t.id === tabId);
      if (existing) {
        setActiveTab(tabId);
      } else {
        addTab({
          id: tabId,
          title: result.name,
          type: result.objectType === "table" ? "table-structure" : "query",
          connectionId: connectionId!,
          metadata: {
            database: result.database,
            schema: result.schema ?? undefined,
            objectName: result.name,
            objectType: result.objectType,
          },
        });
      }
      onOpenChange(false);
    },
    [connectionId, tabs, addTab, setActiveTab, onOpenChange],
  );

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      openResult(results[selectedIndex]);
    }
  };

  const pathLabel = (r: SearchResult) =>
    r.schema ? `${r.database} › ${r.schema}` : r.database;

  const showEmpty =
    debouncedQuery.length >= 1 && !isFetching && results.length === 0;
  const showHint = debouncedQuery.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[520px] flex-col gap-0 p-0 sm:max-w-[560px]">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="sr-only">搜索数据库对象</DialogTitle>
          <div className="flex items-center gap-2">
            {isFetching ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Search className="size-4 shrink-0 text-muted-foreground" />
            )}
            <Input
              autoFocus
              placeholder={
                connectionId
                  ? "搜索表、视图、函数..."
                  : "请先连接一个数据库"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!connectionId}
              className="border-none bg-transparent px-0 shadow-none focus-visible:ring-0"
            />
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1">
          {/* Hint */}
          {showHint && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              输入关键词搜索当前连接的所有数据库对象
            </div>
          )}

          {/* Empty */}
          {showEmpty && (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-muted-foreground">
              <SearchX className="size-8 opacity-40" />
              <p className="text-sm">
                未找到匹配 <span className="font-medium">"{debouncedQuery}"</span> 的对象
              </p>
            </div>
          )}

          {/* Results */}
          {results.length > 0 && (
            <div className="py-1">
              {results.map((r, i) => (
                <button
                  key={`${r.database}/${r.schema}/${r.objectType}/${r.name}`}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors",
                    i === selectedIndex
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "hover:bg-muted/50",
                  )}
                  onClick={() => openResult(r)}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  {/* Type icon */}
                  <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted">
                    {TYPE_ICON[r.objectType] ?? TYPE_ICON.table}
                  </span>

                  {/* Name + path */}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {r.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {pathLabel(r)}
                    </span>
                  </span>

                  {/* Type badge */}
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                      TYPE_COLOR[r.objectType] ?? TYPE_COLOR.table,
                    )}
                  >
                    {TYPE_LABEL[r.objectType] ?? r.objectType}
                  </span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        {results.length > 0 && (
          <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            <span>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">
                ↑↓
              </kbd>{" "}
              导航
            </span>
            <span>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">
                ↵
              </kbd>{" "}
              打开
            </span>
            <span>
              <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px]">
                Esc
              </kbd>{" "}
              关闭
            </span>
            <span className="ml-auto">{results.length} 个结果</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

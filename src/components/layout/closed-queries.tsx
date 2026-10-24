import { History, Terminal, Trash2 } from "lucide-react";
import { useConnections } from "@/hooks/use-connections";
import { useWorkspaceStore, type ClosedQuery } from "@/stores/workspace-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** First non-blank line of the draft, for a one-line preview. */
function preview(sql: string) {
  const line = sql.split("\n").find((l) => l.trim()) ?? "";
  return line.trim().slice(0, 80);
}

function useLabel() {
  const { data: connections = [] } = useConnections();
  return (q: ClosedQuery) => {
    const conn = connections.find((c) => c.id === q.tab.connectionId);
    return [conn?.name ?? "连接已删除", q.tab.metadata?.database]
      .filter(Boolean)
      .join(" / ");
  };
}

/** Tab-bar menu of recently closed query drafts. */
export function ClosedQueriesMenu() {
  const closed = useWorkspaceStore((s) => s.closedQueries);
  const reopen = useWorkspaceStore((s) => s.reopenClosedQuery);
  const clear = useWorkspaceStore((s) => s.clearClosedQueries);
  const label = useLabel();
  if (closed.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-8 shrink-0 items-center gap-1 px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="最近关闭的查询"
          title="最近关闭的查询（⌘⇧T 重新打开最近一个）"
        >
          <History className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 text-xs">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          最近关闭的查询
        </DropdownMenuLabel>
        {closed.slice(0, 10).map((q, i) => (
          <DropdownMenuItem
            key={q.closedAt}
            className="flex-col items-start gap-0"
            onSelect={() => reopen(q.closedAt)}
          >
            <span className="flex w-full items-center gap-1.5">
              <Terminal className="size-3" />
              <span className="truncate">{q.tab.title}</span>
              <span className="truncate text-[10px] text-muted-foreground">
                {label(q)}
              </span>
              {i === 0 && <DropdownMenuShortcut>⌘⇧T</DropdownMenuShortcut>}
            </span>
            <span className="w-full truncate pl-4.5 font-mono text-[10px] text-muted-foreground">
              {preview(q.sql)}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={clear}>
          <Trash2 className="size-3" />
          清空列表
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Home-page list of recently closed query drafts. */
export function ClosedQueriesList({ limit = 5 }: { limit?: number }) {
  const closed = useWorkspaceStore((s) => s.closedQueries);
  const reopen = useWorkspaceStore((s) => s.reopenClosedQuery);
  const label = useLabel();
  if (closed.length === 0) return null;
  return (
    <div className="pb-1">
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        最近关闭的查询
      </div>
      {closed.slice(0, limit).map((q) => (
        <button
          key={q.closedAt}
          type="button"
          className="flex w-full items-center gap-1.5 rounded py-[2px] pl-3 pr-1 text-left text-[11px] hover:bg-sidebar-accent/60"
          title={q.sql.slice(0, 500)}
          onClick={() => reopen(q.closedAt)}
        >
          <Terminal className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono">
            {preview(q.sql)}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {label(q)}
          </span>
        </button>
      ))}
    </div>
  );
}

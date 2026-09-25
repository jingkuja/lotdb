import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Terminal,
  Table2,
  Hash,
  PenSquare,
  X,
  Trash2,
  FileCode2,
  Boxes,
} from "lucide-react";
import { useRecentStore, type RecentItem } from "@/stores/recent-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useConnections } from "@/hooks/use-connections";
import { cn } from "@/lib/utils";
import type { Tab } from "@/stores/workspace-store";

const ICON_MAP: Record<Tab["type"], React.ElementType> = {
  query: Terminal,
  "table-data": Table2,
  "table-structure": Hash,
  designer: PenSquare,
  users: Terminal,
  "process-list": Terminal,
  "disk-usage": Terminal,
  "schema-diff": Terminal,
  "object-ddl": FileCode2,
  "object-manager": Boxes,
};

function RecentRow({ item }: { item: RecentItem }) {
  const { addTab, tabs, setActiveTab } = useWorkspaceStore();
  const { data: connections = [] } = useConnections();
  const removeRecent = useRecentStore((s) => s.removeRecent);

  const conn = connections.find((c) => c.id === item.connectionId);
  const Icon = ICON_MAP[item.type] ?? Terminal;

  const handleOpen = () => {
    // If tab already open, just switch to it
    const existing = tabs.find((t) => {
      const meta = t.metadata as Record<string, unknown> | undefined;
      const iMeta = item.metadata as Record<string, unknown> | undefined;
      return (
        t.type === item.type &&
        t.connectionId === item.connectionId &&
        meta?.database === iMeta?.database &&
        meta?.objectName === iMeta?.objectName
      );
    });
    if (existing) {
      setActiveTab(existing.id);
      return;
    }
    addTab({
      id: `recent-${item.key}-${Date.now()}`,
      type: item.type,
      title: item.title,
      connectionId: item.connectionId,
      metadata: item.metadata,
    });
  };

  return (
    <div className="group flex items-center gap-1 rounded py-[2px] pl-3 pr-1 text-xs hover:bg-sidebar-accent/60 cursor-pointer">
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="size-3" />
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[11px] text-sidebar-foreground"
        onClick={handleOpen}
      >
        {item.title}
      </span>
      {conn && (
        <span className="shrink-0 text-[10px] text-muted-foreground mr-1">
          {conn.name}
        </span>
      )}
      <button
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
        title="从最近移除"
        onClick={(e) => {
          e.stopPropagation();
          removeRecent(item.key);
        }}
      >
        <X className="size-2.5" />
      </button>
    </div>
  );
}

export function RecentPanel({ limit = 3 }: { limit?: number }) {
  const [expanded, setExpanded] = useState(true);
  const { items, clearRecent } = useRecentStore();

  if (items.length === 0) return null;

  return (
    <div className="border-b border-sidebar-border pb-1">
      {/* Header */}
      <div
        className="group flex items-center justify-between px-2 py-1 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-1">
          <span className="flex size-3.5 items-center justify-center text-muted-foreground">
            {expanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            最近
          </span>
        </div>
        <button
          className={cn(
            "rounded p-0.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100",
          )}
          title="清空最近记录"
          onClick={(e) => {
            e.stopPropagation();
            clearRecent();
          }}
        >
          <Trash2 className="size-3" />
        </button>
      </div>

      {/* Items */}
      {expanded && (
        <div>
          {items.slice(0, limit).map((item) => (
            <RecentRow key={item.key} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

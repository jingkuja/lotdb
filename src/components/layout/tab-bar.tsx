import { useConnections } from "@/hooks/use-connections";
import { Lock } from "lucide-react";
import { X, Terminal, Table2, Hash, PenSquare, Users, Activity, HardDrive, GitCompare, FileCode2, Boxes } from "lucide-react";
import { useWorkspaceStore, type Tab } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";

function TabItem({ tab }: { tab: Tab }) {
  const { activeTabId, setActiveTab, removeTab } = useWorkspaceStore();
  const dirty = useWorkspaceStore(s => !!s.dirtyIds[tab.id]);
  const {data: connections = []} = useConnections();
  const conn = connections.find(c => c.id === tab.connectionId);
  const context = [conn?.name, tab.metadata?.database, tab.metadata?.schema, tab.title].filter(Boolean).join(" / ");
  const isActive = activeTabId === tab.id;

  const iconMap = {
    query: Terminal,
    "table-data": Table2,
    "table-structure": Hash,
    designer: PenSquare,
    users: Users,
    "process-list": Activity,
    "disk-usage": HardDrive,
    "schema-diff": GitCompare,
    "object-ddl": FileCode2,
    "object-manager": Boxes,
  };
  const Icon = iconMap[tab.type] ?? Terminal;

  return (
    <div
      className={cn(
        "group flex h-8 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 text-xs",
        isActive
          ? "bg-background text-foreground"
          : "bg-muted/50 text-muted-foreground hover:bg-muted",
      )}
      role="tab" aria-selected={isActive} tabIndex={isActive ? 0 : -1} title={context}
      onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveTab(tab.id); } }}
      onClick={() => setActiveTab(tab.id)}
    >
      <span className="size-2 shrink-0 rounded-full" style={{backgroundColor: conn?.color || (conn?.dbType === "postgres" ? "#0284c7" : "#2563eb")}} />
      <Icon className="size-3.5 shrink-0" />
      <span className="max-w-40 truncate">{tab.title}</span>
      <span className="max-w-32 truncate text-[10px] text-muted-foreground">{conn?.name}{tab.metadata?.database ? ` / ${String(tab.metadata.database)}` : ""}</span>
      {conn?.readonly && <Lock className="size-3" aria-label="只读" />}
      {dirty && <span className="text-amber-500" aria-label="有未提交变更">●</span>}
      <button aria-label={`关闭 ${tab.title}`}
        className="ml-1 shrink-0 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100 focus-visible:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          removeTab(tab.id);
        }}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

export function TabBar() {
  const { tabs } = useWorkspaceStore();

  if (tabs.length === 0) return null;

  return (
    <div role="tablist" aria-label="工作区标签" className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-border bg-muted/30">
      {tabs.map((tab) => (
        <TabItem key={tab.id} tab={tab} />
      ))}
    </div>
  );
}

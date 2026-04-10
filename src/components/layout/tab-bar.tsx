import { X, Terminal, Table2, Hash, PenSquare } from "lucide-react";
import { useWorkspaceStore, type Tab } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";

function TabItem({ tab }: { tab: Tab }) {
  const { activeTabId, setActiveTab, removeTab } = useWorkspaceStore();
  const isActive = activeTabId === tab.id;

  const iconMap = {
    query: Terminal,
    "table-data": Table2,
    "table-structure": Hash,
    designer: PenSquare,
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
      onClick={() => setActiveTab(tab.id)}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="max-w-32 truncate">{tab.title}</span>
      <button
        className="ml-1 shrink-0 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
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
    <div className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-border bg-muted/30">
      {tabs.map((tab) => (
        <TabItem key={tab.id} tab={tab} />
      ))}
    </div>
  );
}

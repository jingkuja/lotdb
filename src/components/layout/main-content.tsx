import { useWorkspaceStore } from "@/stores/workspace-store";
import { TableStructurePanel } from "@/components/explorer/table-structure-panel";
import { QueryTab } from "@/components/editor/query-tab";
import { Database } from "lucide-react";

export function MainContent() {
  const { tabs, activeTabId } = useWorkspaceStore();

  if (!activeTabId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <Database className="size-12 opacity-30" />
        <p className="text-sm">选择连接或打开查询开始使用</p>
      </div>
    );
  }

  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (!activeTab) return null;

  const meta = activeTab.metadata as
    | {
        database?: string;
        schema?: string;
        objectName?: string;
        objectType?: string;
      }
    | undefined;

  if (
    activeTab.type === "table-structure" &&
    meta?.database &&
    meta?.objectName
  ) {
    return (
      <TableStructurePanel
        connectionId={activeTab.connectionId}
        database={meta.database}
        schema={meta.schema}
        table={meta.objectName}
      />
    );
  }

  if (activeTab.type === "query") {
    return (
      <QueryTab tabId={activeTab.id} connectionId={activeTab.connectionId} />
    );
  }

  // Placeholder for future tab types (table-data, designer)
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {activeTab.title}
    </div>
  );
}

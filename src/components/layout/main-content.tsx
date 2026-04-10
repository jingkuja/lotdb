import { useWorkspaceStore } from "@/stores/workspace-store";
import { TableStructurePanel } from "@/components/explorer/table-structure-panel";
import { QueryTab } from "@/components/editor/query-tab";
import { TableDataTab } from "@/components/grid/table-data-tab";
import { TableDesignerTab } from "@/components/designer/table-designer-tab";
import { useConnections } from "@/hooks/use-connections";
import { useQuery } from "@tanstack/react-query";
import { getTableDesignerState } from "@/lib/designer-loader";
import { Database, Loader2 } from "lucide-react";
import type { DatabaseType } from "@/types/database";
import type { DesignerState } from "@/types/designer";

// ─── Loader for existing-table designer ──────────────────────────

function DesignerLoader({
  connectionId,
  dbType,
  database,
  schema,
  tableName,
}: {
  connectionId: string;
  dbType: DatabaseType;
  database: string;
  schema: string | undefined;
  tableName: string;
}) {
  const { data, isLoading, error } = useQuery<DesignerState, string>({
    queryKey: ["designer-state", connectionId, database, schema, tableName],
    queryFn: () =>
      getTableDesignerState(connectionId, database, schema, tableName, dbType),
    staleTime: Infinity,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-6 animate-spin opacity-50" />
        <p className="text-sm">加载表结构中…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-destructive">
        <p className="text-sm">加载失败：{String(error)}</p>
      </div>
    );
  }

  return (
    <TableDesignerTab
      key={`${connectionId}/${database}/${schema}/${tableName}`}
      connectionId={connectionId}
      dbType={dbType}
      initialState={data}
    />
  );
}

export function MainContent() {
  const { tabs, activeTabId } = useWorkspaceStore();
  const { data: connections = [] } = useConnections();

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

  if (
    activeTab.type === "table-data" &&
    meta?.database &&
    meta?.objectName
  ) {
    return (
      <TableDataTab
        connectionId={activeTab.connectionId}
        database={meta.database as string}
        schema={meta.schema as string | undefined}
        table={meta.objectName as string}
      />
    );
  }

  if (activeTab.type === "designer") {
    const conn = connections.find((c) => c.id === activeTab.connectionId);
    const dbType: DatabaseType = conn?.dbType ?? "mysql";
    // If opened from an existing table, load its structure first
    if (meta?.objectName) {
      return (
        <DesignerLoader
          connectionId={activeTab.connectionId}
          dbType={dbType}
          database={meta.database as string}
          schema={meta.schema as string | undefined}
          tableName={meta.objectName as string}
        />
      );
    }
    return (
      <TableDesignerTab
        connectionId={activeTab.connectionId}
        dbType={dbType}
      />
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {activeTab.title}
    </div>
  );
}

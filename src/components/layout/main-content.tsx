import { Button } from "@/components/ui/button";
import { lazy, Suspense } from "react";
import { TabActiveContext } from "@/hooks/use-tab-active";
import { RecentPanel } from "./recent-panel";
import { useWorkspaceStore, type Tab } from "@/stores/workspace-store";
import { TableStructurePanel } from "@/components/explorer/table-structure-panel";
const ObjectDdlTab = lazy(() =>
  import("@/components/explorer/object-ddl-tab").then((m) => ({
    default: m.ObjectDdlTab,
  })),
);
const SequenceManagerTab = lazy(() =>
  import("@/components/explorer/sequence-manager-tab").then((m) => ({
    default: m.SequenceManagerTab,
  })),
);
const EnumManagerTab = lazy(() =>
  import("@/components/explorer/enum-manager-tab").then((m) => ({
    default: m.EnumManagerTab,
  })),
);
const QueryTab = lazy(() =>
  import("@/components/editor/query-tab").then((m) => ({
    default: m.QueryTab,
  })),
);
import { TableDataTab } from "@/components/grid/table-data-tab";
const TableDesignerTab = lazy(() =>
  import("@/components/designer/table-designer-tab").then((m) => ({
    default: m.TableDesignerTab,
  })),
);
const UserManagementTab = lazy(() =>
  import("@/components/admin/user-management-tab").then((m) => ({
    default: m.UserManagementTab,
  })),
);
const ProcessListTab = lazy(() =>
  import("@/components/admin/process-list-tab").then((m) => ({
    default: m.ProcessListTab,
  })),
);
const DiskUsageTab = lazy(() =>
  import("@/components/admin/disk-usage-tab").then((m) => ({
    default: m.DiskUsageTab,
  })),
);
const SchemaDiffTab = lazy(() =>
  import("@/components/admin/schema-diff-tab").then((m) => ({
    default: m.SchemaDiffTab,
  })),
);
import { useConnections } from "@/hooks/use-connections";
import { useQuery } from "@tanstack/react-query";
import { getTableDesignerState } from "@/lib/designer-loader";
import { Database, Loader2 } from "lucide-react";
import type { DatabaseType } from "@/types/database";
import type { DesignerState } from "@/types/designer";

// ─── Loader for existing-table designer ──────────────────────────

function DesignerLoader({
  tabId,
  connectionId,
  dbType,
  database,
  schema,
  tableName,
}: {
  tabId: string;
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
      tabId={tabId}
      key={`${connectionId}/${database}/${schema}/${tableName}`}
      connectionId={connectionId}
      dbType={dbType}
      initialState={data}
    />
  );
}

export function MainContent() {
  const { tabs, activeTabId } = useWorkspaceStore();
  if (!activeTabId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <Database className="size-12 opacity-30" />
        <p className="text-lg font-medium text-foreground">
          继续你的数据库工作
        </p>
        <p className="text-sm">
          从左侧连接数据库，按 Cmd+N 创建查询。SQL 草稿随工作区自动恢复。
        </p>
        <Button
          onClick={() =>
            window.dispatchEvent(new Event("lotdb:new-connection"))
          }
        >
          新建连接
        </Button>
        <div className="mt-4 w-full max-w-lg rounded-lg border bg-card p-3">
          <RecentPanel limit={8} />
        </div>
      </div>
    );
  }

  return (
    <>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={
            tab.id === activeTabId ? "flex min-h-0 flex-1 flex-col" : "hidden"
          }
        >
          <TabActiveContext.Provider value={tab.id === activeTabId}>
            <Suspense
              fallback={
                <div className="p-4 text-sm text-muted-foreground">
                  加载工作区…
                </div>
              }
            >
              <TabContent activeTab={tab} />
            </Suspense>
          </TabActiveContext.Provider>
        </div>
      ))}
    </>
  );
}

function TabContent({ activeTab }: { activeTab: Tab }) {
  const { data: connections = [] } = useConnections();

  const meta = activeTab.metadata as
    | {
        database?: string;
        schema?: string;
        objectName?: string;
        objectType?: string;
        /** object-ddl tab: "view" | "function" | "trigger" */
        ddlKind?: "view" | "function" | "trigger";
        /** trigger's parent table */
        table?: string;
        /** object-manager tab: "sequences" | "enums" */
        managerKind?: "sequences" | "enums";
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

  if (activeTab.type === "table-data" && meta?.database && meta?.objectName) {
    return (
      <TableDataTab
        tabId={activeTab.id}
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
          tabId={activeTab.id}
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
        tabId={activeTab.id}
        connectionId={activeTab.connectionId}
        dbType={dbType}
      />
    );
  }

  if (activeTab.type === "users") {
    const conn = connections.find((c) => c.id === activeTab.connectionId);
    const dbType: DatabaseType = conn?.dbType ?? "mysql";
    return (
      <UserManagementTab
        connectionId={activeTab.connectionId}
        dbType={dbType}
      />
    );
  }

  if (activeTab.type === "process-list") {
    const conn = connections.find((c) => c.id === activeTab.connectionId);
    const dbType: DatabaseType = conn?.dbType ?? "mysql";
    return (
      <ProcessListTab connectionId={activeTab.connectionId} dbType={dbType} />
    );
  }

  if (activeTab.type === "disk-usage") {
    const conn = connections.find((c) => c.id === activeTab.connectionId);
    const dbType: DatabaseType = conn?.dbType ?? "mysql";
    return (
      <DiskUsageTab connectionId={activeTab.connectionId} dbType={dbType} />
    );
  }

  if (activeTab.type === "schema-diff") {
    return <SchemaDiffTab />;
  }

  if (
    activeTab.type === "object-ddl" &&
    meta?.database &&
    meta?.objectName &&
    meta?.ddlKind
  ) {
    return (
      <ObjectDdlTab
        connectionId={activeTab.connectionId}
        database={meta.database}
        schema={meta.schema}
        name={meta.objectName}
        kind={meta.ddlKind}
        triggerTable={meta.table}
      />
    );
  }

  if (
    activeTab.type === "object-manager" &&
    meta?.database &&
    meta?.managerKind
  ) {
    if (meta.managerKind === "sequences") {
      return (
        <SequenceManagerTab
          connectionId={activeTab.connectionId}
          database={meta.database}
          schema={meta.schema}
        />
      );
    }
    return (
      <EnumManagerTab
        connectionId={activeTab.connectionId}
        database={meta.database}
        schema={meta.schema}
      />
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {activeTab.title}
    </div>
  );
}

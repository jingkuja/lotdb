import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Database,
  Layers,
  Table2,
  Eye,
  FunctionSquare,
  Folder,
  Loader2,
  AlertCircle,
  Pencil,
  Download,
  Plus,
  Trash2,
  Users,
  Activity,
  HardDrive,
  GitCompare,
  Send,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDatabases, useSchemas, useObjects } from "@/hooks/use-schema";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { DatabaseType } from "@/types/database";
import { BatchExportDialog } from "@/components/transfer/batch-export-dialog";
import { DataTransferDialog } from "@/components/transfer/data-transfer-dialog";
import { BackupDialog } from "@/components/transfer/backup-dialog";
import { RestoreDialog } from "@/components/transfer/restore-dialog";
import { CreateDatabaseDialog } from "@/components/admin/create-database-dialog";
import { dropDatabase } from "@/services/tauri-commands";
import { useQueryClient } from "@tanstack/react-query";
import { useConnections } from "@/hooks/use-connections";

// ─── TreeRow — generic row with indent, icon, label ──────────────

interface TreeRowProps {
  level: number;
  icon: React.ReactNode;
  label: string;
  expanded?: boolean;
  expandable?: boolean;
  loading?: boolean;
  error?: boolean;
  active?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  children?: React.ReactNode;
}

function TreeRow({
  level,
  icon,
  label,
  expanded,
  expandable,
  loading,
  error,
  active,
  onClick,
  onDoubleClick,
  children,
}: TreeRowProps) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded py-[2px] text-xs cursor-pointer select-none",
        "hover:bg-sidebar-accent/60",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
        error && "text-destructive",
      )}
      style={{ paddingLeft: `${level * 14 + 4}px`, paddingRight: "4px" }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Chevron */}
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {loading ? (
          <Loader2 className="size-3 animate-spin" />
        ) : expandable ? (
          expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )
        ) : null}
      </span>

      {/* Icon */}
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center",
          error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {error ? <AlertCircle className="size-3" /> : icon}
      </span>

      {/* Label */}
      <span className="min-w-0 flex-1 truncate">{label}</span>

      {/* Hover actions */}
      {children && (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
          {children}
        </span>
      )}
    </div>
  );
}

// ─── ObjectLeaf — table / view / function ─────────────────────────

interface ObjectLeafProps {
  name: string;
  type: "table" | "view" | "function";
  level: number;
  connectionId: string;
  database: string;
  schema?: string;
}

function ObjectLeaf({
  name,
  type,
  level,
  connectionId,
  database,
  schema,
}: ObjectLeafProps) {
  const addTab = useWorkspaceStore((s) => s.addTab);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);

  const tabId = [connectionId, database, schema, type, name]
    .filter(Boolean)
    .join("/");

  const icon =
    type === "table" ? (
      <Table2 className="size-3" />
    ) : type === "view" ? (
      <Eye className="size-3" />
    ) : (
      <FunctionSquare className="size-3" />
    );

  const openTab = (tabType: "table-structure" | "table-data" | "query" | "designer") => {
    const id =
      tabType === "table-data" ? `${tabId}/data` :
      tabType === "designer" ? `${tabId}/designer` :
      tabId;
    const existing = tabs.find((t) => t.id === id);
    if (existing) {
      setActiveTab(id);
    } else {
      addTab({
        id,
        title:
          tabType === "table-data" ? `${name} (数据)` :
          tabType === "designer" ? `${name} (设计)` :
          name,
        type: tabType === "designer" ? "designer" : tabType,
        connectionId,
        metadata: { database, schema, objectName: name, objectType: type },
      });
    }
  };

  const handleClick = () => {
    if (type === "table") openTab("table-data");
    else openTab("query");
  };

  const handleDoubleClick = () => {
    if (type === "table") openTab("table-structure");
    else openTab("query");
  };

  return (
    <TreeRow
      level={level}
      icon={icon}
      label={name}
      expandable={false}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {type === "table" && (
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
          title="在设计器中编辑"
          onClick={(e) => {
            e.stopPropagation();
            openTab("designer");
          }}
        >
          <Pencil className="size-3" />
        </button>
      )}
    </TreeRow>
  );
}

// ─── CategoryNode — "Tables" / "Views" / "Functions" folder ───────

interface CategoryNodeProps {
  label: string;
  items: string[];
  type: "table" | "view" | "function";
  level: number;
  connectionId: string;
  database: string;
  schema?: string;
}

function CategoryNode({
  label,
  items,
  type,
  level,
  connectionId,
  database,
  schema,
}: CategoryNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [batchExportOpen, setBatchExportOpen] = useState(false);

  if (items.length === 0) return null;

  return (
    <>
      <TreeRow
        level={level}
        icon={<Folder className="size-3" />}
        label={`${label} (${items.length})`}
        expandable
        expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {type === "table" && (
          <button
            className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
            title="批量导出所有表"
            onClick={(e) => {
              e.stopPropagation();
              setBatchExportOpen(true);
            }}
          >
            <Download className="size-3" />
          </button>
        )}
      </TreeRow>
      {expanded &&
        items.map((name) => (
          <ObjectLeaf
            key={name}
            name={name}
            type={type}
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
        ))}
      {type === "table" && (
        <BatchExportDialog
          open={batchExportOpen}
          onOpenChange={setBatchExportOpen}
          connectionId={connectionId}
          database={database}
          schema={schema}
          tables={items}
        />
      )}
    </>
  );
}

// ─── SchemaNode — PG schema, loads objects on expand ──────────────

interface SchemaNodeProps {
  schema: string;
  database: string;
  connectionId: string;
  level: number;
}

function SchemaNode({ schema, database, connectionId, level }: SchemaNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, isError } = useObjects(
    connectionId,
    database,
    schema,
    expanded,
  );

  return (
    <>
      <TreeRow
        level={level}
        icon={<Layers className="size-3" />}
        label={schema}
        expandable
        expanded={expanded}
        loading={expanded && isLoading}
        error={isError}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded && data && (
        <>
          <CategoryNode
            label="Tables"
            items={data.tables}
            type="table"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
          <CategoryNode
            label="Views"
            items={data.views}
            type="view"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
          <CategoryNode
            label="Functions"
            items={data.functions}
            type="function"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
        </>
      )}
    </>
  );
}

// ─── MySqlDbNode — MySQL database, loads objects directly ─────────

interface MySqlDbNodeProps {
  database: string;
  connectionId: string;
  level: number;
}

function MySqlDbNode({ database, connectionId, level }: MySqlDbNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const { data, isLoading, isError } = useObjects(
    connectionId,
    database,
    undefined,
    expanded,
  );
  const queryClient = useQueryClient();

  const handleDrop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`确定要删除数据库 "${database}" 吗？此操作不可撤销！`)) return;
    setDropping(true);
    try {
      await dropDatabase(connectionId, database);
      queryClient.invalidateQueries({ queryKey: ["databases", connectionId] });
    } catch (err) {
      alert(String(err));
    } finally {
      setDropping(false);
    }
  };

  return (
    <>
      <TreeRow
        level={level}
        icon={<Database className="size-3" />}
        label={database}
        expandable
        expanded={expanded}
        loading={(expanded && isLoading) || dropping}
        error={isError}
        onClick={() => setExpanded((v) => !v)}
      >
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
          title="备份数据库"
          onClick={(e) => { e.stopPropagation(); setBackupOpen(true); }}
        >
          <Archive className="size-3" />
        </button>
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
          title="恢复数据库"
          onClick={(e) => { e.stopPropagation(); setRestoreOpen(true); }}
        >
          <ArchiveRestore className="size-3" />
        </button>
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-destructive"
          title="删除数据库"
          onClick={handleDrop}
        >
          <Trash2 className="size-3" />
        </button>
      </TreeRow>
      <BackupDialog
        open={backupOpen}
        onOpenChange={setBackupOpen}
        connectionId={connectionId}
        database={database}
      />
      <RestoreDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        connectionId={connectionId}
        database={database}
      />
      {expanded && data && (
        <>
          <CategoryNode
            label="Tables"
            items={data.tables}
            type="table"
            level={level + 1}
            connectionId={connectionId}
            database={database}
          />
          <CategoryNode
            label="Views"
            items={data.views}
            type="view"
            level={level + 1}
            connectionId={connectionId}
            database={database}
          />
          <CategoryNode
            label="Functions"
            items={data.functions}
            type="function"
            level={level + 1}
            connectionId={connectionId}
            database={database}
          />
        </>
      )}
    </>
  );
}

// ─── PgDbNode — PG database (= current db), loads schemas ─────────

interface PgDbNodeProps {
  database: string;
  connectionId: string;
  level: number;
}

function PgDbNode({ database, connectionId, level }: PgDbNodeProps) {
  // Auto-expand since PG always shows a single database
  const [expanded, setExpanded] = useState(true);
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const { data: schemas = [], isLoading, isError } = useSchemas(
    connectionId,
    database,
    expanded,
  );

  return (
    <>
      <TreeRow
        level={level}
        icon={<Database className="size-3" />}
        label={database}
        expandable
        expanded={expanded}
        loading={expanded && isLoading}
        error={isError}
        onClick={() => setExpanded((v) => !v)}
      >
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
          title="备份数据库"
          onClick={(e) => { e.stopPropagation(); setBackupOpen(true); }}
        >
          <Archive className="size-3" />
        </button>
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
          title="恢复数据库"
          onClick={(e) => { e.stopPropagation(); setRestoreOpen(true); }}
        >
          <ArchiveRestore className="size-3" />
        </button>
      </TreeRow>
      <BackupDialog
        open={backupOpen}
        onOpenChange={setBackupOpen}
        connectionId={connectionId}
        database={database}
      />
      <RestoreDialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        connectionId={connectionId}
        database={database}
      />
      {expanded &&
        schemas.map((schema) => (
          <SchemaNode
            key={schema}
            schema={schema}
            database={database}
            connectionId={connectionId}
            level={level + 1}
          />
        ))}
    </>
  );
}

// ─── ObjectTree — top-level export ───────────────────────────────

interface ObjectTreeProps {
  connectionId: string;
  dbType: DatabaseType;
}

export function ObjectTree({ connectionId, dbType }: ObjectTreeProps) {
  const { data: databases = [], isLoading, isError } = useDatabases(connectionId);
  const [createOpen, setCreateOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data: connections = [] } = useConnections();
  const addTab = useWorkspaceStore((s) => s.addTab);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);

  const openUsersTab = () => {
    const tabId = `${connectionId}/users`;
    const existing = tabs.find((t) => t.id === tabId);
    if (existing) {
      setActiveTab(tabId);
    } else {
      addTab({
        id: tabId,
        title: "用户管理",
        type: "users",
        connectionId,
      });
    }
  };

  const openProcessTab = () => {
    const tabId = `${connectionId}/processes`;
    const existing = tabs.find((t) => t.id === tabId);
    if (existing) {
      setActiveTab(tabId);
    } else {
      addTab({
        id: tabId,
        title: "活跃查询",
        type: "process-list",
        connectionId,
      });
    }
  };

  const openDiskUsageTab = () => {
    const tabId = `${connectionId}/disk-usage`;
    const existing = tabs.find((t) => t.id === tabId);
    if (existing) {
      setActiveTab(tabId);
    } else {
      addTab({
        id: tabId,
        title: "磁盘占用",
        type: "disk-usage",
        connectionId,
      });
    }
  };

  const openSchemaDiffTab = () => {
    const tabId = "schema-diff";
    const existing = tabs.find((t) => t.id === tabId);
    if (existing) {
      setActiveTab(tabId);
    } else {
      addTab({
        id: tabId,
        title: "结构对比",
        type: "schema-diff",
        connectionId,
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        <span>加载中...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-destructive">
        <AlertCircle className="size-3" />
        <span>加载失败</span>
      </div>
    );
  }

  return (
    <>
      <div className="py-0.5">
        {/* Header row with action buttons */}
        <div className="group flex items-center justify-between px-2 py-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            数据库
          </span>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
            <button
              className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
              title="跨连接传输"
              onClick={() => setTransferOpen(true)}
            >
              <Send className="size-3" />
            </button>
            <button
              className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
              title="结构对比"
              onClick={openSchemaDiffTab}
            >
              <GitCompare className="size-3" />
            </button>
            <button
              className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
              title="磁盘占用"
              onClick={openDiskUsageTab}
            >
              <HardDrive className="size-3" />
            </button>
            <button
              className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
              title="活跃查询"
              onClick={openProcessTab}
            >
              <Activity className="size-3" />
            </button>
            <button
              className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
              title="用户管理"
              onClick={openUsersTab}
            >
              <Users className="size-3" />
            </button>
            {dbType === "mysql" && (
              <button
                className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
                title="新建数据库"
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="size-3" />
              </button>
            )}
          </div>
        </div>
        {databases.map((db) =>
          dbType === "mysql" ? (
            <MySqlDbNode
              key={db}
              database={db}
              connectionId={connectionId}
              level={1}
            />
          ) : (
            <PgDbNode
              key={db}
              database={db}
              connectionId={connectionId}
              level={1}
            />
          ),
        )}
      </div>

      <CreateDatabaseDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        connectionId={connectionId}
        dbType={dbType}
        onSuccess={() =>
          queryClient.invalidateQueries({ queryKey: ["databases", connectionId] })
        }
      />

      <DataTransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        connections={connections}
      />
    </>
  );
}

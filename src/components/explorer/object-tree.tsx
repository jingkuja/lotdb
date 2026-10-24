import { createContext, useContext, useState } from "react";
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
  Zap,
  ListOrdered,
  Shapes,
  ExternalLink,
  Hash,
  FileCode,
  Copy,
  Eraser,
  TextCursorInput,
  Search,
  X,
  Settings2,
  Terminal,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDatabases, useSchemas, useObjects } from "@/hooks/use-schema";
import { useTriggers, useSequences, useEnums } from "@/hooks/use-objects";
import {
  copyTable,
  dropObject,
  dropTrigger,
  renameTable,
  truncateTable,
  type DroppableObject,
} from "@/services/tauri-commands";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { DatabaseType } from "@/types/database";
import { BatchExportDialog } from "@/components/transfer/batch-export-dialog";
import { DataTransferDialog } from "@/components/transfer/data-transfer-dialog";
import { BackupDialog } from "@/components/transfer/backup-dialog";
import { RestoreDialog } from "@/components/transfer/restore-dialog";
import { CreateDatabaseDialog } from "@/components/admin/create-database-dialog";
import { dropDatabase, openConnection } from "@/services/tauri-commands";
import { useConnectionStore } from "@/stores/connection-store";
import {
  alertDialog,
  confirmDialog,
  promptDialog,
} from "@/stores/app-dialog-store";
import {
  ContextMenu,
  ContextMenuButton,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { useConnections } from "@/hooks/use-connections";
import { formatDbError, isConnectionError } from "@/lib/error";

// ─── Filter ───────────────────────────────────────────────────────

/** Lower-cased text of the tree's filter box; "" shows everything. */
const TreeFilterContext = createContext("");

function matchesFilter(name: string, filter: string) {
  return !filter || name.toLowerCase().includes(filter);
}

/** Schemas every MySQL server has; listed apart from user databases. */
const MYSQL_SYSTEM_DATABASES = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
]);

// ─── RowMenu — right-click (or ⋯) actions for one tree row ────────

/** True inside a RowMenu: the TreeRow shows a ⋯ button for the menu. */
const RowMenuContext = createContext(false);

function RowMenu({
  label,
  items,
  children,
}: {
  label: string;
  /** Menu items; a falsy value renders the row without a menu. */
  items: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!items) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <RowMenuContext.Provider value={true}>
            {children}
          </RowMenuContext.Provider>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{label}</ContextMenuLabel>
        {items}
      </ContextMenuContent>
    </ContextMenu>
  );
}

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
  children,
}: TreeRowProps) {
  const hasMenu = useContext(RowMenuContext);
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
      {(children || hasMenu) && (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 has-focus-visible:opacity-100">
          {children}
          {hasMenu && <ContextMenuButton label={`${label} 的操作`} />}
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

  const openTab = (
    tabType:
      | "table-structure"
      | "table-data"
      | "query"
      | "designer"
      | "object-ddl",
  ) => {
    const id =
      tabType === "table-data"
        ? `${tabId}/data`
        : tabType === "designer"
          ? `${tabId}/designer`
          : tabType === "object-ddl"
            ? `${tabId}/ddl`
            : tabId;
    // addTab switches to the tab when it is already open.
    addTab({
      id,
      title:
        tabType === "table-data"
          ? `${name} (数据)`
          : tabType === "designer"
            ? `${name} (设计)`
            : name,
      type: tabType,
      connectionId,
      metadata: {
        database,
        schema,
        objectName: name,
        objectType: type,
        ddlKind:
          tabType === "object-ddl"
            ? type === "view"
              ? "view"
              : "function"
            : undefined,
      },
    });
  };

  // One click opens one tab. Tables and views open their data (views are
  // selectable); other views of the object are explicit row actions.
  const handleClick = () => {
    if (type === "function") openTab("object-ddl");
    else openTab("table-data");
  };

  const action = (
    title: string,
    tabType: Parameters<typeof openTab>[0],
    icon: React.ReactNode,
  ) => (
    <button
      className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        openTab(tabType);
      }}
    >
      {icon}
    </button>
  );

  const ops = useObjectOperations(connectionId, database, schema, tabId);
  const typeLabel = type === "table" ? "表" : type === "view" ? "视图" : "函数";

  return (
    <RowMenu
      label={name}
      items={
        <>
          {type !== "function" && (
            <ContextMenuItem onSelect={() => openTab("table-data")}>
              <Table2 />
              打开数据
            </ContextMenuItem>
          )}
          {type === "table" && (
            <>
              <ContextMenuItem onSelect={() => openTab("table-structure")}>
                <Hash />
                查看结构
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => openTab("designer")}>
                <Pencil />
                在设计器中编辑
              </ContextMenuItem>
            </>
          )}
          {type !== "table" && (
            <ContextMenuItem onSelect={() => openTab("object-ddl")}>
              <FileCode />
              查看定义
            </ContextMenuItem>
          )}
          <ContextMenuItem
            onSelect={() => void navigator.clipboard.writeText(name)}
          >
            <Copy />
            复制名称
          </ContextMenuItem>
          {type === "table" && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={ops.readonly}
                onSelect={() => void ops.rename(name)}
              >
                <TextCursorInput />
                重命名…
              </ContextMenuItem>
              <ContextMenuItem
                disabled={ops.readonly}
                onSelect={() => void ops.copy(name, false)}
              >
                <Copy />
                复制表（仅结构）…
              </ContextMenuItem>
              <ContextMenuItem
                disabled={ops.readonly}
                onSelect={() => void ops.copy(name, true)}
              >
                <Copy />
                复制表（结构和数据）…
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                disabled={ops.readonly}
                onSelect={() => void ops.truncate(name)}
              >
                <Eraser />
                清空表…
              </ContextMenuItem>
            </>
          )}
          {type !== "table" && <ContextMenuSeparator />}
          <ContextMenuItem
            variant="destructive"
            disabled={ops.readonly}
            onSelect={() => void ops.drop(type, name)}
          >
            <Trash2 />
            删除{typeLabel}…
          </ContextMenuItem>
        </>
      }
    >
      <TreeRow
        level={level}
        icon={icon}
        label={name}
        expandable={false}
        loading={ops.busy}
        onClick={handleClick}
      >
        {type === "table" && (
          <>
            {action("查看结构", "table-structure", <Hash className="size-3" />)}
            {action(
              "在设计器中编辑",
              "designer",
              <Pencil className="size-3" />,
            )}
          </>
        )}
        {type === "view" &&
          action("查看定义", "object-ddl", <FileCode className="size-3" />)}
      </TreeRow>
    </RowMenu>
  );
}

/**
 * Drop / truncate / rename / copy for one object-tree leaf. Each asks first
 * (in-app dialogs: native ones don't work in the webview), refreshes the
 * object list, and closes tabs of an object that no longer exists.
 */
function useObjectOperations(
  connectionId: string,
  database: string,
  schema: string | undefined,
  tabPrefix: string,
) {
  const queryClient = useQueryClient();
  const { data: connections = [] } = useConnections();
  const readonly = !!connections.find((c) => c.id === connectionId)?.readonly;
  const [busy, setBusy] = useState(false);

  const run = async (title: string, work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
      await queryClient.invalidateQueries({
        queryKey: ["objects", connectionId, database],
      });
    } catch (err) {
      await alertDialog(formatDbError(err), { title });
    } finally {
      setBusy(false);
    }
  };

  const closeTabs = async () => {
    const { tabs, removeTab } = useWorkspaceStore.getState();
    for (const tab of tabs) {
      if (tab.id === tabPrefix || tab.id.startsWith(`${tabPrefix}/`))
        await removeTab(tab.id);
    }
  };

  /** The entered name, or null when cancelled, empty or still `current`. */
  const askName = async (
    message: string,
    initial: string,
    title: string,
    current: string,
  ) => {
    const value = (await promptDialog(message, initial, { title }))?.trim();
    return value && value !== current ? value : null;
  };

  return {
    readonly,
    busy,
    drop: async (kind: DroppableObject, name: string) => {
      const label = kind === "table" ? "表" : kind === "view" ? "视图" : "函数";
      if (
        !(await confirmDialog(
          `确定要删除${label} "${name}" 吗？此操作不可撤销！`,
          { title: `删除${label}`, confirmLabel: "删除", destructive: true },
        ))
      )
        return;
      await run("删除失败", async () => {
        await dropObject(connectionId, database, schema, kind, name);
        await closeTabs();
      });
    },
    truncate: async (name: string) => {
      if (
        !(await confirmDialog(
          `确定要清空表 "${name}" 的全部数据吗？此操作不可撤销！`,
          { title: "清空表", confirmLabel: "清空", destructive: true },
        ))
      )
        return;
      await run("清空失败", async () => {
        await truncateTable(connectionId, database, schema, name);
        await queryClient.invalidateQueries({
          queryKey: ["table-data", connectionId, database],
        });
        await queryClient.invalidateQueries({
          queryKey: ["table-count", connectionId, database],
        });
      });
    },
    rename: async (name: string) => {
      const next = await askName("输入新的表名：", name, "重命名表", name);
      if (!next) return;
      await run("重命名失败", async () => {
        await renameTable(connectionId, database, schema, name, next);
        await closeTabs();
      });
    },
    copy: async (name: string, withData: boolean) => {
      const next = await askName(
        withData ? "复制表结构和数据到新表：" : "复制表结构到新表：",
        `${name}_copy`,
        "复制表",
        name,
      );
      if (!next) return;
      await run("复制失败", () =>
        copyTable(connectionId, database, schema, name, next, withData),
      );
    },
  };
}

// ─── CategoryNode — 表 / 视图 / 函数 folder ─────────────────────────

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
  const filter = useContext(TreeFilterContext);

  if (items.length === 0) return null;
  const shown = filter
    ? items.filter((name) => matchesFilter(name, filter))
    : items;
  // While filtering, a folder with matches opens by itself; one without
  // matches disappears.
  if (filter && shown.length === 0) return null;
  const open = expanded || !!filter;

  return (
    <>
      <RowMenu
        label={label}
        items={
          type === "table" && (
            <ContextMenuItem onSelect={() => setBatchExportOpen(true)}>
              <Download />
              批量导出表…
            </ContextMenuItem>
          )
        }
      >
        <TreeRow
          level={level}
          icon={<Folder className="size-3" />}
          label={
            filter
              ? `${label} (${shown.length}/${items.length})`
              : `${label} (${items.length})`
          }
          expandable
          expanded={open}
          onClick={() => setExpanded(!open)}
        />
      </RowMenu>
      {open &&
        shown.map((name) => (
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

// ─── TriggersCategory — lazy trigger list with DDL view / delete ──

interface TriggersCategoryProps {
  level: number;
  connectionId: string;
  database: string;
  schema?: string;
}

function TriggersCategory({
  level,
  connectionId,
  database,
  schema,
}: TriggersCategoryProps) {
  const [expanded, setExpanded] = useState(false);
  const {
    data: triggers = [],
    isLoading,
    isError,
  } = useTriggers(connectionId, database, schema, expanded);
  const addTab = useWorkspaceStore((s) => s.addTab);
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<string | null>(null);

  const openDdl = (name: string, table: string) => {
    const id = [connectionId, database, schema, "trigger", name, "ddl"].join(
      "/",
    );
    addTab({
      id,
      title: name,
      type: "object-ddl",
      connectionId,
      metadata: {
        database,
        schema,
        objectName: name,
        objectType: "trigger",
        ddlKind: "trigger",
        table,
      },
    });
  };

  const handleDelete = async (name: string, table: string) => {
    if (
      !(await confirmDialog(`确定要删除触发器 "${name}" 吗？`, {
        title: "删除触发器",
        confirmLabel: "删除",
        destructive: true,
      }))
    )
      return;
    setDeleting(name);
    try {
      await dropTrigger(connectionId, database, schema, table, name);
      queryClient.invalidateQueries({
        queryKey: ["triggers", connectionId, database],
      });
    } catch (err) {
      await alertDialog(formatDbError(err), { title: "删除失败" });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <TreeRow
        level={level}
        icon={<Zap className="size-3" />}
        label={`触发器${expanded && !isLoading ? ` (${triggers.length})` : ""}`}
        expandable
        expanded={expanded}
        loading={expanded && isLoading}
        error={isError}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded &&
        (isLoading ? null : isError ? (
          <TreeRow
            level={level + 1}
            icon={<AlertCircle className="size-3" />}
            label="加载失败"
            error
          />
        ) : triggers.length === 0 ? (
          <TreeRow
            level={level + 1}
            icon={<Zap className="size-3" />}
            label="（无）"
          />
        ) : (
          triggers.map((t) => (
            <RowMenu
              key={`${t.table}.${t.name}`}
              label={t.name}
              items={
                <>
                  <ContextMenuItem onSelect={() => openDdl(t.name, t.table)}>
                    <FileCode />
                    查看定义
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() => void navigator.clipboard.writeText(t.name)}
                  >
                    <Copy />
                    复制名称
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    disabled={deleting !== null}
                    onSelect={() => void handleDelete(t.name, t.table)}
                  >
                    <Trash2 />
                    删除触发器…
                  </ContextMenuItem>
                </>
              }
            >
              <TreeRow
                level={level + 1}
                icon={<Zap className="size-3" />}
                label={`${t.name} · ${t.table}`}
                loading={deleting === t.name}
                onClick={() => openDdl(t.name, t.table)}
              />
            </RowMenu>
          ))
        ))}
    </>
  );
}

// ─── PgManagerCategory — 序列 / 枚举 with a manager tab ─────────────

interface PgManagerCategoryProps {
  label: string;
  icon: React.ReactNode;
  managerKind: "sequences" | "enums";
  level: number;
  connectionId: string;
  database: string;
  schema: string;
  /** Load names for the count badge. */
  useList: (
    connectionId: string,
    database: string,
    schema: string | undefined,
    enabled: boolean,
  ) => { data?: { name: string }[]; isLoading: boolean; isError: boolean };
}

function PgManagerCategory({
  label,
  icon,
  managerKind,
  level,
  connectionId,
  database,
  schema,
  useList,
}: PgManagerCategoryProps) {
  const [expanded, setExpanded] = useState(false);
  const {
    data: items = [],
    isLoading,
    isError,
  } = useList(connectionId, database, schema, expanded);
  const addTab = useWorkspaceStore((s) => s.addTab);

  const openManager = () =>
    addTab({
      id: [connectionId, database, schema, managerKind, "manager"].join("/"),
      title: `${schema} · ${label}`,
      type: "object-manager",
      connectionId,
      metadata: { database, schema, managerKind },
    });

  return (
    <>
      <RowMenu
        label={label}
        items={
          <ContextMenuItem onSelect={openManager}>
            <ExternalLink />
            管理{label}…
          </ContextMenuItem>
        }
      >
        <TreeRow
          level={level}
          icon={icon}
          label={`${label}${expanded && !isLoading ? ` (${items.length})` : ""}`}
          expandable
          expanded={expanded}
          loading={expanded && isLoading}
          error={isError}
          onClick={() => setExpanded((v) => !v)}
        />
      </RowMenu>
      {expanded &&
        (isLoading ? null : isError ? (
          <TreeRow
            level={level + 1}
            icon={<AlertCircle className="size-3" />}
            label="加载失败"
            error
          />
        ) : items.length === 0 ? (
          <TreeRow
            level={level + 1}
            icon={icon}
            label="（无）"
            onClick={openManager}
          />
        ) : (
          items.map((item) => (
            <TreeRow
              key={item.name}
              level={level + 1}
              icon={icon}
              label={item.name}
              onClick={openManager}
            />
          ))
        ))}
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

function SchemaNode({
  schema,
  database,
  connectionId,
  level,
}: SchemaNodeProps) {
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
            label="表"
            items={data.tables}
            type="table"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
          <CategoryNode
            label="视图"
            items={data.views}
            type="view"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
          <CategoryNode
            label="函数"
            items={data.functions}
            type="function"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
          <TriggersCategory
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
          <PgManagerCategory
            label="序列"
            icon={<ListOrdered className="size-3" />}
            managerKind="sequences"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
            useList={useSequences}
          />
          <PgManagerCategory
            label="枚举"
            icon={<Shapes className="size-3" />}
            managerKind="enums"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
            useList={useEnums}
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

/**
 * A database row: click toggles it; backup, restore, a query in this
 * database and drop live in its context menu.
 */
function DatabaseRow({
  database,
  connectionId,
  level,
  expanded,
  loading,
  error,
  onToggle,
}: {
  database: string;
  connectionId: string;
  level: number;
  expanded: boolean;
  loading: boolean;
  error: boolean;
  onToggle: () => void;
}) {
  const [dropping, setDropping] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const queryClient = useQueryClient();
  const addTab = useWorkspaceStore((s) => s.addTab);
  const { data: connections = [] } = useConnections();
  const readonly = !!connections.find((c) => c.id === connectionId)?.readonly;

  const handleDrop = async () => {
    if (
      !(await confirmDialog(
        `确定要删除数据库 "${database}" 吗？此操作不可撤销！`,
        {
          title: "删除数据库",
          confirmLabel: "删除",
          destructive: true,
        },
      ))
    )
      return;
    setDropping(true);
    try {
      await dropDatabase(connectionId, database);
      queryClient.invalidateQueries({ queryKey: ["databases", connectionId] });
    } catch (err) {
      await alertDialog(formatDbError(err), { title: "删除失败" });
    } finally {
      setDropping(false);
    }
  };

  const newQuery = () =>
    addTab({
      id: `query-${connectionId}-${Date.now()}`,
      title: "新查询",
      type: "query",
      connectionId,
      metadata: { database },
    });

  return (
    <>
      <RowMenu
        label={database}
        items={
          <>
            <ContextMenuItem onSelect={newQuery}>
              <Terminal />
              在此库新建查询
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                void queryClient.invalidateQueries({
                  predicate: (q) =>
                    q.queryKey[1] === connectionId &&
                    q.queryKey[2] === database,
                })
              }
            >
              <RefreshCw />
              刷新
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => void navigator.clipboard.writeText(database)}
            >
              <Copy />
              复制名称
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => setBackupOpen(true)}>
              <Archive />
              备份数据库…
            </ContextMenuItem>
            <ContextMenuItem
              disabled={readonly}
              onSelect={() => setRestoreOpen(true)}
            >
              <ArchiveRestore />
              恢复数据库…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={readonly}
              onSelect={() => void handleDrop()}
            >
              <Trash2 />
              删除数据库…
            </ContextMenuItem>
          </>
        }
      >
        <TreeRow
          level={level}
          icon={<Database className="size-3" />}
          label={database}
          expandable
          expanded={expanded}
          loading={loading || dropping}
          error={error}
          onClick={onToggle}
        />
      </RowMenu>
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
    </>
  );
}

function MySqlDbNode({ database, connectionId, level }: MySqlDbNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, isError } = useObjects(
    connectionId,
    database,
    undefined,
    expanded,
  );
  const filter = useContext(TreeFilterContext);

  // An open database stays, so its tables can be filtered.
  if (!expanded && !matchesFilter(database, filter)) return null;

  return (
    <>
      <DatabaseRow
        database={database}
        connectionId={connectionId}
        level={level}
        expanded={expanded}
        loading={expanded && isLoading}
        error={isError}
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && data && (
        <>
          <CategoryNode
            label="表"
            items={data.tables}
            type="table"
            level={level + 1}
            connectionId={connectionId}
            database={database}
          />
          <CategoryNode
            label="视图"
            items={data.views}
            type="view"
            level={level + 1}
            connectionId={connectionId}
            database={database}
          />
          <CategoryNode
            label="函数"
            items={data.functions}
            type="function"
            level={level + 1}
            connectionId={connectionId}
            database={database}
          />
          <TriggersCategory
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
  const {
    data: schemas = [],
    isLoading,
    isError,
  } = useSchemas(connectionId, database, expanded);
  const filter = useContext(TreeFilterContext);

  if (!expanded && !matchesFilter(database, filter)) return null;

  return (
    <>
      <DatabaseRow
        database={database}
        connectionId={connectionId}
        level={level}
        expanded={expanded}
        loading={expanded && isLoading}
        error={isError}
        onToggle={() => setExpanded((v) => !v)}
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
  const {
    data: databases = [],
    isLoading,
    isError,
    error,
  } = useDatabases(connectionId);
  const markPoolOpen = useConnectionStore((s) => s.markPoolOpen);
  const [reconnecting, setReconnecting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [systemOpen, setSystemOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data: connections = [] } = useConnections();
  const addTab = useWorkspaceStore((s) => s.addTab);
  const readonly = !!connections.find((c) => c.id === connectionId)?.readonly;

  const openUsersTab = () =>
    addTab({
      id: `${connectionId}/users`,
      title: "用户管理",
      type: "users",
      connectionId,
    });

  const openProcessTab = () =>
    addTab({
      id: `${connectionId}/processes`,
      title: "活跃查询",
      type: "process-list",
      connectionId,
    });

  const openDiskUsageTab = () =>
    addTab({
      id: `${connectionId}/disk-usage`,
      title: "磁盘占用",
      type: "disk-usage",
      connectionId,
    });

  const openSchemaDiffTab = () =>
    addTab({
      id: "schema-diff",
      title: "结构对比",
      type: "schema-diff",
      connectionId,
    });

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        <span>加载中...</span>
      </div>
    );
  }

  // Rebuilds the pool (and SSH tunnel); every cached query of this
  // connection is refetched against it.
  const handleReconnect = async () => {
    const conn = connections.find((c) => c.id === connectionId);
    if (!conn) return;
    setReconnecting(true);
    try {
      await openConnection(conn);
      markPoolOpen(conn.id);
      await queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[1] === connectionId,
      });
    } catch (e) {
      await alertDialog(formatDbError(e), { title: "重新连接失败" });
    } finally {
      setReconnecting(false);
    }
  };

  if (isError) {
    const lost = isConnectionError(error);
    return (
      <div className="flex flex-col gap-1 px-4 py-1.5 text-xs">
        <div className="flex items-center gap-1.5 text-destructive">
          <AlertCircle className="size-3" />
          <span>{lost ? "连接已断开" : "加载失败"}</span>
        </div>
        <span className="break-all text-muted-foreground">
          {formatDbError(error)}
        </span>
        {lost && (
          <button
            className="self-start rounded border border-sidebar-border px-1.5 py-0.5 hover:bg-sidebar-accent disabled:opacity-50"
            disabled={reconnecting}
            onClick={() => void handleReconnect()}
          >
            {reconnecting ? "正在重新连接…" : "重新连接"}
          </button>
        )}
      </div>
    );
  }

  const filter = filterText.trim().toLowerCase();
  const isSystem = (db: string) =>
    dbType === "mysql" && MYSQL_SYSTEM_DATABASES.has(db.toLowerCase());
  const userDatabases = databases.filter((db) => !isSystem(db));
  const systemDatabases = databases.filter(isSystem);
  const renderDatabase = (db: string, level: number) =>
    dbType === "mysql" ? (
      <MySqlDbNode
        key={db}
        database={db}
        connectionId={connectionId}
        level={level}
      />
    ) : (
      <PgDbNode
        key={db}
        database={db}
        connectionId={connectionId}
        level={level}
      />
    );

  return (
    <>
      <div className="py-0.5">
        {/* Header row: connection-level tools in one menu */}
        <div className="flex items-center justify-between px-2 py-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            数据库
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-sidebar-border hover:text-foreground"
                title="新建数据库、传输、对比、监控与用户管理"
              >
                <Wrench className="size-3" />
                工具
                <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44 text-xs">
              <DropdownMenuItem
                disabled={readonly}
                onSelect={() => setCreateOpen(true)}
              >
                <Plus className="size-3.5" />
                新建数据库…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setTransferOpen(true)}>
                <Send className="size-3.5" />
                跨连接传输…
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openSchemaDiffTab}>
                <GitCompare className="size-3.5" />
                结构对比
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openProcessTab}>
                <Activity className="size-3.5" />
                活跃查询
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openDiskUsageTab}>
                <HardDrive className="size-3.5" />
                磁盘占用
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={openUsersTab}>
                <Users className="size-3.5" />
                用户管理
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Filter: databases by name; inside open databases, objects by name */}
        <div className="relative mx-2 mb-0.5">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-6 w-full rounded border border-sidebar-border bg-transparent pl-5 pr-5 text-xs outline-none placeholder:text-muted-foreground/70 focus:border-primary"
            placeholder="过滤数据库 / 表"
            aria-label="过滤对象"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilterText("");
            }}
          />
          {filterText && (
            <button
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              title="清除过滤"
              onClick={() => setFilterText("")}
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        <TreeFilterContext.Provider value={filter}>
          {userDatabases.map((db) => renderDatabase(db, 1))}
          {systemDatabases.length > 0 && (
            <>
              <TreeRow
                level={1}
                icon={<Settings2 className="size-3" />}
                label={`系统库 (${systemDatabases.length})`}
                expandable
                expanded={systemOpen || !!filter}
                onClick={() => setSystemOpen((v) => !v)}
              />
              {(systemOpen || !!filter) &&
                systemDatabases.map((db) => renderDatabase(db, 2))}
            </>
          )}
        </TreeFilterContext.Provider>
      </div>

      <CreateDatabaseDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        connectionId={connectionId}
        dbType={dbType}
        onSuccess={() =>
          queryClient.invalidateQueries({
            queryKey: ["databases", connectionId],
          })
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

import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Database,
  FolderOpen,
  Plus,
  Search,
  Terminal,
  Table2,
  Pencil,
  Trash2,
  Unplug,
  Wifi,
  Loader2,
  Sun,
  Moon,
  Monitor,
  Keyboard,
  Settings,
  ArrowLeftRight,
} from "lucide-react";
import { useThemeStore, type ThemeMode } from "@/stores/theme-store";
import { PreferencesDialog } from "@/components/layout/preferences-dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ConnectionDialog } from "@/components/connection/connection-dialog";
import { ImportExportConnectionsDialog } from "@/components/connection/import-export-connections-dialog";
import { ObjectTree } from "@/components/explorer/object-tree";
import { ObjectSearchDialog } from "@/components/explorer/object-search-dialog";
import { RecentPanel } from "@/components/layout/recent-panel";
import {
  useConnections,
  useCreateConnection,
  useUpdateConnection,
  useDeleteConnection,
} from "@/hooks/use-connections";
import { useConnectionStore } from "@/stores/connection-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  testConnection,
  openConnection,
  closeConnection,
} from "@/services/tauri-commands";
import type { ConnectionConfig } from "@/types/database";
import { cn } from "@/lib/utils";

const THEME_CYCLE: ThemeMode[] = ["light", "dark", "system"];
const THEME_ICONS: Record<ThemeMode, React.ElementType> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};
const THEME_LABELS: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

interface SidebarProps {
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
}

export function Sidebar({ searchOpen, onSearchOpenChange }: SidebarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const ThemeIcon = THEME_ICONS[themeMode];
  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(themeMode);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    if (next) setThemeMode(next);
  };
  const [editingConn, setEditingConn] = useState<ConnectionConfig | undefined>(
    undefined,
  );
  // Which connections have their tree expanded
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const { data: connections = [], isLoading } = useConnections();
  const createMutation = useCreateConnection();
  const updateMutation = useUpdateConnection();
  const deleteMutation = useDeleteConnection();
  const {
    activeConnectionId,
    openPoolIds,
    setActiveConnection,
    markPoolOpen,
    markPoolClosed,
  } = useConnectionStore();

  const addTab = useWorkspaceStore((s) => s.addTab);

  const handleNewDesigner = (connId?: string) => {
    const id = connId ?? activeConnectionId;
    if (!id || !openPoolIds.has(id)) return;
    const tabId = `designer-${id}-${Date.now()}`;
    addTab({ id: tabId, title: "新建表", type: "designer", connectionId: id });
  };

  const handleNewQuery = (connId?: string) => {
    const id = connId ?? activeConnectionId;
    if (!id || !openPoolIds.has(id)) return;
    const tabId = `query-${id}-${Date.now()}`;
    addTab({
      id: tabId,
      title: "新查询",
      type: "query",
      connectionId: id,
    });
  };


  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleConnect = async (conn: ConnectionConfig) => {
    setActiveConnection(conn.id);
    if (!openPoolIds.has(conn.id)) {
      try {
        await openConnection(conn);
        markPoolOpen(conn.id);
        // Auto-expand tree once connected
        setExpandedIds((prev) => new Set([...prev, conn.id]));
      } catch {
        // Silently ignore — tree will show error state
      }
    }
  };

  const handleDisconnect = async (id: string) => {
    await closeConnection(id);
    markPoolClosed(id);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (activeConnectionId === id) setActiveConnection(null);
  };

  const handleNewConnection = () => {
    setEditingConn(undefined);
    setDialogOpen(true);
  };

  const handleEditConnection = (conn: ConnectionConfig) => {
    setEditingConn(conn);
    setDialogOpen(true);
  };

  const handleSave = (config: ConnectionConfig) => {
    if (editingConn) {
      updateMutation.mutate(config);
    } else {
      createMutation.mutate(config);
    }
  };

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id);
    if (activeConnectionId === id) setActiveConnection(null);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const dbBadge = (dbType: string) => (dbType === "mysql" ? "M" : "P");

  return (
    <div className="flex h-full flex-col bg-sidebar-background text-sidebar-foreground">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-sidebar-border px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleNewConnection}
            >
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">新建连接</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs">
              <FolderOpen className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">新建分组</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleNewQuery()}
              disabled={
                !activeConnectionId || !openPoolIds.has(activeConnectionId)
              }
            >
              <Terminal className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">新建查询</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleNewDesigner()}
              disabled={
                !activeConnectionId || !openPoolIds.has(activeConnectionId)
              }
            >
              <Table2 className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">新建表</TooltipContent>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => onSearchOpenChange(true)}
            >
              <Search className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">搜索对象 (⌘K)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setImportExportOpen(true)}
            >
              <ArrowLeftRight className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">导入/导出连接配置</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={cycleTheme}>
              <ThemeIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            当前：{THEME_LABELS[themeMode]}（点击切换）
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                /* dispatched via global shortcut — trigger via key event */
                window.dispatchEvent(
                  new KeyboardEvent("keydown", { key: "?", bubbles: true }),
                );
              }}
            >
              <Keyboard className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">快捷键帮助 (?)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => setPrefsOpen(true)}>
              <Settings className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">偏好设置</TooltipContent>
        </Tooltip>
      </div>

      {/* Tree */}
      <ScrollArea className="flex-1">
        <div className="p-1">
          <RecentPanel />
          {isLoading && (
            <div className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              <span>加载中...</span>
            </div>
          )}

          {!isLoading && connections.length === 0 && (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground">
              <Database className="size-4" />
              <span>暂无连接，点击 + 新建</span>
            </div>
          )}

          {connections.map((conn) => {
            const isOpen = openPoolIds.has(conn.id);
            const isActive = activeConnectionId === conn.id;
            const isExpanded = expandedIds.has(conn.id);

            return (
              <div key={conn.id}>
                {/* Connection row */}
                <div
                  className={cn(
                    "group flex items-center gap-1.5 rounded-md px-1 py-1 text-sm cursor-pointer",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "hover:bg-sidebar-accent/50",
                  )}
                  onClick={() => {
                    setActiveConnection(conn.id);
                    if (isOpen) {
                      toggleExpand(conn.id);
                    } else {
                      handleConnect(conn);
                    }
                  }}
                >
                  {/* Expand chevron */}
                  <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                    {isOpen ? (
                      isExpanded ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )
                    ) : null}
                  </span>

                  {/* DB type badge */}
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white",
                      conn.dbType === "mysql" ? "bg-blue-600" : "bg-sky-700",
                      isOpen && "ring-2 ring-green-400",
                    )}
                  >
                    {dbBadge(conn.dbType)}
                  </span>

                  <span className="min-w-0 flex-1 truncate text-sm">
                    {conn.name}
                  </span>

                  {/* Action buttons — visible on hover */}
                  <div className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100">
                    {isOpen ? (
                      <>
                        <button
                          className="rounded p-0.5 hover:bg-sidebar-border"
                          title="新建查询"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNewQuery(conn.id);
                          }}
                        >
                          <Terminal className="size-3" />
                        </button>
                        <button
                          className="rounded p-0.5 hover:bg-sidebar-border"
                          title="断开连接"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDisconnect(conn.id);
                          }}
                        >
                          <Unplug className="size-3" />
                        </button>
                      </>
                    ) : (
                      <button
                        className="rounded p-0.5 hover:bg-sidebar-border"
                        title="连接"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleConnect(conn);
                        }}
                      >
                        <Wifi className="size-3" />
                      </button>
                    )}
                    <button
                      className="rounded p-0.5 hover:bg-sidebar-border"
                      title="编辑"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditConnection(conn);
                      }}
                    >
                      <Pencil className="size-3" />
                    </button>
                    <button
                      className="rounded p-0.5 hover:bg-destructive/20 hover:text-destructive"
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(conn.id);
                      }}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>

                {/* Object tree — shown when connected + expanded */}
                {isOpen && isExpanded && (
                  <ObjectTree
                    connectionId={conn.id}
                    dbType={conn.dbType}
                  />
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Object Search Dialog */}
      <ObjectSearchDialog
        open={searchOpen}
        onOpenChange={onSearchOpenChange}
        connectionId={
          // Prefer the active connected pool; fall back to first open pool
          activeConnectionId && openPoolIds.has(activeConnectionId)
            ? activeConnectionId
            : (openPoolIds.values().next().value ?? null)
        }
      />

      {/* Connection Dialog */}
      <ConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editingConn}
        onSave={handleSave}
        onTest={testConnection}
      />

      {/* Preferences Dialog */}
      <PreferencesDialog open={prefsOpen} onOpenChange={setPrefsOpen} />

      {/* Import/Export Connections Dialog */}
      <ImportExportConnectionsDialog
        open={importExportOpen}
        onOpenChange={setImportExportOpen}
      />
    </div>
  );
}

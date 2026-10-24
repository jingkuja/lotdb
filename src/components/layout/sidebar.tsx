import { pendingWorkspaceMessages } from "@/lib/workspace-guards";
import { useState, useEffect } from "react";
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
  Lock,
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  useConnectionGroups,
  useCreateGroup,
  useRenameGroup,
  useDeleteGroup,
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
import {
  alertDialog,
  confirmDialog,
  promptDialog,
} from "@/stores/app-dialog-store";
import { formatDbError } from "@/lib/error";

const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];
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
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const [editingConn, setEditingConn] = useState<ConnectionConfig | undefined>(
    undefined,
  );
  // Which connections have their tree expanded
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Which connection groups are expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const {
    data: connections = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useConnections();
  const createMutation = useCreateConnection();
  const updateMutation = useUpdateConnection();
  const deleteMutation = useDeleteConnection();
  const { data: groups = [] } = useConnectionGroups();
  const createGroupMutation = useCreateGroup();
  const renameGroupMutation = useRenameGroup();
  const deleteGroupMutation = useDeleteGroup();
  const {
    activeConnectionId,
    openPoolIds,
    setActiveConnection,
    markPoolOpen,
    markPoolClosed,
  } = useConnectionStore();

  const addTab = useWorkspaceStore((s) => s.addTab);
  const activeOpen =
    !!activeConnectionId && openPoolIds.has(activeConnectionId);

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

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleNewGroup = async () => {
    const name = await promptDialog("输入分组名称：", "", {
      title: "新建分组",
    });
    if (!name?.trim()) return;
    try {
      await createGroupMutation.mutateAsync(name.trim());
    } catch (e) {
      await alertDialog(formatDbError(e), { title: "新建分组失败" });
    }
  };

  const handleRenameGroup = async (id: string, current: string) => {
    const name = await promptDialog("输入新的分组名称：", current, {
      title: "重命名分组",
    });
    if (!name?.trim() || name.trim() === current) return;
    try {
      await renameGroupMutation.mutateAsync({ id, name: name.trim() });
    } catch (e) {
      await alertDialog(formatDbError(e), { title: "重命名分组失败" });
    }
  };

  const handleDeleteGroup = async (id: string, name: string) => {
    if (
      !(await confirmDialog(`删除分组 "${name}"？组内连接将变为未分组。`, {
        title: "删除分组",
        confirmLabel: "删除",
        destructive: true,
      }))
    )
      return;
    try {
      await deleteGroupMutation.mutateAsync(id);
    } catch (e) {
      await alertDialog(formatDbError(e), { title: "删除分组失败" });
    }
  };

  const handleConnect = async (conn: ConnectionConfig) => {
    setActiveConnection(conn.id);
    if (!openPoolIds.has(conn.id)) {
      try {
        setConnectionError(null);
        await openConnection(conn);
        markPoolOpen(conn.id);
        // Auto-expand tree once connected
        setExpandedIds((prev) => new Set([...prev, conn.id]));
      } catch (error) {
        setConnectionError(`${conn.name}：${formatDbError(error)}`);
      }
    }
  };

  const handleDisconnect = async (id: string) => {
    const messages = useWorkspaceStore
      .getState()
      .tabs.filter((tab) => tab.connectionId === id)
      .flatMap((tab) => pendingWorkspaceMessages(tab.id));
    if (
      messages.length &&
      !(await confirmDialog(
        messages.join("\n") + "\n仍要断开连接？未提交事务将回滚。",
        { title: "断开连接", confirmLabel: "断开" },
      ))
    )
      return;
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

  useEffect(() => {
    const create = () => {
      setEditingConn(undefined);
      setDialogOpen(true);
    };
    window.addEventListener("lotdb:new-connection", create);
    return () => window.removeEventListener("lotdb:new-connection", create);
  }, []);

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

  const handleDelete = async (conn: ConnectionConfig) => {
    const { id } = conn;
    const confirmed = await confirmDialog(
      `删除连接 "${conn.name}"？保存在钥匙串中的密码也会一并删除，此操作不可撤销。`,
      { title: "删除连接", confirmLabel: "删除", destructive: true },
    );
    if (!confirmed) return;
    if (openPoolIds.has(id)) {
      await closeConnection(id).catch(() => {});
      markPoolClosed(id);
    }
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
      {/* Toolbar: create on the left; search and app settings on the right */}
      <div className="flex items-center gap-1 border-b border-sidebar-border px-2 py-1.5">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="新建连接或分组"
                >
                  <Plus className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">新建连接 / 分组</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="text-xs">
            <DropdownMenuItem onSelect={handleNewConnection}>
              <Database className="size-3.5" />
              新建连接…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleNewGroup()}>
              <FolderOpen className="size-3.5" />
              新建分组…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setImportExportOpen(true)}>
              <ArrowLeftRight className="size-3.5" />
              导入 / 导出连接配置…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="新建查询"
              onClick={() => handleNewQuery()}
              disabled={!activeOpen}
            >
              <Terminal className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {activeOpen ? "新建查询 (⌘N)" : "新建查询（先连接数据库）"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="新建表"
              onClick={() => handleNewDesigner()}
              disabled={!activeOpen}
            >
              <Table2 className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {activeOpen ? "新建表" : "新建表（先连接数据库）"}
          </TooltipContent>
        </Tooltip>
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="搜索对象"
              onClick={() => onSearchOpenChange(true)}
            >
              <Search className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">搜索对象 (⌘K)</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="设置">
                  <Settings className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">设置</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-44 text-xs">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              外观
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={themeMode}
              onValueChange={(mode) => setThemeMode(mode as ThemeMode)}
            >
              {THEME_MODES.map((mode) => {
                const Icon = THEME_ICONS[mode];
                return (
                  <DropdownMenuRadioItem key={mode} value={mode}>
                    <Icon className="size-3.5" />
                    {THEME_LABELS[mode]}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                window.dispatchEvent(
                  new KeyboardEvent("keydown", { key: "?", bubbles: true }),
                )
              }
            >
              <Keyboard className="size-3.5" />
              快捷键
              <DropdownMenuShortcut>?</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPrefsOpen(true)}>
              <Settings className="size-3.5" />
              偏好设置…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Tree */}
      <ScrollArea className="flex-1">
        <div className="p-1">
          {connectionError && (
            <p
              role="alert"
              className="break-words rounded bg-destructive/10 p-2 text-xs text-destructive"
            >
              {connectionError}
            </p>
          )}
          <RecentPanel />
          {isLoading && (
            <div className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              <span>加载中...</span>
            </div>
          )}

          {isError && !isLoading && (
            <div className="flex flex-col gap-1.5 px-2 py-3 text-xs text-destructive">
              <span>加载连接失败：{formatDbError(error)}</span>
              <button
                type="button"
                className="self-start text-foreground underline-offset-2 hover:underline"
                onClick={() => void refetch()}
              >
                重试
              </button>
            </div>
          )}

          {!isLoading && !isError && connections.length === 0 && (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground">
              <Database className="size-4" />
              <span>暂无连接，点击左上角 + 新建</span>
            </div>
          )}

          {(() => {
            const renderConnection = (conn: ConnectionConfig) => {
              const isOpen = openPoolIds.has(conn.id);
              const isActive = activeConnectionId === conn.id;
              const isExpanded = expandedIds.has(conn.id);

              return (
                <div key={conn.id}>
                  {/* Connection row — actions in the context menu */}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
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
                            conn.dbType === "mysql"
                              ? "bg-blue-600"
                              : "bg-sky-700",
                            isOpen && "ring-2 ring-green-400",
                          )}
                        >
                          {dbBadge(conn.dbType)}
                        </span>

                        <span className="min-w-0 flex-1 truncate text-sm">
                          {conn.name}
                        </span>
                        {conn.readonly && (
                          <Lock
                            className="size-3 shrink-0 text-amber-500"
                            aria-label="只读模式"
                          />
                        )}
                        <ContextMenuButton
                          label={`${conn.name} 的操作`}
                          className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        />
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuLabel>{conn.name}</ContextMenuLabel>
                      {isOpen ? (
                        <>
                          <ContextMenuItem
                            onSelect={() => handleNewQuery(conn.id)}
                          >
                            <Terminal />
                            新建查询
                          </ContextMenuItem>
                          <ContextMenuItem
                            disabled={conn.readonly}
                            onSelect={() => handleNewDesigner(conn.id)}
                          >
                            <Table2 />
                            新建表
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={() => void handleDisconnect(conn.id)}
                          >
                            <Unplug />
                            断开连接
                          </ContextMenuItem>
                        </>
                      ) : (
                        <ContextMenuItem
                          onSelect={() => void handleConnect(conn)}
                        >
                          <Wifi />
                          连接
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() => handleEditConnection(conn)}
                      >
                        <Pencil />
                        编辑连接…
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onSelect={() => void handleDelete(conn)}
                      >
                        <Trash2 />
                        删除连接…
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>

                  {/* Object tree — shown when connected + expanded */}
                  {isOpen && isExpanded && (
                    <ObjectTree connectionId={conn.id} dbType={conn.dbType} />
                  )}
                </div>
              );
            };

            const ungrouped = connections.filter((c) => !c.groupId);
            return (
              <>
                {ungrouped.map((conn) => renderConnection(conn))}
                {groups.map((g) => {
                  const groupConns = connections.filter(
                    (c) => c.groupId === g.id,
                  );
                  const gExpanded = expandedGroups.has(g.id);
                  return (
                    <div key={g.id}>
                      {/* Group folder row */}
                      <ContextMenu>
                        <ContextMenuTrigger asChild>
                          <div
                            className="group flex items-center gap-1.5 rounded-md px-1 py-1 text-sm cursor-pointer hover:bg-sidebar-accent/50"
                            onClick={() => toggleGroup(g.id)}
                          >
                            <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                              {groupConns.length > 0 ? (
                                gExpanded ? (
                                  <ChevronDown className="size-3.5" />
                                ) : (
                                  <ChevronRight className="size-3.5" />
                                )
                              ) : null}
                            </span>
                            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate font-medium">
                              {g.name}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {groupConns.length}
                            </span>
                            <ContextMenuButton
                              label={`分组 ${g.name} 的操作`}
                              className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            />
                          </div>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuLabel>{g.name}</ContextMenuLabel>
                          <ContextMenuItem
                            onSelect={() =>
                              void handleRenameGroup(g.id, g.name)
                            }
                          >
                            <Pencil />
                            重命名分组…
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            variant="destructive"
                            onSelect={() =>
                              void handleDeleteGroup(g.id, g.name)
                            }
                          >
                            <Trash2 />
                            删除分组…
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                      {gExpanded &&
                        groupConns.map((conn) => renderConnection(conn))}
                    </div>
                  );
                })}
              </>
            );
          })()}
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

      {/* Connection Dialog — keyed by edit target so form state resets */}
      <ConnectionDialog
        key={editingConn?.id ?? "new"}
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

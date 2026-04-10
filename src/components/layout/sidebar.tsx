import { useState, useEffect } from "react";
import {
  ChevronRight,
  ChevronDown,
  Database,
  FolderOpen,
  Plus,
  Search,
  Terminal,
  Pencil,
  Trash2,
  Unplug,
  Wifi,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ConnectionDialog } from "@/components/connection/connection-dialog";
import { ObjectTree } from "@/components/explorer/object-tree";
import { ObjectSearchDialog } from "@/components/explorer/object-search-dialog";
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

export function Sidebar() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
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

  // Cmd+K / Ctrl+K opens search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setSearchOpen(true)}
            >
              <Search className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">搜索对象 (⌘K)</TooltipContent>
        </Tooltip>
      </div>

      {/* Tree */}
      <ScrollArea className="flex-1">
        <div className="p-1">
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
        onOpenChange={setSearchOpen}
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
    </div>
  );
}

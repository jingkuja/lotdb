import { create } from "zustand";
import { persist } from "zustand/middleware";
import { pendingWorkspaceMessages } from "@/lib/workspace-guards";
import { confirmDialog } from "./app-dialog-store";
import { useEditorStore } from "./editor-store";

export interface Tab {
  id: string;
  title: string;
  type:
    | "query"
    | "table-data"
    | "table-structure"
    | "designer"
    | "users"
    | "process-list"
    | "disk-usage"
    | "schema-diff"
    | "object-ddl"
    | "object-manager";
  connectionId: string;
  metadata?: Record<string, unknown>;
}

/** A query tab closed with a draft in it; ⌘⇧T or the tab bar reopens it. */
export interface ClosedQuery {
  tab: Tab;
  sql: string;
  closedAt: number;
}

const MAX_CLOSED_QUERIES = 20;

interface WorkspaceState {
  dirtyIds: Record<string, boolean>;
  setDirty: (id: string, dirty: boolean) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  tabs: Tab[];
  activeTabId: string | null;
  sidebarWidth: number;
  /** Opens the tab, or switches to it when one with this id is open. */
  addTab: (tab: Tab) => void;
  /** Resolves false when the user keeps the tab open. */
  removeTab: (id: string) => Promise<boolean>;
  closedQueries: ClosedQuery[];
  /** Reopens a closed query (the most recent one by default). */
  reopenClosedQuery: (closedAt?: number) => void;
  clearClosedQueries: () => void;
  setActiveTab: (id: string) => void;
  setSidebarWidth: (width: number) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      dirtyIds: {},
      setDirty: (id, dirty) =>
        set((s) => {
          if (!!s.dirtyIds[id] === dirty) return s;
          const dirtyIds = { ...s.dirtyIds };
          if (dirty) dirtyIds[id] = true;
          else delete dirtyIds[id];
          return { dirtyIds };
        }),
      updateTab: (id, patch) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        })),
      tabs: [],
      activeTabId: null,
      sidebarWidth: 260,
      addTab: (tab) =>
        set((state) =>
          state.tabs.some((t) => t.id === tab.id)
            ? { activeTabId: tab.id }
            : { tabs: [...state.tabs, tab], activeTabId: tab.id },
        ),
      removeTab: async (id) => {
        // Only work that would be lost asks first; a query draft is kept in
        // closedQueries instead.
        const messages = pendingWorkspaceMessages(id);
        if (
          messages.length &&
          !(await confirmDialog(messages.join("\n") + "\n仍要关闭？", {
            title: "关闭标签页",
            confirmLabel: "关闭",
          }))
        )
          return false;
        const tab = get().tabs.find((t) => t.id === id);
        const sql = useEditorStore.getState().getContent(id);
        useEditorStore.getState().removeContent(id);
        set((state) => {
          const tabs = state.tabs.filter((t) => t.id !== id);
          return {
            tabs,
            closedQueries:
              tab?.type === "query" && sql.trim()
                ? [
                    { tab, sql, closedAt: Date.now() },
                    ...state.closedQueries,
                  ].slice(0, MAX_CLOSED_QUERIES)
                : state.closedQueries,
            activeTabId:
              state.activeTabId === id
                ? (tabs[tabs.length - 1]?.id ?? null)
                : state.activeTabId,
          };
        });
        return true;
      },
      closedQueries: [],
      reopenClosedQuery: (closedAt) => {
        const { closedQueries, tabs } = get();
        const entry =
          closedAt === undefined
            ? closedQueries[0]
            : closedQueries.find((q) => q.closedAt === closedAt);
        if (!entry) return;
        const id = tabs.some((t) => t.id === entry.tab.id)
          ? `${entry.tab.id}-${Date.now()}`
          : entry.tab.id;
        useEditorStore.getState().setContent(id, entry.sql);
        set((state) => ({
          tabs: [...state.tabs, { ...entry.tab, id }],
          activeTabId: id,
          closedQueries: state.closedQueries.filter((q) => q !== entry),
        }));
      },
      clearClosedQueries: () => set({ closedQueries: [] }),
      setActiveTab: (id) => set({ activeTabId: id }),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
    }),
    {
      name: "lotdb-workspace",
      partialize: (s) => ({
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        sidebarWidth: s.sidebarWidth,
        closedQueries: s.closedQueries,
      }),
    },
  ),
);

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { pendingWorkspaceMessages } from "@/lib/workspace-guards";
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

interface WorkspaceState {
  dirtyIds: Record<string, boolean>;
  setDirty: (id: string, dirty: boolean) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  tabs: Tab[];
  activeTabId: string | null;
  sidebarWidth: number;
  addTab: (tab: Tab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setSidebarWidth: (width: number) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()(persist((set, get) => ({
  dirtyIds: {},
  setDirty: (id, dirty) => set((s) => {
    if (!!s.dirtyIds[id] === dirty) return s;
    const dirtyIds = { ...s.dirtyIds };
    if (dirty) dirtyIds[id] = true; else delete dirtyIds[id];
    return { dirtyIds };
  }),
  updateTab: (id, patch) => set((s) => ({ tabs: s.tabs.map(t => t.id === id ? {...t, ...patch} : t) })),
  tabs: [],
  activeTabId: null,
  sidebarWidth: 260,
  addTab: (tab) =>
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    })),
  removeTab: (id) => {
    const messages = pendingWorkspaceMessages(id);
    const tab = get().tabs.find(t => t.id === id);
    if (tab?.type === "query" && useEditorStore.getState().getContent(id).trim())
      messages.push("关闭将删除此查询草稿。保留标签页可在下次启动时恢复。");
    if (messages.length && !window.confirm(messages.join("\n") + "\n仍要关闭？")) return;
    useEditorStore.getState().removeContent(id);
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id);
      return {
        tabs,
        activeTabId:
          state.activeTabId === id
            ? (tabs[tabs.length - 1]?.id ?? null)
            : state.activeTabId,
      };
    });
  },
  setActiveTab: (id) => set({ activeTabId: id }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
}), { name: "lotdb-workspace", partialize: (s) => ({ tabs: s.tabs, activeTabId: s.activeTabId, sidebarWidth: s.sidebarWidth }) }));

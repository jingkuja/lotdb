import { create } from "zustand";

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
  tabs: Tab[];
  activeTabId: string | null;
  sidebarWidth: number;
  addTab: (tab: Tab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setSidebarWidth: (width: number) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  tabs: [],
  activeTabId: null,
  sidebarWidth: 260,
  addTab: (tab) =>
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    })),
  removeTab: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id);
      return {
        tabs,
        activeTabId:
          state.activeTabId === id
            ? (tabs[tabs.length - 1]?.id ?? null)
            : state.activeTabId,
      };
    }),
  setActiveTab: (id) => set({ activeTabId: id }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
}));

import { create } from "zustand";
import type { Tab } from "./workspace-store";

const STORAGE_KEY = "lotdb-recent";
const MAX_ITEMS = 20;

export interface RecentItem {
  /** Stable key — used for deduplication. */
  key: string;
  type: Tab["type"];
  title: string;
  connectionId: string;
  metadata?: Record<string, unknown>;
  openedAt: number;
}

function stableKey(tab: Tab): string {
  const meta = tab.metadata as Record<string, unknown> | undefined;
  const db = meta?.database ?? "";
  const obj = meta?.objectName ?? "";
  return `${tab.type}::${tab.connectionId}::${db}::${meta?.schema ?? ""}::${obj}::${meta?.managerKind ?? ""}::${meta?.ddlKind ?? ""}::${meta?.table ?? ""}`;
}

function load(): RecentItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RecentItem[]) : [];
  } catch {
    return [];
  }
}

function save(items: RecentItem[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

interface RecentState {
  items: RecentItem[];
  addRecent: (tab: Tab) => void;
  removeRecent: (key: string) => void;
  clearRecent: () => void;
}

export const useRecentStore = create<RecentState>((set) => ({
  items: load(),

  addRecent: (tab) => {
    // Don't track anonymous/unnamed items
    if (!tab.title || tab.title === "新查询") return;

    const key = stableKey(tab);
    const item: RecentItem = {
      key,
      type: tab.type,
      title: tab.title,
      connectionId: tab.connectionId,
      metadata: tab.metadata,
      openedAt: Date.now(),
    };

    set((state) => {
      // Remove existing duplicate
      const filtered = state.items.filter((i) => i.key !== key);
      // Prepend, cap at MAX_ITEMS
      const next = [item, ...filtered].slice(0, MAX_ITEMS);
      save(next);
      return { items: next };
    });
  },

  removeRecent: (key) =>
    set((state) => {
      const next = state.items.filter((i) => i.key !== key);
      save(next);
      return { items: next };
    }),

  clearRecent: () => {
    save([]);
    set({ items: [] });
  },
}));

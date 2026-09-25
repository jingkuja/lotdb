import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

const pendingWrites = new Map<string, string>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function flushDrafts() {
  if (saveTimer) clearTimeout(saveTimer);
  for (const [key, value] of pendingWrites) {
    localStorage.setItem(key, value);
    pendingWrites.delete(key);
  }
}
if (typeof window !== "undefined")
  window.addEventListener("pagehide", flushDrafts);

interface EditorStore {
  /** tabId → SQL content */
  contents: Record<string, string>;
  setContent: (tabId: string, content: string) => void;
  getContent: (tabId: string) => string;
  removeContent: (tabId: string) => void;
}

export const useEditorStore = create<EditorStore>()(
  persist(
    (set, get) => ({
      contents: {},
      setContent: (tabId, content) =>
        set((s) => ({ contents: { ...s.contents, [tabId]: content } })),
      getContent: (tabId) => get().contents[tabId] ?? "",
      removeContent: (tabId) =>
        set((s) => {
          const next = { ...s.contents };
          delete next[tabId];
          return { contents: next };
        }),
    }),
    {
      name: "lotdb-editor-drafts",
      storage: createJSONStorage(() => ({
        getItem: (key) =>
          typeof localStorage === "undefined"
            ? null
            : localStorage.getItem(key),
        setItem: (key, value) => {
          pendingWrites.set(key, value);
          if (saveTimer) clearTimeout(saveTimer);
          saveTimer = setTimeout(flushDrafts, 250);
        },
        removeItem: (key) => {
          pendingWrites.delete(key);
          localStorage.removeItem(key);
        },
      })),
    },
  ),
);

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface EditorStore {
  /** tabId → SQL content */
  contents: Record<string, string>;
  setContent: (tabId: string, content: string) => void;
  getContent: (tabId: string) => string;
  removeContent: (tabId: string) => void;
}

export const useEditorStore = create<EditorStore>()(persist((set, get) => ({
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
}), { name: "lotdb-editor-drafts" }));

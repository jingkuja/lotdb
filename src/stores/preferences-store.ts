import { create } from "zustand";

const STORAGE_KEY = "lotdb-preferences";

export type EditorFontFamily =
  | "JetBrains Mono"
  | "Fira Code"
  | "Cascadia Code"
  | "Menlo"
  | "Monaco"
  | "monospace";

export interface Preferences {
  editorFontFamily: EditorFontFamily;
  editorFontSize: number;      // 11–20
  gridFontSize: number;        // 11–16
  pageSize: 50 | 100 | 200 | 500;
  saveQueryHistory: boolean;
  confirmDml: boolean;         // require confirmation before DML
  queryMaxRows: number;        // SQL 查询结果行数上限；0 = 不限制
}

const DEFAULTS: Preferences = {
  editorFontFamily: "JetBrains Mono",
  editorFontSize: 13,
  gridFontSize: 12,
  pageSize: 200,
  saveQueryHistory: true,
  confirmDml: false,
  queryMaxRows: 1000,
};

function load(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: Preferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

interface PreferencesState {
  prefs: Preferences;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  reset: () => void;
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  prefs: load(),

  setPref: (key, value) =>
    set((state) => {
      const next = { ...state.prefs, [key]: value };
      save(next);
      return { prefs: next };
    }),

  reset: () => {
    save(DEFAULTS);
    set({ prefs: DEFAULTS });
  },
}));

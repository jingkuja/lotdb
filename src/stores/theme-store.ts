import { create } from "zustand";

export type ThemeMode = "light" | "dark" | "system";

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const STORAGE_KEY = "lotdb-theme";

function loadMode(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

export const useThemeStore = create<ThemeState>((set) => ({
  mode: loadMode(),
  setMode: (mode) => {
    localStorage.setItem(STORAGE_KEY, mode);
    set({ mode });
  },
}));

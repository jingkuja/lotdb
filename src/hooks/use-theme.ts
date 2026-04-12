import { useEffect } from "react";
import { useThemeStore } from "@/stores/theme-store";

function applyTheme(mode: "light" | "dark" | "system") {
  const root = document.documentElement;
  if (mode === "dark") {
    root.classList.add("dark");
  } else if (mode === "light") {
    root.classList.remove("dark");
  } else {
    // system
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", prefersDark);
  }
}

/**
 * Call once at the top of the component tree.
 * Applies the saved theme and listens for system preference changes.
 */
export function useTheme() {
  const mode = useThemeStore((s) => s.mode);

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  // Listen to OS color-scheme changes when mode === "system"
  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);
}

import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useConnectionStore } from "@/stores/connection-store";

interface Options {
  onShowShortcuts: () => void;
  onShowSearch: () => void;
}

/**
 * Registers global keyboard shortcuts that operate on the workspace level.
 * Call once at the top of the component tree.
 */
export function useGlobalShortcuts({ onShowShortcuts, onShowSearch }: Options) {
  const { tabs, activeTabId, removeTab, setActiveTab, addTab } =
    useWorkspaceStore();
  const { activeConnectionId, openPoolIds } = useConnectionStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Skip if user is typing inside an input/textarea/contenteditable
      // (but allow CodeMirror — its events are caught by the editor itself)
      const target = e.target as HTMLElement;
      const inInput =
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable) &&
        !target.closest(".cm-editor");

      // ── Cmd+N — new query ────────────────────────────────────────
      if (mod && !e.shiftKey && !e.altKey && e.key === "n") {
        e.preventDefault();
        const id =
          activeConnectionId && openPoolIds.has(activeConnectionId)
            ? activeConnectionId
            : (openPoolIds.values().next().value as string | undefined);
        if (id) {
          const tabId = `query-${id}-${Date.now()}`;
          addTab({ id: tabId, title: "新查询", type: "query", connectionId: id });
        }
        return;
      }

      // ── Cmd+W — close active tab ─────────────────────────────────
      if (mod && !e.shiftKey && !e.altKey && e.key === "w") {
        e.preventDefault();
        if (activeTabId) removeTab(activeTabId);
        return;
      }

      // ── Cmd+Shift+[ — previous tab ───────────────────────────────
      if (mod && e.shiftKey && e.key === "[") {
        e.preventDefault();
        if (tabs.length === 0) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
        if (prev) setActiveTab(prev.id);
        return;
      }

      // ── Cmd+Shift+] — next tab ───────────────────────────────────
      if (mod && e.shiftKey && e.key === "]") {
        e.preventDefault();
        if (tabs.length === 0) return;
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        const next = tabs[(idx + 1) % tabs.length];
        if (next) setActiveTab(next.id);
        return;
      }

      // ── Cmd+K — object search ────────────────────────────────────
      if (mod && !e.shiftKey && !e.altKey && e.key === "k") {
        e.preventDefault();
        onShowSearch();
        return;
      }

      // ── ? — shortcuts help (only when not in input) ───────────────
      if (!mod && !e.shiftKey && !e.altKey && e.key === "?" && !inInput) {
        onShowShortcuts();
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    tabs,
    activeTabId,
    activeConnectionId,
    openPoolIds,
    removeTab,
    setActiveTab,
    addTab,
    onShowShortcuts,
    onShowSearch,
  ]);
}

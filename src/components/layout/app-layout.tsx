import { flushDrafts } from "@/stores/editor-store";
import { pendingWorkspaceMessages } from "@/lib/workspace-guards";
import { useState, useCallback, useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { Sidebar } from "./sidebar";
import { TabBar } from "./tab-bar";
import { MainContent } from "./main-content";
import { ResizeHandle } from "./resize-handle";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";

export function AppLayout() {
  const { sidebarWidth } = useWorkspaceStore();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const onShowShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const onShowSearch = useCallback(() => setSearchOpen(true), []);

  useGlobalShortcuts({ onShowShortcuts, onShowSearch });
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingWorkspaceMessages().length) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if ("__TAURI_INTERNALS__" in window) {
      void import("@tauri-apps/api/window").then(
        async ({ getCurrentWindow }) => {
          const stop = await getCurrentWindow().onCloseRequested(
            async (event) => {
              flushDrafts();
              const messages = pendingWorkspaceMessages();
              if (messages.length) {
                event.preventDefault();
                if (
                  window.confirm(
                    messages.join("\n") + "\n退出将丢弃未提交变更，确定退出？",
                  )
                )
                  await getCurrentWindow().destroy();
              }
            },
          );
          if (disposed) stop();
          else unlisten = stop;
        },
      );
    }
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Sidebar */}
      <div
        className="shrink-0 border-r border-border"
        style={{ width: sidebarWidth }}
      >
        <Sidebar searchOpen={searchOpen} onSearchOpenChange={setSearchOpen} />
      </div>

      {/* Resize Handle */}
      <ResizeHandle />

      {/* Main Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar />
        <MainContent />
      </div>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

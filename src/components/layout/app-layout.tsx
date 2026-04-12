import { useState, useCallback } from "react";
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

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Sidebar */}
      <div className="shrink-0 border-r border-border" style={{ width: sidebarWidth }}>
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

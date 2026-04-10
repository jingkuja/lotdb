import { useWorkspaceStore } from "@/stores/workspace-store";
import { Sidebar } from "./sidebar";
import { TabBar } from "./tab-bar";
import { MainContent } from "./main-content";
import { ResizeHandle } from "./resize-handle";

export function AppLayout() {
  const { sidebarWidth } = useWorkspaceStore();

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Sidebar */}
      <div className="shrink-0 border-r border-border" style={{ width: sidebarWidth }}>
        <Sidebar />
      </div>

      {/* Resize Handle */}
      <ResizeHandle />

      {/* Main Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar />
        <MainContent />
      </div>
    </div>
  );
}

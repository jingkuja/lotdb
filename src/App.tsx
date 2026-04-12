import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/layout/app-layout";
import { TaskStatusBar } from "@/components/transfer/task-status-bar";
import { useTheme } from "@/hooks/use-theme";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useRecentStore } from "@/stores/recent-store";

const queryClient = new QueryClient();

function ThemeProvider({ children }: { children: React.ReactNode }) {
  useTheme();
  return <>{children}</>;
}

/** Auto-records newly opened tabs into the recent store. */
function RecentTracker() {
  const addRecent = useRecentStore((s) => s.addRecent);
  useEffect(() => {
    let prevLen = useWorkspaceStore.getState().tabs.length;
    const unsub = useWorkspaceStore.subscribe((state) => {
      if (state.tabs.length > prevLen) {
        const newest = state.tabs[state.tabs.length - 1];
        if (newest) addRecent(newest);
      }
      prevLen = state.tabs.length;
    });
    return unsub;
  }, [addRecent]);
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <RecentTracker />
          <AppLayout />
          <TaskStatusBar />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;

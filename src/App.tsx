import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/layout/app-layout";
import { TaskStatusBar } from "@/components/transfer/task-status-bar";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppLayout />
        <TaskStatusBar />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

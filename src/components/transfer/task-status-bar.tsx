import { useState } from "react";
import { Loader2, CheckCircle2, XCircle, ChevronUp, ChevronDown, X } from "lucide-react";
import { useTaskStore, type BgTask } from "@/stores/task-store";

// ─── Single task row ──────────────────────────────────────────────

function TaskRow({ task }: { task: BgTask }) {
  const removeTask = useTaskStore((s) => s.removeTask);

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      {/* Status icon */}
      <span className="shrink-0">
        {task.status === "running" ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : task.status === "done" ? (
          <CheckCircle2 className="size-3.5 text-green-500" />
        ) : (
          <XCircle className="size-3.5 text-destructive" />
        )}
      </span>

      {/* Description + progress */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium">{task.description}</p>
        {task.status === "running" && (
          <div className="mt-0.5 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              {task.progress !== null ? (
                <div
                  className="h-full rounded-full bg-primary transition-all duration-200"
                  style={{ width: `${task.progress}%` }}
                />
              ) : (
                <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] rounded-full bg-primary/60" />
              )}
            </div>
            {task.rowsPerSec > 0 && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {task.rowsPerSec >= 1000
                  ? `${(task.rowsPerSec / 1000).toFixed(1)}k/s`
                  : `${Math.round(task.rowsPerSec)}/s`}
              </span>
            )}
          </div>
        )}
        {task.status === "done" && (
          <p className="text-[10px] text-muted-foreground">{task.rowsDone.toLocaleString()} 行</p>
        )}
        {task.status === "error" && task.errorMessage && (
          <p className="truncate text-[10px] text-destructive">{task.errorMessage}</p>
        )}
      </div>

      {/* Close (only when done/error) */}
      {task.status !== "running" && (
        <button
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => removeTask(task.id)}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

// ─── TaskStatusBar — floating bottom-right ────────────────────────

export function TaskStatusBar() {
  const tasks = useTaskStore((s) => s.tasks);
  const clearDone = useTaskStore((s) => s.clearDone);
  const [collapsed, setCollapsed] = useState(false);

  if (tasks.length === 0) return null;

  const runningCount = tasks.filter((t) => t.status === "running").length;
  const doneCount = tasks.filter((t) => t.status !== "running").length;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 overflow-hidden rounded-lg border border-border bg-background shadow-lg">
      {/* Header */}
      <div
        className="flex cursor-pointer items-center justify-between border-b border-border px-3 py-2"
        onClick={() => setCollapsed((v) => !v)}
      >
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {runningCount > 0 && (
            <Loader2 className="size-3 animate-spin text-primary" />
          )}
          <span>
            {runningCount > 0
              ? `${runningCount} 个任务运行中`
              : `${tasks.length} 个任务`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {doneCount > 0 && !collapsed && (
            <button
              className="text-[10px] text-muted-foreground hover:text-foreground"
              onClick={(e) => { e.stopPropagation(); clearDone(); }}
            >
              清除已完成
            </button>
          )}
          {collapsed ? (
            <ChevronUp className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Task list */}
      {!collapsed && (
        <div className="max-h-60 divide-y divide-border/50 overflow-auto">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

import { create } from "zustand";

export type TaskKind = "import" | "export" | "transfer";
export type TaskStatus = "running" | "done" | "error";

export interface BgTask {
  id: string;
  kind: TaskKind;
  description: string;   // e.g. "导入 users"
  status: TaskStatus;
  progress: number | null;  // 0–100, null = indeterminate
  rowsDone: number;
  rowsPerSec: number;
  errorMessage: string | null;
}

interface TaskState {
  tasks: BgTask[];
  addTask: (task: BgTask) => void;
  updateTask: (id: string, patch: Partial<BgTask>) => void;
  removeTask: (id: string) => void;
  clearDone: () => void;
}

let _nextId = 1;
export function newTaskId() {
  return `task-${_nextId++}`;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  addTask: (task) => set((s) => ({ tasks: [...s.tasks, task] })),
  updateTask: (id, patch) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  removeTask: (id) =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  clearDone: () =>
    set((s) => ({ tasks: s.tasks.filter((t) => t.status === "running") })),
}));

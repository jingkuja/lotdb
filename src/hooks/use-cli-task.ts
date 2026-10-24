import { useCallback, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cancelTransfer } from "@/services/tauri-commands";

/** Payload of the backend's `backup-progress` event. */
export interface CliTaskProgress {
  taskId: string;
  /** Backup: bytes written so far. Restore: bytes of the dump sent. */
  done: number;
  /** Restore: size of the dump file. Backup: 0 (unknown). */
  total: number;
}

/**
 * Runs a backup/restore command with a task id, so it can report progress
 * and be cancelled (the backend kills the mysqldump/psql child process).
 */
export function useCliTask() {
  const taskIdRef = useRef<string | null>(null);
  const [progress, setProgress] = useState<CliTaskProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const run = useCallback(
    async <T>(fn: (taskId: string) => Promise<T>): Promise<T> => {
      const taskId = crypto.randomUUID();
      taskIdRef.current = taskId;
      setProgress(null);
      setCancelling(false);
      const unlisten = await listen<CliTaskProgress>(
        "backup-progress",
        (ev) => {
          if (ev.payload.taskId === taskId) setProgress(ev.payload);
        },
      );
      try {
        return await fn(taskId);
      } finally {
        taskIdRef.current = null;
        unlisten();
      }
    },
    [],
  );

  const cancel = useCallback(async () => {
    if (!taskIdRef.current) return;
    setCancelling(true);
    try {
      await cancelTransfer(taskIdRef.current);
    } catch {
      setCancelling(false);
    }
  }, []);

  return { run, progress, cancelling, cancel };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

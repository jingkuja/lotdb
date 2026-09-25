import { useEffect, useRef } from "react";
import { registerWorkspaceGuard } from "@/lib/workspace-guards";
import { useWorkspaceStore } from "@/stores/workspace-store";
export function useWorkspaceGuard(id: string, message: string | null) {
  const ref = useRef(message);
  useEffect(() => { ref.current = message; });
  useEffect(() => registerWorkspaceGuard(id, () => ref.current), [id]);
  useEffect(() => {
    useWorkspaceStore.getState().setDirty(id, !!message);
    return () => useWorkspaceStore.getState().setDirty(id, false);
  }, [id, message]);
}

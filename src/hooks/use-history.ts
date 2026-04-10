import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getHistory,
  saveHistory,
  deleteHistory,
  clearHistory,
  type SaveHistoryArgs,
} from "@/services/tauri-commands";

const HISTORY_KEY = "query-history";

export function useHistory(connectionId?: string) {
  return useQuery({
    queryKey: [HISTORY_KEY, connectionId ?? "all"],
    queryFn: () => getHistory(connectionId),
    staleTime: 0, // Always fresh when dialog opens
  });
}

export function useSaveHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: SaveHistoryArgs) => saveHistory(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HISTORY_KEY] });
    },
  });
}

export function useDeleteHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteHistory(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HISTORY_KEY] });
    },
  });
}

export function useClearHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId?: string) => clearHistory(connectionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HISTORY_KEY] });
    },
  });
}

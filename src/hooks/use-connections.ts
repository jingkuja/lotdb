import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
} from "@/services/tauri-commands";
import type { ConnectionConfig } from "@/types/database";

const QUERY_KEY = ["connections"];

export function useConnections() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: getConnections,
  });
}

export function useCreateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createConnection,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function useUpdateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updateConnection,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteConnection,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (config: ConnectionConfig) => testConnection(config),
  });
}

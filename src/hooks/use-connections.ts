import { useConnectionStore } from "@/stores/connection-store";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  listGroups,
  createGroup,
  renameGroup,
  deleteGroup,
} from "@/services/tauri-commands";
import type { ConnectionConfig } from "@/types/database";

const QUERY_KEY = ["connections"];
const GROUPS_KEY = ["connection-groups"];

export function useConnections() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: getConnections,
    retry: 4,
    retryDelay: (n) => Math.min(1500, 250 * 2 ** n),
  });
}

export function useConnectionGroups() {
  return useQuery({
    queryKey: GROUPS_KEY,
    queryFn: listGroups,
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createGroup(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: GROUPS_KEY }),
  });
}

export function useRenameGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      renameGroup(id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GROUPS_KEY });
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GROUPS_KEY });
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
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
    onSuccess: (config) => {
      useConnectionStore.getState().markPoolClosed(config.id);
      return qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
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

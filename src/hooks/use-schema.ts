import { useQuery } from "@tanstack/react-query";
import { listDatabases, listSchemas, listObjects } from "@/services/tauri-commands";

export function useDatabases(connectionId: string, enabled = true) {
  return useQuery({
    queryKey: ["databases", connectionId],
    queryFn: () => listDatabases(connectionId),
    enabled: enabled && !!connectionId,
    staleTime: 30_000,
  });
}

export function useSchemas(
  connectionId: string,
  database: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["schemas", connectionId, database],
    queryFn: () => listSchemas(connectionId, database),
    enabled: enabled && !!connectionId && !!database,
    staleTime: 30_000,
  });
}

export function useObjects(
  connectionId: string,
  database: string,
  schema: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ["objects", connectionId, database, schema ?? ""],
    queryFn: () => listObjects(connectionId, database, schema),
    enabled: enabled && !!connectionId && !!database,
    staleTime: 30_000,
  });
}

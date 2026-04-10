import { useQuery } from "@tanstack/react-query";
import {
  getTableColumns,
  getTableIndexes,
  getTableForeignKeys,
} from "@/services/tauri-commands";

interface TableKey {
  connectionId: string;
  database: string;
  schema?: string;
  table: string;
}

export function useTableColumns({ connectionId, database, schema, table }: TableKey) {
  return useQuery({
    queryKey: ["columns", connectionId, database, schema ?? "", table],
    queryFn: () => getTableColumns(connectionId, database, schema, table),
    staleTime: 60_000,
  });
}

export function useTableIndexes({ connectionId, database, schema, table }: TableKey) {
  return useQuery({
    queryKey: ["indexes", connectionId, database, schema ?? "", table],
    queryFn: () => getTableIndexes(connectionId, database, schema, table),
    staleTime: 60_000,
  });
}

export function useTableForeignKeys({ connectionId, database, schema, table }: TableKey) {
  return useQuery({
    queryKey: ["foreign-keys", connectionId, database, schema ?? "", table],
    queryFn: () => getTableForeignKeys(connectionId, database, schema, table),
    staleTime: 60_000,
  });
}

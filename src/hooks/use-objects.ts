import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getViewDdl,
  getFunctionDdl,
  getTriggerDdl,
  listTriggers,
  listSequences,
  listEnums,
  type ObjectDdl,
  type SequenceInfo,
  type EnumTypeInfo,
  type TriggerInfo,
} from "@/services/tauri-commands";

export type DdlKind = "view" | "function" | "trigger";

interface DdlTarget {
  connectionId: string;
  database: string;
  schema?: string;
  name: string;
  kind: DdlKind;
  /** trigger's parent table (triggers only) */
  table?: string;
}

/** Fetch DDL for a view / function / trigger. */
export function useObjectDdl(target: DdlTarget) {
  const { connectionId, database, schema, name, kind, table } = target;
  return useQuery<ObjectDdl, string>({
    queryKey: ["object-ddl", connectionId, database, schema, name, kind, table],
    queryFn: () => {
      if (kind === "function") {
        return getFunctionDdl(connectionId, database, schema, name);
      }
      if (kind === "trigger") {
        return getTriggerDdl(connectionId, database, schema, table, name);
      }
      return getViewDdl(connectionId, database, schema, name);
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function useTriggers(
  connectionId: string,
  database: string,
  schema: string | undefined,
  enabled: boolean,
) {
  return useQuery<TriggerInfo[], string>({
    queryKey: ["triggers", connectionId, database, schema],
    queryFn: () => listTriggers(connectionId, database, schema),
    enabled,
  });
}

export function useSequences(
  connectionId: string,
  database: string,
  schema: string | undefined,
  enabled: boolean,
) {
  return useQuery<SequenceInfo[], string>({
    queryKey: ["sequences", connectionId, database, schema],
    queryFn: () => listSequences(connectionId, database, schema),
    enabled,
  });
}

export function useEnums(
  connectionId: string,
  database: string,
  schema: string | undefined,
  enabled: boolean,
) {
  return useQuery<EnumTypeInfo[], string>({
    queryKey: ["enums", connectionId, database, schema],
    queryFn: () => listEnums(connectionId, database, schema),
    enabled,
  });
}

/** Invalidate every object list for a connection+database. */
export function useInvalidateObjects() {
  const qc = useQueryClient();
  return (connectionId: string, database: string, schema?: string) => {
    void schema; // prefixes are matched per key below
    qc.invalidateQueries({ queryKey: ["triggers", connectionId, database] });
    qc.invalidateQueries({ queryKey: ["sequences", connectionId, database] });
    qc.invalidateQueries({ queryKey: ["enums", connectionId, database] });
    qc.invalidateQueries({ queryKey: ["objects", connectionId, database] });
  };
}

/** Simple mutation wrapper that invalidates object lists on success. */
export function useObjectMutation<TArgs, TResult>(
  mutationFn: (args: TArgs) => Promise<TResult>,
  invalidate: { connectionId: string; database: string },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["triggers", invalidate.connectionId, invalidate.database] });
      qc.invalidateQueries({ queryKey: ["sequences", invalidate.connectionId, invalidate.database] });
      qc.invalidateQueries({ queryKey: ["enums", invalidate.connectionId, invalidate.database] });
    },
  });
}

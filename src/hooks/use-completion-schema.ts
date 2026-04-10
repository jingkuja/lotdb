import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getCompletionSchema } from "@/services/tauri-commands";

/** CodeMirror SQL schema: table name → column names */
export type CmSchema = Record<string, readonly string[]>;

/**
 * Fetches all table/column names for the open connection and converts them
 * into CodeMirror's schema format for SQL autocomplete.
 *
 * Tables are indexed by:
 *   - bare name:              "users"
 *   - schema-qualified (PG):  "public.users"
 *   - db-qualified (MySQL):   "mydb.users"
 */
export function useCompletionSchema(
  connectionId: string | null,
  enabled = true,
): CmSchema {
  const { data = [] } = useQuery({
    queryKey: ["completion-schema", connectionId],
    queryFn: () => getCompletionSchema(connectionId!),
    enabled: !!connectionId && enabled,
    // Schema rarely changes during a session — 5 min stale time
    staleTime: 5 * 60_000,
    // Don't refetch on window focus to avoid disrupting the editor
    refetchOnWindowFocus: false,
  });

  return useMemo<CmSchema>(() => {
    const schema: CmSchema = {};
    for (const table of data) {
      const cols = table.columns;
      // bare name
      schema[table.name] = cols;
      // qualified name
      const qualifier = table.schema ?? table.database;
      if (qualifier) {
        schema[`${qualifier}.${table.name}`] = cols;
      }
    }
    return schema;
  }, [data]);
}

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getSnippets,
  createSnippet,
  updateSnippet,
  deleteSnippet,
} from "@/services/tauri-commands";

const KEY = "snippets";

export function useSnippets(search?: string) {
  return useQuery({
    queryKey: [KEY, search ?? ""],
    queryFn: () => getSnippets(search),
    staleTime: 0,
  });
}

export function useCreateSnippet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      name,
      sql,
      description,
    }: {
      name: string;
      sql: string;
      description?: string;
    }) => createSnippet(name, sql, description),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateSnippet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      name,
      sql,
      description,
    }: {
      id: number;
      name: string;
      sql: string;
      description?: string;
    }) => updateSnippet(id, name, sql, description),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useDeleteSnippet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => deleteSnippet(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** Live guards are kept outside persisted workspace state. */
const guards = new Map<string, () => string | null>();
export function registerWorkspaceGuard(id: string, guard: () => string | null) {
  guards.set(id, guard);
  return () => { if (guards.get(id) === guard) guards.delete(id); };
}
export function pendingWorkspaceMessages(id?: string): string[] {
  return [...guards.entries()].filter(([key]) => !id || key === id)
    .map(([, guard]) => guard()).filter((message): message is string => !!message);
}

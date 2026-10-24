import { create } from "zustand";

/**
 * Client-side connection state. Saved connections and groups live in React
 * Query (useConnections / useGroups); this store only tracks which pools are
 * open in the backend and which connection is selected.
 */
interface ConnectionState {
  activeConnectionId: string | null;
  openPoolIds: Set<string>;
  /** Bumped on every (re)open, so sessions tied to an old pool are rebuilt. */
  generations: Record<string, number>;
  setActiveConnection: (id: string | null) => void;
  markPoolOpen: (id: string) => void;
  markPoolClosed: (id: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  activeConnectionId: null,
  openPoolIds: new Set(),
  generations: {},
  setActiveConnection: (id) => set({ activeConnectionId: id }),
  markPoolOpen: (id) =>
    set((state) => ({
      openPoolIds: new Set([...state.openPoolIds, id]),
      generations: {
        ...state.generations,
        [id]: (state.generations[id] ?? 0) + 1,
      },
    })),
  markPoolClosed: (id) =>
    set((state) => {
      const next = new Set(state.openPoolIds);
      next.delete(id);
      return { openPoolIds: next };
    }),
}));

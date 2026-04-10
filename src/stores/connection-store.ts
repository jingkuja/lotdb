import { create } from "zustand";
import type { ConnectionConfig, ConnectionGroup } from "@/types/database";

interface ConnectionState {
  connections: ConnectionConfig[];
  groups: ConnectionGroup[];
  activeConnectionId: string | null;
  openPoolIds: Set<string>;
  setActiveConnection: (id: string | null) => void;
  addConnection: (connection: ConnectionConfig) => void;
  removeConnection: (id: string) => void;
  updateConnection: (id: string, config: Partial<ConnectionConfig>) => void;
  markPoolOpen: (id: string) => void;
  markPoolClosed: (id: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: [],
  groups: [],
  activeConnectionId: null,
  openPoolIds: new Set(),
  setActiveConnection: (id) => set({ activeConnectionId: id }),
  addConnection: (connection) =>
    set((state) => ({ connections: [...state.connections, connection] })),
  removeConnection: (id) =>
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
    })),
  updateConnection: (id, config) =>
    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === id ? { ...c, ...config } : c,
      ),
    })),
  markPoolOpen: (id) =>
    set((state) => ({ openPoolIds: new Set([...state.openPoolIds, id]) })),
  markPoolClosed: (id) =>
    set((state) => {
      const next = new Set(state.openPoolIds);
      next.delete(id);
      return { openPoolIds: next };
    }),
}));

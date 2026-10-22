import { create } from "zustand";

/**
 * In-app replacements for window.confirm / prompt / alert.
 *
 * The Tauri webview on macOS (wry) implements none of WKWebView's JavaScript
 * panel delegates, so the native calls silently return false / null and never
 * show anything. Every confirmation or text input must go through here.
 */

interface BaseRequest {
  id: number;
  title?: string;
  message: string;
}

export type DialogRequest =
  | (BaseRequest & {
      kind: "confirm";
      confirmLabel?: string;
      destructive?: boolean;
      resolve: (ok: boolean) => void;
    })
  | (BaseRequest & {
      kind: "prompt";
      defaultValue?: string;
      resolve: (value: string | null) => void;
    })
  | (BaseRequest & { kind: "alert"; resolve: () => void });

interface AppDialogState {
  queue: DialogRequest[];
  push: (request: DialogRequest) => void;
  settle: (id: number) => void;
}

export const useAppDialogStore = create<AppDialogState>((set) => ({
  queue: [],
  push: (request) => set((s) => ({ queue: [...s.queue, request] })),
  settle: (id) => set((s) => ({ queue: s.queue.filter((r) => r.id !== id) })),
}));

let nextId = 1;

type Options = { title?: string };

export function confirmDialog(
  message: string,
  options: Options & { confirmLabel?: string; destructive?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) =>
    useAppDialogStore
      .getState()
      .push({ id: nextId++, kind: "confirm", message, ...options, resolve }),
  );
}

export function promptDialog(
  message: string,
  defaultValue = "",
  options: Options = {},
): Promise<string | null> {
  return new Promise((resolve) =>
    useAppDialogStore.getState().push({
      id: nextId++,
      kind: "prompt",
      message,
      defaultValue,
      ...options,
      resolve,
    }),
  );
}

export function alertDialog(
  message: string,
  options: Options = {},
): Promise<void> {
  return new Promise((resolve) =>
    useAppDialogStore
      .getState()
      .push({ id: nextId++, kind: "alert", message, ...options, resolve }),
  );
}

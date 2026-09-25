// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../workspace-store";
import { useEditorStore, flushDrafts } from "../editor-store";
import { registerWorkspaceGuard } from "@/lib/workspace-guards";
afterEach(() => {
  vi.restoreAllMocks();
  useWorkspaceStore.setState({ tabs: [], activeTabId: null });
});
it("keeps a tab and its draft when closing is rejected", () => {
  const store = useWorkspaceStore.getState();
  store.addTab({
    id: "draft",
    title: "query",
    type: "query",
    connectionId: "c",
  });
  useEditorStore.getState().setContent("draft", "SELECT 1");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  store.removeTab("draft");
  expect(confirm).toHaveBeenCalled();
  expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
  flushDrafts();
  expect(localStorage.getItem("lotdb-editor-drafts")).toContain("SELECT 1");
  confirm.mockReturnValue(true);
  store.removeTab("draft");
  expect(useEditorStore.getState().getContent("draft")).toBe("");
});
it("shares close guards across UI and shortcut store actions", () => {
  const store = useWorkspaceStore.getState();
  store.addTab({
    id: "table",
    title: "users",
    type: "table-data",
    connectionId: "c",
  });
  const unregister = registerWorkspaceGuard("table", () => "pending edits");
  vi.spyOn(window, "confirm").mockReturnValue(false);
  store.removeTab("table");
  expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
  unregister();
  store.removeTab("table");
  expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
});

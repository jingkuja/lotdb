// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { useWorkspaceStore } from "../workspace-store";
import { useEditorStore, flushDrafts } from "../editor-store";
import { useAppDialogStore } from "../app-dialog-store";
import { registerWorkspaceGuard } from "@/lib/workspace-guards";

afterEach(() => {
  useWorkspaceStore.setState({ tabs: [], activeTabId: null });
  useAppDialogStore.setState({ queue: [] });
});

/** Answer the confirmation currently shown by the in-app dialog host. */
async function answerConfirm(ok: boolean) {
  await Promise.resolve();
  const request = useAppDialogStore.getState().queue[0];
  expect(request?.kind).toBe("confirm");
  useAppDialogStore.getState().settle(request!.id);
  if (request?.kind === "confirm") request.resolve(ok);
}

it("closes a query draft without asking and can reopen it", async () => {
  useWorkspaceStore.setState({ closedQueries: [] });
  const store = useWorkspaceStore.getState();
  store.addTab({
    id: "draft",
    title: "query",
    type: "query",
    connectionId: "c",
    metadata: { database: "app" },
  });
  useEditorStore.getState().setContent("draft", "SELECT 1");

  expect(await store.removeTab("draft")).toBe(true);
  expect(useAppDialogStore.getState().queue).toHaveLength(0);
  expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
  expect(useEditorStore.getState().getContent("draft")).toBe("");
  expect(useWorkspaceStore.getState().closedQueries[0]?.sql).toBe("SELECT 1");
  flushDrafts();
  expect(localStorage.getItem("lotdb-workspace")).toContain("SELECT 1");

  useWorkspaceStore.getState().reopenClosedQuery();
  const state = useWorkspaceStore.getState();
  expect(state.tabs).toEqual([
    expect.objectContaining({ id: "draft", metadata: { database: "app" } }),
  ]);
  expect(state.activeTabId).toBe("draft");
  expect(state.closedQueries).toHaveLength(0);
  expect(useEditorStore.getState().getContent("draft")).toBe("SELECT 1");
});

it("does not stash empty query tabs", async () => {
  useWorkspaceStore.setState({ closedQueries: [] });
  const store = useWorkspaceStore.getState();
  store.addTab({ id: "empty", title: "q", type: "query", connectionId: "c" });
  useEditorStore.getState().setContent("empty", "  \n");
  expect(await store.removeTab("empty")).toBe(true);
  expect(useWorkspaceStore.getState().closedQueries).toHaveLength(0);
});

it("switches to an open tab instead of adding a duplicate", () => {
  const store = useWorkspaceStore.getState();
  const tab = {
    id: "c/db/table/users/data",
    title: "users",
    type: "table-data" as const,
    connectionId: "c",
  };
  store.addTab(tab);
  store.addTab({ ...tab, id: "other" });
  store.addTab(tab);
  const state = useWorkspaceStore.getState();
  expect(state.tabs.map((t) => t.id)).toEqual([tab.id, "other"]);
  expect(state.activeTabId).toBe(tab.id);
});

it("shares close guards across UI and shortcut store actions", async () => {
  const store = useWorkspaceStore.getState();
  store.addTab({
    id: "table",
    title: "users",
    type: "table-data",
    connectionId: "c",
  });
  const unregister = registerWorkspaceGuard("table", () => "pending edits");

  const rejected = store.removeTab("table");
  await answerConfirm(false);
  await rejected;
  expect(useWorkspaceStore.getState().tabs).toHaveLength(1);

  unregister();
  expect(await store.removeTab("table")).toBe(true);
  expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
  expect(useAppDialogStore.getState().queue).toHaveLength(0);
});

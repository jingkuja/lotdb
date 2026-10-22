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

it("keeps a tab and its draft when closing is rejected", async () => {
  const store = useWorkspaceStore.getState();
  store.addTab({
    id: "draft",
    title: "query",
    type: "query",
    connectionId: "c",
  });
  useEditorStore.getState().setContent("draft", "SELECT 1");

  const rejected = store.removeTab("draft");
  await answerConfirm(false);
  expect(await rejected).toBe(false);
  expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
  flushDrafts();
  expect(localStorage.getItem("lotdb-editor-drafts")).toContain("SELECT 1");

  const accepted = store.removeTab("draft");
  await answerConfirm(true);
  expect(await accepted).toBe(true);
  expect(useWorkspaceStore.getState().tabs).toHaveLength(0);
  expect(useEditorStore.getState().getContent("draft")).toBe("");
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

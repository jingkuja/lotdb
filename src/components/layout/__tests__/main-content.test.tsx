// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MainContent } from "../main-content";
import { useWorkspaceStore } from "@/stores/workspace-store";
vi.mock("@/hooks/use-connections", () => ({
  useConnections: () => ({ data: [] }),
}));
vi.mock("@/components/grid/table-data-tab", () => ({
  TableDataTab: ({ table }: { table: string }) => {
    const [draft, setDraft] = useState(0);
    return (
      <button onClick={() => setDraft(draft + 1)}>
        {table}:{draft}
      </button>
    );
  },
}));
afterEach(() => {
  cleanup();
  useWorkspaceStore.setState({ tabs: [], activeTabId: null });
});
it("isolates table drafts and preserves them when switching tabs", () => {
  useWorkspaceStore.setState({
    tabs: ["a", "b"].map((id) => ({
      id,
      title: id,
      type: "table-data",
      connectionId: "c",
      metadata: { database: "db", objectName: id },
    })),
    activeTabId: "a",
  });
  render(<MainContent />);
  fireEvent.click(screen.getByText("a:0"));
  act(() => useWorkspaceStore.getState().setActiveTab("b"));
  expect(screen.getByText("b:0")).toBeDefined();
  act(() => useWorkspaceStore.getState().setActiveTab("a"));
  expect(screen.getByText("a:1")).toBeDefined();
});

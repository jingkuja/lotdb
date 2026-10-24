// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ObjectTree } from "../object-tree";
import {
  copyTable,
  dropObject,
  listDatabases,
  listObjects,
  truncateTable,
} from "@/services/tauri-commands";
import { confirmDialog, promptDialog } from "@/stores/app-dialog-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

vi.mock("@/services/tauri-commands", async (original) => ({
  ...(await original<typeof import("@/services/tauri-commands")>()),
  listDatabases: vi.fn(),
  listObjects: vi.fn(),
  dropObject: vi.fn(),
  truncateTable: vi.fn(),
  copyTable: vi.fn(),
  renameTable: vi.fn(),
}));
vi.mock("@/stores/app-dialog-store", () => ({
  confirmDialog: vi.fn(),
  promptDialog: vi.fn(),
  alertDialog: vi.fn(),
}));
vi.mock("@/hooks/use-connections", () => ({
  useConnections: () => ({ data: [{ id: "c", dbType: "mysql" }] }),
}));

beforeEach(() => {
  vi.mocked(listDatabases).mockResolvedValue([
    "shop",
    "mysql",
    "information_schema",
    "crm",
  ]);
  vi.mocked(listObjects).mockImplementation(async (_c, db) => ({
    tables: db === "shop" ? ["orders", "order_items", "users"] : ["leads"],
    views: db === "shop" ? ["v_orders"] : [],
    functions: [],
  }));
  vi.mocked(confirmDialog).mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useWorkspaceStore.setState({ tabs: [], activeTabId: null });
});

function renderTree() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ObjectTree connectionId="c" dbType="mysql" />
    </QueryClientProvider>,
  );
}

it("lists system databases apart and filters by name", async () => {
  renderTree();
  await screen.findByText("shop");
  expect(screen.getByText("系统库 (2)")).toBeTruthy();
  expect(screen.queryByText("mysql")).toBeNull();

  // Open shop, then filter: other closed databases hide, tables narrow.
  fireEvent.click(screen.getByText("shop"));
  await screen.findByText("Tables (3)");
  fireEvent.change(screen.getByLabelText("过滤对象"), {
    target: { value: "ORDER" },
  });
  expect(screen.queryByText("crm")).toBeNull();
  expect(screen.getByText("Tables (2/3)")).toBeTruthy();
  expect(screen.getByText("orders")).toBeTruthy();
  expect(screen.getByText("order_items")).toBeTruthy();
  expect(screen.queryByText("users")).toBeNull();
  // Views match too, and the folder opens by itself.
  expect(screen.getByText("v_orders")).toBeTruthy();

  fireEvent.keyDown(screen.getByLabelText("过滤对象"), { key: "Escape" });
  expect(screen.getByText("crm")).toBeTruthy();
});

it("drops, truncates and copies tables from the context menu", async () => {
  useWorkspaceStore.setState({
    tabs: [
      {
        id: "c/shop/table/orders/data",
        title: "orders",
        type: "table-data",
        connectionId: "c",
      },
    ],
    activeTabId: "c/shop/table/orders/data",
  });
  renderTree();
  fireEvent.click(await screen.findByText("shop"));
  fireEvent.click(await screen.findByText("Tables (3)"));

  fireEvent.contextMenu(screen.getByText("orders"));
  fireEvent.click(await screen.findByText("删除表…"));
  await waitFor(() =>
    expect(dropObject).toHaveBeenCalledWith(
      "c",
      "shop",
      undefined,
      "table",
      "orders",
    ),
  );
  // The dropped table's tab closes.
  await waitFor(() => expect(useWorkspaceStore.getState().tabs).toEqual([]));

  fireEvent.contextMenu(screen.getByText("users"));
  fireEvent.click(await screen.findByText("清空表…"));
  await waitFor(() =>
    expect(truncateTable).toHaveBeenCalledWith("c", "shop", undefined, "users"),
  );

  vi.mocked(promptDialog).mockResolvedValueOnce("users_copy");
  fireEvent.contextMenu(screen.getByText("users"));
  fireEvent.click(await screen.findByText("复制表（结构和数据）…"));
  await waitFor(() =>
    expect(copyTable).toHaveBeenCalledWith(
      "c",
      "shop",
      undefined,
      "users",
      "users_copy",
      true,
    ),
  );

  // Declining the confirmation does nothing.
  vi.mocked(confirmDialog).mockResolvedValueOnce(false);
  fireEvent.contextMenu(screen.getByText("users"));
  fireEvent.click(await screen.findByText("删除表…"));
  await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(3));
  expect(dropObject).toHaveBeenCalledTimes(1);
});

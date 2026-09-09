// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TableDataTab } from "../table-data-tab";
import {
  executeStatements,
  getTableData,
  getTableColumns,
} from "@/services/tauri-commands";

vi.mock("@/services/tauri-commands", async (original) => ({
  ...(await original<typeof import("@/services/tauri-commands")>()),
  getTableData: vi.fn(),
  getTableColumns: vi.fn(),
  executeStatements: vi.fn(),
}));
vi.mock("@/hooks/use-connections", () => ({
  useConnections: () => ({ data: [{ id: "c", dbType: "postgres" }] }),
}));
vi.mock("@/hooks/use-theme", () => ({ useTheme: () => ({}) }));
vi.mock("../data-grid", () => ({
  editKey: (row: number, col: string) => `${row}:${col}`,
  DataGrid: ({
    rows,
    onEditCommit,
    onDeleteToggle,
  }: {
    rows: unknown[][];
    onEditCommit?: (edit: unknown) => void;
    onDeleteToggle?: (index: number) => void;
  }) => (
    <div>
      <span data-testid="row-id">{String(rows[0]?.[0])}</span>
      <button
        onClick={() =>
          onEditCommit?.({
            rowIndex: 0,
            column: "name",
            originalValue: "Alice",
            newValue: "edited",
          })
        }
      >
        Edit
      </button>
      <button onClick={() => onDeleteToggle?.(0)}>Delete</button>
    </div>
  ),
}));
vi.mock("../change-preview-dialog", () => ({
  ChangePreviewDialog: ({
    open,
    sqls,
    onCommit,
  }: {
    open: boolean;
    sqls: string[];
    onCommit: () => Promise<void>;
  }) =>
    open ? (
      <div>
        <pre data-testid="sql">{sqls.join("\n")}</pre>
        <button onClick={() => void onCommit()}>Commit</button>
      </div>
    ) : null,
}));
vi.mock("../cell-viewer-dialog", () => ({ CellViewerDialog: () => null }));
vi.mock("@/components/transfer/export-dialog", () => ({
  ExportDialog: () => null,
}));
vi.mock("@/components/transfer/import-dialog", () => ({
  ImportDialog: () => null,
}));

const queryKey = [
  "table-data",
  "c",
  "db",
  undefined,
  "users",
  0,
  200,
  undefined,
  [],
];
const original = {
  columns: ["id", "name"],
  rows: [["9007199254740993", "Alice"]],
  totalCount: 500,
};
let qc: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTableData).mockResolvedValue(original);
  vi.mocked(getTableColumns).mockResolvedValue([
    {
      name: "id",
      dataType: "bigint",
      isPrimaryKey: true,
      nullable: false,
      defaultValue: null,
      comment: null,
      extra: null,
    },
  ]);
  vi.mocked(executeStatements).mockResolvedValue(1);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  qc.clear();
});
function mount() {
  render(
    <QueryClientProvider client={qc}>
      <TableDataTab connectionId="c" database="db" table="users" />
    </QueryClientProvider>,
  );
}

describe("table draft identity", () => {
  it.each(["Edit", "Delete"])(
    "keeps original key across background refresh after %s",
    async (action) => {
      mount();
      await waitFor(() =>
        expect(screen.getByTestId("row-id").textContent).toBe(
          "9007199254740993",
        ),
      );
      // Wait for PK metadata as well as rows.
      await waitFor(() =>
        expect(
          qc.getQueryData(["table-columns", "c", "db", undefined, "users"]),
        ).toBeDefined(),
      );
      fireEvent.click(screen.getByText(action));
      act(() =>
        qc.setQueriesData(
          { queryKey: queryKey.slice(0, 5) },
          { ...original, rows: [["2", "Bob"]] },
        ),
      );
      expect(screen.getByTestId("row-id").textContent).toBe("9007199254740993");
      fireEvent.click(screen.getByText("预览"));
      expect(screen.getByTestId("sql").textContent).toContain(
        `WHERE "id" = '9007199254740993'`,
      );
      expect((screen.getByTitle("刷新") as HTMLButtonElement).disabled).toBe(
        true,
      );
      fireEvent.click(screen.getByText("Commit"));
      await waitFor(() =>
        expect(executeStatements).toHaveBeenCalledWith(
          "c",
          [expect.stringContaining(`WHERE "id" = '9007199254740993'`)],
          "db",
        ),
      );
    },
  );

  it("uses the fresh page after a deletion is undone", async () => {
    mount();
    await waitFor(() =>
      expect(
        qc.getQueryData(["table-columns", "c", "db", undefined, "users"]),
      ).toBeDefined(),
    );
    fireEvent.click(await screen.findByText("Delete"));
    fireEvent.click(screen.getByText("Delete"));
    act(() =>
      qc.setQueriesData(
        { queryKey: queryKey.slice(0, 5) },
        { ...original, rows: [["2", "Bob"]] },
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("row-id").textContent).toBe("2"),
    );
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("预览"));
    expect(screen.getByTestId("sql").textContent).toContain(`WHERE "id" = '2'`);
  });
});

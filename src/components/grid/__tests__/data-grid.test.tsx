// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataGrid } from "../data-grid";
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 28,
        end: (index + 1) * 28,
      })),
    getTotalSize: () => count * 28,
    scrollToIndex: vi.fn(),
  }),
}));
afterEach(cleanup);
it("keeps new-row inputs aligned with reordered columns and supports all three value states", () => {
  const onChange = vi.fn();
  render(
    <DataGrid
      columns={["id", "name"]}
      rows={[]}
      newRows={[{}]}
      onNewRowChange={onChange}
    />,
  );
  const transfer = { effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(screen.getByText("name").parentElement!, {
    dataTransfer: transfer,
  });
  fireEvent.dragOver(screen.getByText("id").parentElement!, {
    dataTransfer: transfer,
  });
  fireEvent.drop(screen.getByText("id").parentElement!, {
    dataTransfer: transfer,
  });
  expect(
    screen.getAllByRole("textbox").map((el) => el.getAttribute("aria-label")),
  ).toEqual(["name", "id"]);
  const pick = (item: string) => {
    fireEvent.keyDown(screen.getByLabelText("name 的取值方式"), {
      key: "Enter",
    });
    fireEvent.click(screen.getByText(item));
  };
  pick("设为 NULL");
  expect(onChange).toHaveBeenLastCalledWith(0, "name", null);
  pick("使用默认值（DEFAULT）");
  expect(onChange).toHaveBeenLastCalledWith(0, "name", undefined);
  pick("设为空字符串");
  expect(onChange).toHaveBeenLastCalledWith(0, "name", "");
});

it("double-click edits without opening the viewer and stages the value", () => {
  const onEditCommit = vi.fn();
  const onCellView = vi.fn();
  render(
    <DataGrid
      columns={["name"]}
      rows={[["Alice"]]}
      onEditCommit={onEditCommit}
      onCellView={onCellView}
    />,
  );
  fireEvent.click(screen.getByText("Alice"));
  fireEvent.doubleClick(screen.getByText("Alice"));
  expect(onCellView).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Bob" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(onEditCommit).toHaveBeenCalledExactlyOnceWith({
    rowIndex: 0,
    column: "name",
    originalValue: "Alice",
    newValue: "Bob",
  });
});

it("supports explicit viewing, canceling and setting NULL", () => {
  const onEditCommit = vi.fn();
  const onCellView = vi.fn();
  render(
    <DataGrid
      columns={["name"]}
      rows={[["Alice"]]}
      onEditCommit={onEditCommit}
      onCellView={onCellView}
    />,
  );
  fireEvent.click(screen.getByTitle("查看单元格"));
  expect(onCellView).toHaveBeenCalledWith({
    columnName: "name",
    value: "Alice",
  });
  fireEvent.click(screen.getByTitle("编辑单元格"));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(onEditCommit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTitle("编辑单元格"));
  fireEvent.click(screen.getByTitle("设为 NULL"));
  expect(onEditCommit).toHaveBeenCalledExactlyOnceWith({
    rowIndex: 0,
    column: "name",
    originalValue: "Alice",
    newValue: null,
  });
});

it("allows changing NULL to empty text and restoring a pending edit", () => {
  const onEditCommit = vi.fn();
  const { rerender } = render(
    <DataGrid columns={["name"]} rows={[[null]]} onEditCommit={onEditCommit} />,
  );
  fireEvent.click(screen.getByTitle("编辑单元格"));
  fireEvent.click(screen.getByTitle("取消 NULL，改为字符串"));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(onEditCommit).toHaveBeenLastCalledWith({
    rowIndex: 0,
    column: "name",
    originalValue: null,
    newValue: "",
  });
  rerender(
    <DataGrid
      columns={["name"]}
      rows={[["Alice"]]}
      pendingEdits={{
        "0:name": {
          rowIndex: 0,
          column: "name",
          originalValue: "Alice",
          newValue: "Bob",
        },
      }}
      onEditCommit={onEditCommit}
    />,
  );
  fireEvent.click(screen.getByTitle("编辑单元格"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Alice" } });
  fireEvent.blur(screen.getByRole("textbox"));
  expect(onEditCommit).toHaveBeenLastCalledWith({
    rowIndex: 0,
    column: "name",
    originalValue: "Alice",
    newValue: "Alice",
  });
});

it("does not expose editing for read-only grids", () => {
  render(<DataGrid columns={["name"]} rows={[["Alice"]]} />);
  fireEvent.doubleClick(screen.getByText("Alice"));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByTitle("编辑单元格")).toBeNull();
});

it("keeps filter drafts focused until Enter and ignores IME confirmation", () => {
  vi.useFakeTimers();
  try {
    const onFilterChange = vi.fn();
    const { rerender } = render(
      <DataGrid
        columns={["name"]}
        rows={[["Alice"]]}
        showFilterRow
        onFilterChange={onFilterChange}
      />,
    );
    const input = screen.getByLabelText("name 筛选值");
    input.focus();
    fireEvent.change(input, { target: { value: "Al" } });
    vi.advanceTimersByTime(1000);
    expect(onFilterChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Alice" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onFilterChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "LIKE" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    const filter = { column: "name", op: "LIKE" as const, value: "Alice" };
    expect(onFilterChange).toHaveBeenCalledExactlyOnceWith("name", filter);
    rerender(
      <DataGrid
        columns={["name"]}
        rows={[]}
        showFilterRow
        filters={{ name: filter }}
        onFilterChange={onFilterChange}
      />,
    );
    expect(screen.getByLabelText("name 筛选值")).toBe(input);
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onFilterChange).toHaveBeenLastCalledWith("name", null);
  } finally {
    vi.useRealTimers();
  }
});

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

it("selects a range with the mouse and keyboard and copies it as TSV", () => {
  const writeText = mockClipboard();
  render(
    <DataGrid
      columns={["id", "name"]}
      rows={[
        [10, "Alice"],
        [20, null],
        [30, "Carol"],
      ]}
    />,
  );
  const grid = screen.getByRole("grid");
  fireEvent.mouseDown(screen.getByText("Alice"));
  expect(document.activeElement).toBe(grid);
  fireEvent.keyDown(grid, { key: "c", metaKey: true });
  expect(writeText).toHaveBeenLastCalledWith("Alice");

  // Shift+click extends; arrows move the focus cell.
  fireEvent.mouseDown(screen.getByText("10"), { shiftKey: true });
  fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
  fireEvent.keyDown(grid, { key: "c", metaKey: true });
  expect(writeText).toHaveBeenLastCalledWith("10\tAlice\n20\t");
  expect(document.querySelectorAll("[data-selected]").length).toBe(4);

  fireEvent.keyDown(grid, { key: "ArrowDown" });
  fireEvent.keyDown(grid, { key: "ArrowRight" });
  fireEvent.keyDown(grid, { key: "c", metaKey: true });
  expect(writeText).toHaveBeenLastCalledWith("Carol");

  fireEvent.keyDown(grid, { key: "a", metaKey: true });
  expect(document.querySelectorAll("[data-selected]").length).toBe(6);
  fireEvent.keyDown(grid, { key: "Escape" });
  expect(document.querySelectorAll("[data-selected]").length).toBe(0);
});

it("edits the focused cell with Enter and stages NULL with Delete", () => {
  const onEditCommit = vi.fn();
  render(
    <DataGrid
      columns={["id", "name"]}
      rows={[[10, "Alice"]]}
      onEditCommit={onEditCommit}
    />,
  );
  const grid = screen.getByRole("grid");
  fireEvent.mouseDown(screen.getByText("Alice"));
  fireEvent.keyDown(grid, { key: "Enter" });
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Bob" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onEditCommit).toHaveBeenCalledExactlyOnceWith({
    rowIndex: 0,
    column: "name",
    originalValue: "Alice",
    newValue: "Bob",
  });
  expect(document.activeElement).toBe(grid);
  fireEvent.mouseDown(screen.getByText("10"));
  fireEvent.keyDown(grid, { key: "Delete" });
  expect(onEditCommit).toHaveBeenLastCalledWith({
    rowIndex: 0,
    column: "id",
    originalValue: 10,
    newValue: null,
  });
});

it("filters by a cell value from the context menu", async () => {
  const onFilterChange = vi.fn();
  render(
    <DataGrid
      columns={["name"]}
      rows={[["Alice"], [null]]}
      onFilterChange={onFilterChange}
    />,
  );
  fireEvent.contextMenu(screen.getByText("Alice"));
  fireEvent.click(await screen.findByText("按此值筛选"));
  expect(onFilterChange).toHaveBeenLastCalledWith("name", {
    column: "name",
    op: "=",
    value: "Alice",
  });
  fireEvent.contextMenu(screen.getByText("NULL"));
  fireEvent.click(await screen.findByText("排除此值"));
  expect(onFilterChange).toHaveBeenLastCalledWith("name", {
    column: "name",
    op: "IS NOT NULL",
    value: "",
  });
});

it("sizes columns from their content", () => {
  render(
    <DataGrid
      columns={["id", "created_at"]}
      rows={[[1, "2026-10-24 12:34:56.123456"]]}
    />,
  );
  const width = (text: string) =>
    parseFloat(screen.getByText(text).parentElement!.style.width);
  expect(width("id")).toBe(60);
  expect(width("created_at")).toBeGreaterThan(140);
});

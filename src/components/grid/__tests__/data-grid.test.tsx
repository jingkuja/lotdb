// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
  const cell = within(screen.getByLabelText("name").parentElement!);
  fireEvent.click(cell.getByTitle("设为 NULL"));
  expect(onChange).toHaveBeenLastCalledWith(0, "name", null);
  fireEvent.click(cell.getByTitle("使用默认值"));
  expect(onChange).toHaveBeenLastCalledWith(0, "name", undefined);
  fireEvent.click(cell.getByTitle("设为空字符串"));
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

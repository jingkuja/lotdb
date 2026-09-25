// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QuerySplit } from "../query-split";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("tracks distance from the actual starting height without accumulating and keeps both panes visible", () => {
  const { container } = render(<QuerySplit editor="SQL">Results</QuerySplit>);
  const split = container.firstElementChild as HTMLElement;
  const editor = split.firstElementChild as HTMLElement;
  vi.spyOn(split, "getBoundingClientRect").mockReturnValue({
    height: 600,
  } as DOMRect);
  vi.spyOn(editor, "getBoundingClientRect").mockReturnValue({
    height: 330,
  } as DOMRect);
  fireEvent.mouseDown(screen.getByRole("separator"), { clientY: 330 });
  fireEvent.mouseMove(window, { clientY: 360 });
  expect(editor.style.height).toContain("60%");
  fireEvent.mouseMove(window, { clientY: 390 });
  expect(editor.style.height).toContain("65%");
  fireEvent.mouseMove(window, { clientY: 3000 });
  expect(editor.style.height).toContain("79%");
  fireEvent.mouseMove(window, { clientY: -3000 });
  expect(editor.style.height).toContain(`${(80 / 600) * 100}%`);
  fireEvent.mouseUp(window);
  const height = editor.style.height;
  fireEvent.mouseMove(window, { clientY: 400 });
  expect(editor.style.height).toBe(height);
  expect(document.body.style.cursor).toBe("");
});

it("ends dragging on window blur and cleans up on unmount", () => {
  const { container, unmount } = render(
    <QuerySplit editor="SQL">Results</QuerySplit>,
  );
  vi.spyOn(
    container.firstElementChild!,
    "getBoundingClientRect",
  ).mockReturnValue({ height: 600 } as DOMRect);
  fireEvent.mouseDown(screen.getByRole("separator"), { clientY: 100 });
  expect(document.body.style.userSelect).toBe("none");
  fireEvent.blur(window);
  expect(document.body.style.userSelect).toBe("");
  fireEvent.mouseDown(screen.getByRole("separator"), { clientY: 100 });
  unmount();
  expect(document.body.style.cursor).toBe("");
  expect(document.body.style.userSelect).toBe("");
});

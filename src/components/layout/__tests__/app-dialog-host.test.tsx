// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { AppDialogHost } from "../app-dialog-host";
import {
  alertDialog,
  confirmDialog,
  promptDialog,
  useAppDialogStore,
} from "@/stores/app-dialog-store";

afterEach(() => {
  cleanup();
  useAppDialogStore.setState({ queue: [] });
});

it("resolves confirm with the button the user picks", async () => {
  render(<AppDialogHost />);
  let pending!: Promise<boolean>;
  act(() => {
    pending = confirmDialog("删除分组？", { confirmLabel: "删除" });
  });
  fireEvent.click(await screen.findByRole("button", { name: "删除" }));
  expect(await pending).toBe(true);

  act(() => {
    pending = confirmDialog("再来一次？");
  });
  fireEvent.click(await screen.findByRole("button", { name: "取消" }));
  expect(await pending).toBe(false);
});

it("returns the typed prompt value, or null when cancelled", async () => {
  render(<AppDialogHost />);
  let pending!: Promise<string | null>;
  act(() => {
    pending = promptDialog("分组名称", "默认");
  });
  const input = await screen.findByRole("textbox");
  expect(input).toHaveProperty("value", "默认");
  fireEvent.change(input, { target: { value: "生产环境" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(await pending).toBe("生产环境");

  act(() => {
    pending = promptDialog("分组名称");
  });
  fireEvent.click(await screen.findByRole("button", { name: "取消" }));
  expect(await pending).toBeNull();
});

it("shows queued dialogs one at a time", async () => {
  render(<AppDialogHost />);
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = alertDialog("第一条");
    second = alertDialog("第二条");
  });
  expect(await screen.findByText("第一条")).toBeTruthy();
  expect(screen.queryByText("第二条")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await first;
  expect(await screen.findByText("第二条")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await second;
});

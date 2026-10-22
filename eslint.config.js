import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "src-tauri"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // The Tauri webview (wry/WKWebView) silently ignores native JS dialogs:
      // confirm() is always false, prompt() always null, alert() shows nothing.
      ...(() => {
        const message = "原生弹窗在 Tauri 中不可用，请使用 @/stores/app-dialog-store";
        const names = ["alert", "confirm", "prompt"];
        return {
          "no-restricted-globals": ["error", ...names.map((name) => ({ name, message }))],
          "no-restricted-properties": [
            "error",
            ...names.map((property) => ({ object: "window", property, message })),
          ],
        };
      })(),
    },
  },
  prettier,
);

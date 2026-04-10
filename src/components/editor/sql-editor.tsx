import {
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from "react";
import { EditorView, keymap, placeholder, type ViewUpdate } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { sql, MySQL, PostgreSQL } from "@codemirror/lang-sql";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import type { DatabaseType } from "@/types/database";
import type { CmSchema } from "@/hooks/use-completion-schema";

export interface SqlEditorHandle {
  getValue(): string;
  /** Selected text, or full content when nothing is selected */
  getSelection(): string;
  /** Replace the entire document content (preserves undo history) */
  setValue(content: string): void;
  focus(): void;
}

interface SqlEditorProps {
  tabId: string;
  initialValue?: string;
  dbType?: DatabaseType;
  /** CodeMirror schema map (table → columns) for autocomplete */
  schema?: CmSchema;
  onChange?: (value: string) => void;
  onExecute?: (sql: string) => void;
  /** Sync formatter: receives current SQL, returns formatted SQL */
  onFormat?: (sql: string) => string;
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(
  function SqlEditor(
    { tabId, initialValue = "", dbType, schema, onChange, onExecute, onFormat },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Compartment lets us reconfigure just the SQL extension without tearing
    // down the entire editor (preserves cursor position, history, etc.)
    const sqlCompartmentRef = useRef(new Compartment());

    // Stable callback refs — avoids re-registering extensions on every render
    const onChangeRef = useRef(onChange);
    const onExecuteRef = useRef(onExecute);
    const onFormatRef = useRef(onFormat);
    useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
    useEffect(() => { onExecuteRef.current = onExecute; }, [onExecute]);
    useEffect(() => { onFormatRef.current = onFormat; }, [onFormat]);

    const getSelection = useCallback(() => {
      const view = viewRef.current;
      if (!view) return "";
      const { from, to } = view.state.selection.main;
      if (from !== to) return view.state.sliceDoc(from, to);
      return view.state.doc.toString();
    }, []);

    const setValue = useCallback((content: string) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    }, []);

    useImperativeHandle(ref, () => ({
      getValue: () => viewRef.current?.state.doc.toString() ?? "",
      getSelection,
      setValue,
      focus: () => viewRef.current?.focus(),
    }));

    // ── Create editor (only when tabId or dbType changes) ──────────
    useEffect(() => {
      if (!containerRef.current) return;

      const dialect = dbType === "postgres" ? PostgreSQL : MySQL;
      const compartment = sqlCompartmentRef.current;

      const editorCmds = keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            onExecuteRef.current?.(getSelection());
            return true;
          },
        },
        {
          key: "Shift-Alt-f",
          run: (view) => {
            const formatter = onFormatRef.current;
            if (!formatter) return false;
            const current = view.state.doc.toString();
            const formatted = formatter(current);
            if (formatted !== current) {
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: formatted },
              });
            }
            return true;
          },
        },
      ]);

      const changeListener = EditorView.updateListener.of(
        (update: ViewUpdate) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        },
      );

      const state = EditorState.create({
        doc: initialValue,
        extensions: [
          basicSetup,
          oneDark,
          // SQL extension is inside a compartment so schema can be updated later
          compartment.of(sql({ dialect, schema: {} })),
          editorCmds,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          changeListener,
          placeholder("-- 在此输入 SQL，Cmd+Enter 执行"),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily:
                "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            },
            ".cm-content": { padding: "8px 0", minHeight: "100%" },
          }),
        ],
      });

      const view = new EditorView({ state, parent: containerRef.current });
      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabId, dbType]);

    // ── Hot-swap schema without rebuilding the editor ──────────────
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const dialect = dbType === "postgres" ? PostgreSQL : MySQL;
      view.dispatch({
        effects: sqlCompartmentRef.current.reconfigure(
          sql({ dialect, schema: schema ?? {} }),
        ),
      });
    }, [schema, dbType]);

    return (
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden"
        style={{ colorScheme: "dark" }}
      />
    );
  },
);

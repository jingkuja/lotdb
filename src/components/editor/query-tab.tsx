import { useRef, useState, useCallback } from "react";
import { Play, Square, Database, WandSparkles, History, Bookmark, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SqlEditor, type SqlEditorHandle } from "./sql-editor";
import { ResultPanel, type ResultState } from "./result-panel";
import { ExplainPanel } from "./explain-panel";
import { HistoryDialog } from "./history-dialog";
import { SnippetsDialog } from "./snippets-dialog";
import { ParamInputDialog } from "./param-input-dialog";
import { useEditorStore } from "@/stores/editor-store";
import { executeQuery, executeQueryWithParams, explainQuery, type ExplainResult } from "@/services/tauri-commands";
import { useConnections } from "@/hooks/use-connections";
import { useCompletionSchema } from "@/hooks/use-completion-schema";
import { useSaveHistory } from "@/hooks/use-history";
import { usePreferencesStore } from "@/stores/preferences-store";
import { format as formatSql } from "sql-formatter";
import { detectParams, type SqlParam } from "@/lib/sql-params";
import type { DatabaseType } from "@/types/database";

interface QueryTabProps {
  tabId: string;
  connectionId: string;
}

// Draggable horizontal split divider
function SplitHandle({ onDrag }: { onDrag: (dy: number) => void }) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const onMove = (ev: MouseEvent) => onDrag(ev.clientY - startY);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className="group relative flex h-1.5 shrink-0 cursor-row-resize items-center justify-center bg-border hover:bg-primary/40"
      onMouseDown={handleMouseDown}
    >
      <div className="h-0.5 w-8 rounded-full bg-muted-foreground/30 group-hover:bg-primary/60" />
    </div>
  );
}

export function QueryTab({ tabId, connectionId }: QueryTabProps) {
  const editorRef = useRef<SqlEditorHandle>(null);
  const { editorFontSize, editorFontFamily, saveQueryHistory } = usePreferencesStore((s) => s.prefs);
  const [resultState, setResultState] = useState<ResultState>({ status: "idle" });
  const [running, setRunning] = useState(false);
  const [explainResult, setExplainResult] = useState<ExplainResult | null>(null);
  const [explainAnalyzed, setExplainAnalyzed] = useState(false);
  const [explaining, setExplaining] = useState(false);
  // "query" | "explain"
  const [resultMode, setResultMode] = useState<"query" | "explain">("query");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [snippetCreateMode, setSnippetCreateMode] = useState(false);
  const [paramDialogOpen, setParamDialogOpen] = useState(false);
  const [pendingParams, setPendingParams] = useState<SqlParam[]>([]);
  const pendingSqlRef = useRef<string>("");
  // Split: editorHeight in px (null = use flex default)
  const [editorHeight, setEditorHeight] = useState<number | null>(null);

  const setContent = useEditorStore((s) => s.setContent);
  const getContent = useEditorStore((s) => s.getContent);

  const { data: connections = [] } = useConnections();
  const conn = connections.find((c) => c.id === connectionId);
  const dbType: DatabaseType = conn?.dbType ?? "mysql";

  const completionSchema = useCompletionSchema(connectionId);
  const saveHistoryMutation = useSaveHistory();

  const doExecute = useCallback(
    async (trimmed: string, params?: (string | null)[]) => {
      setRunning(true);
      setResultState({ status: "loading" });
      try {
        const result =
          params && params.length > 0
            ? await executeQueryWithParams(connectionId, trimmed, params)
            : await executeQuery(connectionId, trimmed);
        setResultState({ status: "success", result });
        if (saveQueryHistory) {
          saveHistoryMutation.mutate({
            connectionId,
            connectionName: conn?.name ?? connectionId,
            sql: trimmed,
            status: "success",
            rowsAffected: result.affectedRows ?? null,
            executionMs: result.executionMs ?? null,
          });
        }
      } catch (e) {
        const errMsg = String(e);
        setResultState({ status: "error", message: errMsg });
        if (saveQueryHistory) {
          saveHistoryMutation.mutate({
            connectionId,
            connectionName: conn?.name ?? connectionId,
            sql: trimmed,
            status: "error",
            errorMessage: errMsg,
          });
        }
      } finally {
        setRunning(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectionId, conn?.name, saveQueryHistory],
  );

  const runQuery = useCallback(
    (sqlToRun: string) => {
      const trimmed = sqlToRun.trim();
      if (!trimmed) return;
      const { params } = detectParams(trimmed);
      if (params.length > 0) {
        pendingSqlRef.current = trimmed;
        setPendingParams(params);
        setParamDialogOpen(true);
      } else {
        void doExecute(trimmed);
      }
    },
    [doExecute],
  );

  const handleParamExecute = useCallback(
    (values: (string | null)[]) => {
      void doExecute(pendingSqlRef.current, values);
    },
    [doExecute],
  );

  const handleRun = () => {
    setResultMode("query");
    const sql = editorRef.current?.getSelection() ?? "";
    runQuery(sql);
  };

  const handleExplain = useCallback(
    async (analyze: boolean) => {
      const sql = (editorRef.current?.getSelection() ?? "").trim();
      if (!sql) return;
      setExplaining(true);
      setResultMode("explain");
      try {
        const result = await explainQuery(connectionId, sql, analyze);
        setExplainResult(result);
        setExplainAnalyzed(analyze);
      } catch (e) {
        setExplainResult(null);
        setResultMode("query");
        setResultState({ status: "error", message: `EXPLAIN 失败: ${String(e)}` });
      } finally {
        setExplaining(false);
      }
    },
    [connectionId],
  );

  const handleStop = () => {
    setRunning(false);
    setResultState({ status: "idle" });
  };

  // sql-formatter — passed to SqlEditor so Shift+Alt+F works inside CM too
  const handleFormat = useCallback(
    (sqlText: string): string => {
      try {
        return formatSql(sqlText, {
          language: dbType === "postgres" ? "postgresql" : "mysql",
          tabWidth: 2,
          keywordCase: "upper",
          linesBetweenQueries: 2,
        });
      } catch {
        return sqlText;
      }
    },
    [dbType],
  );

  const handleFormatClick = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.setValue(handleFormat(editor.getValue()));
  };

  // History: insert SQL into editor
  const handleHistoryInsert = useCallback((sql: string) => {
    editorRef.current?.setValue(sql);
    editorRef.current?.focus();
  }, []);

  // History: insert SQL then execute
  const handleHistoryExecute = useCallback(
    (sql: string) => {
      editorRef.current?.setValue(sql);
      runQuery(sql);
    },
    [runQuery],
  );

  // Open snippets panel in browse mode
  const handleSnippetsOpen = () => {
    setSnippetCreateMode(false);
    setSnippetsOpen(true);
  };

  // "Save as Snippet" — open create mode pre-filled with current editor content
  const handleSaveAsSnippet = () => {
    setSnippetCreateMode(true);
    setSnippetsOpen(true);
  };

  const handleSnippetInsert = useCallback((sql: string) => {
    editorRef.current?.setValue(sql);
    editorRef.current?.focus();
  }, []);

  const handleSnippetExecute = useCallback(
    (sql: string) => {
      editorRef.current?.setValue(sql);
      runQuery(sql);
    },
    [runQuery],
  );

  const handleDrag = useCallback((dy: number) => {
    setEditorHeight((prev) => Math.max(80, (prev ?? 300) + dy));
  }, []);

  const initialSql = getContent(tabId);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        {running ? (
          <Button
            variant="destructive"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            onClick={handleStop}
          >
            <Square className="size-3" />
            停止
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            onClick={handleRun}
          >
            <Play className="size-3" />
            运行
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={handleFormatClick}
        >
          <WandSparkles className="size-3" />
          格式化
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={explaining}
          onClick={() => handleExplain(false)}
          title="执行 EXPLAIN（不含实际运行时间）"
        >
          <Search className="size-3" />
          Explain
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={explaining}
          onClick={() => handleExplain(true)}
          title="执行 EXPLAIN ANALYZE（实际运行，含耗时）"
        >
          <Search className="size-3" />
          Analyze
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={() => setHistoryOpen(true)}
        >
          <History className="size-3" />
          历史
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={handleSnippetsOpen}
        >
          <Bookmark className="size-3" />
          片段
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          title="将当前 SQL 另存为片段"
          onClick={handleSaveAsSnippet}
        >
          <Bookmark className="size-3" />+
        </Button>

        <span className="text-xs text-muted-foreground">
          Cmd+Enter 执行 · Shift+Alt+F 格式化
        </span>
        <div className="flex-1" />

        {conn && (
          <span className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            <Database className="size-3" />
            {conn.name}
            {conn.database ? ` · ${conn.database}` : ""}
          </span>
        )}
      </div>

      {/* Editor pane */}
      <div
        className="shrink-0 overflow-hidden"
        style={editorHeight ? { height: editorHeight } : { flex: "0 0 55%" }}
      >
        <SqlEditor
          ref={editorRef}
          tabId={tabId}
          initialValue={initialSql}
          dbType={dbType}
          schema={completionSchema}
          onChange={(v) => setContent(tabId, v)}
          onExecute={runQuery}
          onFormat={handleFormat}
          fontSize={editorFontSize}
          fontFamily={editorFontFamily}
        />
      </div>

      {/* Drag handle */}
      <SplitHandle onDrag={handleDrag} />

      {/* Result pane */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {resultMode === "explain" && explainResult ? (
          <ExplainPanel result={explainResult} analyzed={explainAnalyzed} />
        ) : resultMode === "explain" && explaining ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-xs">
            <Search className="size-3.5 animate-pulse" />
            正在执行 EXPLAIN…
          </div>
        ) : (
          <ResultPanel state={resultState} />
        )}
      </div>

      {/* History dialog */}
      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        connectionId={connectionId}
        onInsert={handleHistoryInsert}
        onExecute={handleHistoryExecute}
      />

      {/* Snippets dialog */}
      <SnippetsDialog
        open={snippetsOpen}
        onOpenChange={setSnippetsOpen}
        onInsert={handleSnippetInsert}
        onExecute={handleSnippetExecute}
        initialSql={snippetCreateMode ? (editorRef.current?.getValue() ?? "") : ""}
        createMode={snippetCreateMode}
      />

      {/* Param input dialog */}
      <ParamInputDialog
        open={paramDialogOpen}
        onOpenChange={setParamDialogOpen}
        params={pendingParams}
        onExecute={handleParamExecute}
      />
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  configureQuerySession,
  listDatabases,
  listSchemas,
} from "@/services/tauri-commands";
import { needsWriteConfirmation, transactionAction } from "@/lib/query-actions";
import { useWorkspaceGuard } from "@/hooks/use-workspace-guard";
import { useRef, useState, useEffect, useCallback } from "react";
import {
  Play,
  Square,
  Database,
  WandSparkles,
  History,
  Bookmark,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuerySplit } from "./query-split";
import { SqlEditor, type SqlEditorHandle } from "./sql-editor";
import {
  ResultPanel,
  type ResultState,
  type MultiStmtOutcome,
} from "./result-panel";
import { ExplainPanel } from "./explain-panel";
import { HistoryDialog } from "./history-dialog";
import { SnippetsDialog } from "./snippets-dialog";
import { ParamInputDialog } from "./param-input-dialog";
import { useEditorStore } from "@/stores/editor-store";
import { useConnectionStore } from "@/stores/connection-store";
import {
  executeQuery,
  executeQueryWithParams,
  cancelQuery,
  closeQuerySession,
  explainQuery,
  openConnection,
  type ExplainResult,
} from "@/services/tauri-commands";
import { useConnections } from "@/hooks/use-connections";
import { useCompletionSchema } from "@/hooks/use-completion-schema";
import { useSaveHistory } from "@/hooks/use-history";
import { usePreferencesStore } from "@/stores/preferences-store";
import { detectParams, type SqlParam } from "@/lib/sql-params";
import { splitStatements } from "@/lib/split-statements";
import { formatDbError, isConnectionError } from "@/lib/error";
import type { DatabaseType } from "@/types/database";

interface QueryTabProps {
  tabId: string;
  connectionId: string;
}

export function QueryTab({ tabId, connectionId }: QueryTabProps) {
  const editorRef = useRef<SqlEditorHandle>(null);
  const {
    editorFontSize,
    editorFontFamily,
    saveQueryHistory,
    queryMaxRows,
    confirmDml,
  } = usePreferencesStore((s) => s.prefs);
  const [resultState, setResultState] = useState<ResultState>({
    status: "idle",
  });
  const [running, setRunning] = useState(false);
  const [transaction, setTransaction] = useState<"idle" | "open" | "error">(
    "idle",
  );
  const recordStatement = useCallback((sql: string, failed = false) => {
    if (failed)
      setTransaction((previous) => (previous === "idle" ? previous : "error"));
    else {
      const action = transactionAction(sql);
      if (action) setTransaction(action === "begin" ? "open" : "idle");
    }
  }, []);
  const [explainResult, setExplainResult] = useState<ExplainResult | null>(
    null,
  );
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
  // In-flight execution tracking for the stop button
  const currentExecutionRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  useWorkspaceGuard(
    tabId,
    running || explaining
      ? "此查询仍在执行，关闭将取消查询并结束会话。"
      : transaction !== "idle"
        ? "此查询有未结束的显式事务，关闭会回滚未提交修改。"
        : null,
  );
  const setContent = useEditorStore((s) => s.setContent);
  const getContent = useEditorStore((s) => s.getContent);

  const { data: connections = [] } = useConnections();
  const conn = connections.find((c) => c.id === connectionId);
  const dbType: DatabaseType = conn?.dbType ?? "mysql";

  const savedContext = useWorkspaceStore
    .getState()
    .tabs.find((t) => t.id === tabId)?.metadata;
  const [database, setDatabase] = useState(
    String(savedContext?.database ?? ""),
  );
  const [schema, setSchema] = useState(String(savedContext?.schema ?? ""));
  const [contextBusy, setContextBusy] = useState(false);
  const sessionReady = useRef(false);
  const generation = useConnectionStore(
    (s) => s.generations[connectionId] ?? 0,
  );
  useEffect(() => {
    sessionReady.current = false;
  }, [generation]);
  const poolOpen = useConnectionStore((s) => s.openPoolIds.has(connectionId));
  const { data: databases = [] } = useQuery({
    queryKey: ["databases", connectionId],
    queryFn: () => listDatabases(connectionId),
    enabled: poolOpen,
    staleTime: 60_000,
  });
  const { data: schemas = [] } = useQuery({
    queryKey: ["schemas", connectionId, database || conn?.database],
    queryFn: () => listSchemas(connectionId, database || conn?.database || ""),
    enabled:
      poolOpen && dbType === "postgres" && !!(database || conn?.database),
    staleTime: 60_000,
  });
  const ensureSession = useCallback(async () => {
    if (!sessionReady.current) {
      await configureQuerySession(
        connectionId,
        tabId,
        database || undefined,
        schema || undefined,
      );
      sessionReady.current = true;
    }
  }, [connectionId, tabId, database, schema]);
  const changeContext = async (nextDatabase: string, nextSchema: string) => {
    if (running || explaining || contextBusy) return;
    if (
      sessionReady.current &&
      !window.confirm(
        "切换数据库或 schema 将结束当前会话，并回滚未提交事务。确认切换？",
      )
    )
      return;
    setContextBusy(true);
    try {
      await configureQuerySession(
        connectionId,
        tabId,
        nextDatabase,
        nextSchema,
      );
      sessionReady.current = true;
      setDatabase(nextDatabase);
      setSchema(nextSchema);
      useWorkspaceStore
        .getState()
        .updateTab(tabId, {
          metadata: { database: nextDatabase, schema: nextSchema },
        });
      setResultState({ status: "idle" });
      setExplainResult(null);
      setTransaction("idle");
    } catch (error) {
      setResultState({ status: "error", message: formatDbError(error) });
    } finally {
      setContextBusy(false);
    }
  };
  const completionSchema = useCompletionSchema(
    connectionId,
    poolOpen,
    database || conn?.database,
  );
  const saveHistoryMutation = useSaveHistory();

  const newExecutionId = () =>
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const markPoolOpen = useConnectionStore((s) => s.markPoolOpen);

  // One-click reconnect: PoolManager::open closes the old pool and rebuilds
  // everything (including the SSH tunnel), so this covers tunnel drops too.
  const handleReconnect = useCallback(async () => {
    if (!conn) return;
    sessionReady.current = false;
    setTransaction("idle");
    await openConnection(conn);
    markPoolOpen(conn.id);
  }, [conn, markPoolOpen]);

  const doExecute = useCallback(
    async (trimmed: string, params?: (string | null)[]) => {
      setRunning(true);
      setResultState({ status: "loading" });
      const executionId = newExecutionId();
      currentExecutionRef.current = executionId;
      cancelRequestedRef.current = false;
      const opts = { maxRows: queryMaxRows, executionId, sessionId: tabId };
      try {
        await ensureSession();
        if (cancelRequestedRef.current) throw new Error("查询已取消");
        const result =
          params && params.length > 0
            ? await executeQueryWithParams(connectionId, trimmed, params, opts)
            : await executeQuery(connectionId, trimmed, opts);
        recordStatement(trimmed);
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
        recordStatement(trimmed, true);
        const cancelled = cancelRequestedRef.current;
        const errMsg = cancelled ? "查询已取消" : formatDbError(e);
        const onReconnect =
          !cancelled && isConnectionError(e) ? handleReconnect : undefined;
        setResultState({ status: "error", message: errMsg, onReconnect });
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
        currentExecutionRef.current = null;
        cancelRequestedRef.current = false;
        setRunning(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      connectionId,
      tabId,
      conn?.name,
      saveQueryHistory,
      queryMaxRows,
      handleReconnect,
      ensureSession,
      recordStatement,
    ],
  );

  // Sequential multi-statement execution: split by the frontend splitter,
  // run one statement at a time (each cancellable), stop on first error,
  // remaining statements are marked skipped. Results get one tab each.
  const doExecuteMulti = useCallback(
    async (stmts: string[], wholeSql: string) => {
      setRunning(true);
      const runId = newExecutionId();
      const rootExecId = newExecutionId();
      const outcomes: MultiStmtOutcome[] = stmts.map((sql) => ({
        sql,
        status: "pending",
      }));
      cancelRequestedRef.current = false;
      setResultState({ status: "multi", runId, outcomes: [...outcomes] });

      const update = (i: number, patch: Partial<MultiStmtOutcome>) => {
        outcomes[i] = { ...outcomes[i]!, ...patch };
        setResultState({ status: "multi", runId, outcomes: [...outcomes] });
      };

      let failMessage: string | null = null;
      let totalMs = 0;

      for (let i = 0; i < stmts.length; i++) {
        if (cancelRequestedRef.current) {
          update(i, { status: "skipped" });
          continue;
        }
        const execId = `${rootExecId}:${i}`;
        currentExecutionRef.current = execId;
        update(i, { status: "running" });
        try {
          await ensureSession();
          if (cancelRequestedRef.current) throw new Error("查询已取消");
          const r = await executeQuery(connectionId, stmts[i]!, {
            maxRows: queryMaxRows,
            executionId: execId,
            sessionId: tabId,
          });
          recordStatement(stmts[i]!);
          totalMs += r.executionMs ?? 0;
          update(i, { status: "success", result: r });
        } catch (e) {
          recordStatement(stmts[i]!, true);
          const cancelled = cancelRequestedRef.current;
          failMessage = cancelled ? "查询已取消" : formatDbError(e);
          update(i, {
            status: "error",
            message: failMessage,
            onReconnect:
              !cancelled && isConnectionError(e) ? handleReconnect : undefined,
          });
          for (let j = i + 1; j < stmts.length; j++) {
            update(j, { status: "skipped" });
          }
          break;
        }
      }

      currentExecutionRef.current = null;
      cancelRequestedRef.current = false;
      setRunning(false);

      if (saveQueryHistory) {
        const totalAffected = outcomes.reduce(
          (sum, o) => sum + (o.result?.affectedRows ?? 0),
          0,
        );
        saveHistoryMutation.mutate({
          connectionId,
          connectionName: conn?.name ?? connectionId,
          sql: wholeSql,
          status: failMessage ? "error" : "success",
          rowsAffected: failMessage ? null : totalAffected,
          executionMs: totalMs,
          errorMessage: failMessage ?? undefined,
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      connectionId,
      tabId,
      conn?.name,
      saveQueryHistory,
      queryMaxRows,
      handleReconnect,
      ensureSession,
      recordStatement,
    ],
  );

  useEffect(
    () => () => {
      cancelRequestedRef.current = true;
      const executionId = currentExecutionRef.current;
      void (async () => {
        if (executionId) await cancelQuery(executionId).catch(() => {});
        await closeQuerySession(connectionId, tabId);
      })().catch(() => {});
    },
    [connectionId, tabId],
  );

  const runQuery = useCallback(
    (sqlToRun: string) => {
      if (currentExecutionRef.current || contextBusy) return;
      const trimmed = sqlToRun.trim();
      if (!trimmed) return;
      const stmts = splitStatements(trimmed, dbType);
      if (stmts.length === 0) return;
      if (
        confirmDml &&
        stmts.some(needsWriteConfirmation) &&
        !window.confirm(
          `即将在 ${conn?.name ?? connectionId} 执行可能修改数据或结构的 SQL（${stmts.length} 条）。\n${trimmed.slice(0, 1200)}\n确认执行？`,
        )
      )
        return;

      // Multi-statement scripts run sequentially with one result tab each.
      // Parameter binding is only supported for single-statement runs.
      if (stmts.length > 1) {
        void doExecuteMulti(stmts, trimmed);
        return;
      }

      const single = stmts[0]!;
      const { params } = detectParams(single);
      if (params.length > 0) {
        pendingSqlRef.current = single;
        setPendingParams(params);
        setParamDialogOpen(true);
      } else {
        void doExecute(single);
      }
    },
    [
      doExecute,
      doExecuteMulti,
      dbType,
      confirmDml,
      conn?.name,
      connectionId,
      contextBusy,
    ],
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
      if (currentExecutionRef.current || contextBusy) return;
      const sql = (editorRef.current?.getSelection() ?? "").trim();
      if (!sql) return;
      if (
        analyze &&
        confirmDml &&
        needsWriteConfirmation(sql) &&
        !window.confirm("ANALYZE 将实际执行该 SQL，可能修改数据。确认执行？")
      )
        return;
      const executionId = newExecutionId();
      currentExecutionRef.current = executionId;
      cancelRequestedRef.current = false;
      setExplaining(true);
      setResultMode("explain");
      try {
        await ensureSession();
        const result = await explainQuery(connectionId, sql, analyze, {
          sessionId: tabId,
          executionId,
        });
        setExplainResult(result);
        setExplainAnalyzed(analyze);
      } catch (e) {
        setExplainResult(null);
        setResultMode("query");
        setResultState({
          status: "error",
          message: `EXPLAIN 失败: ${formatDbError(e)}`,
          onReconnect: isConnectionError(e) ? handleReconnect : undefined,
        });
      } finally {
        currentExecutionRef.current = null;
        cancelRequestedRef.current = false;
        setExplaining(false);
      }
    },
    [
      connectionId,
      tabId,
      handleReconnect,
      confirmDml,
      ensureSession,
      contextBusy,
    ],
  );

  // Stop: cancel the in-flight query on the server (KILL QUERY /
  // pg_cancel_backend via a second connection). The running executeQuery
  // promise then rejects and doExecute's catch renders the result.
  const handleStop = async () => {
    const id = currentExecutionRef.current;
    if (!id) return;
    cancelRequestedRef.current = true;
    try {
      await cancelQuery(id);
    } catch {
      // 查询可能刚好结束；在途 promise 会自行返回，无需处理
    }
  };

  // sql-formatter — passed to SqlEditor so Shift+Alt+F works inside CM too
  const handleFormat = useCallback(
    async (sqlText: string): Promise<string> => {
      try {
        const { format: formatSql } = await import("sql-formatter");
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

  const handleFormatClick = async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const original = editor.getValue();
    const formatted = await handleFormat(original);
    if (editor.getValue() === original) editor.setValue(formatted);
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

  const initialSql = getContent(tabId);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        {!poolOpen && (
          <Button
            variant="outline"
            size="sm"
            disabled={!conn || contextBusy}
            onClick={async () => {
              setContextBusy(true);
              try {
                await handleReconnect();
              } catch (error) {
                setResultState({
                  status: "error",
                  message: formatDbError(error),
                });
              } finally {
                setContextBusy(false);
              }
            }}
          >
            连接数据库
          </Button>
        )}
        {running || explaining ? (
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
            disabled={contextBusy}
            onClick={handleRun}
          >
            <Play className="size-3" />
            执行当前 / 选区
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={running || explaining}
          onClick={() => {
            setResultMode("query");
            runQuery(editorRef.current?.getValue() ?? "");
          }}
        >
          执行全部
        </Button>
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
          Cmd+Enter 当前/选区 · SQL 草稿自动保存
        </span>
        <div className="flex-1" />

        <select
          aria-label="查询数据库"
          value={database}
          disabled={running || explaining || contextBusy}
          onChange={(e) => void changeContext(e.target.value, "")}
          className="max-w-48 rounded border bg-background px-2 py-1 text-xs"
        >
          <option value="">连接默认数据库</option>
          {databases.map((db) => (
            <option key={db} value={db}>
              {db}
            </option>
          ))}
        </select>
        {dbType === "postgres" && (
          <select
            aria-label="查询 schema"
            value={schema}
            disabled={running || explaining || contextBusy}
            onChange={(e) => void changeContext(database, e.target.value)}
            className="max-w-40 rounded border bg-background px-2 py-1 text-xs"
          >
            <option value="">默认 search_path</option>
            {schemas.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {transaction !== "idle" && (
          <span className="rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
            {transaction === "error"
              ? "显式事务中 · 有错误，请回滚"
              : "显式事务中 · 尚未提交"}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          disabled={running || explaining || contextBusy}
          onClick={() => runQuery("COMMIT")}
        >
          提交事务
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          disabled={running || explaining || contextBusy}
          onClick={() => runQuery("ROLLBACK")}
        >
          回滚事务
        </Button>
        {conn && (
          <span className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            <Database className="size-3" />
            {conn.name}
            {database || conn.database ? ` · ${database || conn.database}` : ""}
          </span>
        )}
      </div>

      <QuerySplit
        editor={
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
        }
      >
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
      </QuerySplit>

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
        initialSql={
          snippetCreateMode ? (editorRef.current?.getValue() ?? "") : ""
        }
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

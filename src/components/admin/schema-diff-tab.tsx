import { useState, useCallback } from "react";
import {
  Loader2,
  ArrowRight,
  GitCompare,
  AlertCircle,
  Copy,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useConnections } from "@/hooks/use-connections";
import {
  listDatabases,
  listSchemas,
  listObjects,
} from "@/services/tauri-commands";
import { getTableDesignerState } from "@/lib/designer-loader";
import { generateCreateTable, generateAlterTable } from "@/lib/generate-ddl";
import { diffLines, buildHunks } from "@/lib/line-diff";
import type { DatabaseType } from "@/types/database";
import type { DesignerState } from "@/types/designer";
import type { DiffLine } from "@/lib/line-diff";

// ─── Side state ───────────────────────────────────────────────────

interface SideState {
  connectionId: string;
  dbType: DatabaseType;
  database: string;
  schema: string;
  table: string;
  databases: string[];
  schemas: string[];
  tables: string[];
}

function emptySide(): SideState {
  return {
    connectionId: "",
    dbType: "mysql",
    database: "",
    schema: "",
    table: "",
    databases: [],
    schemas: [],
    tables: [],
  };
}

// ─── Side selector component ──────────────────────────────────────

interface SideSelectorProps {
  label: string;
  state: SideState;
  onChange: (patch: Partial<SideState>) => void;
}

function SideSelector({ label, state, onChange }: SideSelectorProps) {
  const { data: connections = [] } = useConnections();
  const [loading, setLoading] = useState(false);

  const handleConnectionChange = useCallback(
    async (connectionId: string) => {
      const conn = connections.find((c) => c.id === connectionId);
      const dbType: DatabaseType = conn?.dbType ?? "mysql";
      onChange({ connectionId, dbType, database: "", schema: "", table: "", databases: [], schemas: [], tables: [] });
      if (!connectionId) return;
      setLoading(true);
      try {
        const dbs = await listDatabases(connectionId);
        onChange({ databases: dbs });
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    },
    [connections, onChange],
  );

  const handleDatabaseChange = useCallback(
    async (database: string) => {
      onChange({ database, schema: "", table: "", schemas: [], tables: [] });
      if (!database) return;
      setLoading(true);
      try {
        if (state.dbType === "postgres") {
          const schemas = await listSchemas(state.connectionId, database);
          onChange({ schemas });
        } else {
          const objs = await listObjects(state.connectionId, database, undefined);
          onChange({ tables: objs.tables });
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    },
    [state.connectionId, state.dbType, onChange],
  );

  const handleSchemaChange = useCallback(
    async (schema: string) => {
      onChange({ schema, table: "", tables: [] });
      if (!schema) return;
      setLoading(true);
      try {
        const objs = await listObjects(state.connectionId, state.database, schema);
        onChange({ tables: objs.tables });
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    },
    [state.connectionId, state.database, onChange],
  );

  const selectClass =
    "h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary disabled:opacity-50";

  return (
    <div className="flex flex-col gap-3 flex-1 min-w-0">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {label}
      </p>

      {/* Connection */}
      <div>
        <label className="mb-1 block text-[11px] text-muted-foreground">连接</label>
        <select
          className={selectClass}
          value={state.connectionId}
          onChange={(e) => handleConnectionChange(e.target.value)}
        >
          <option value="">— 选择连接 —</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Database */}
      <div>
        <label className="mb-1 block text-[11px] text-muted-foreground">数据库</label>
        <select
          className={selectClass}
          disabled={!state.connectionId || state.databases.length === 0}
          value={state.database}
          onChange={(e) => handleDatabaseChange(e.target.value)}
        >
          <option value="">— 选择数据库 —</option>
          {state.databases.map((db) => (
            <option key={db} value={db}>{db}</option>
          ))}
        </select>
      </div>

      {/* Schema (PG only) */}
      {state.dbType === "postgres" && (
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">Schema</label>
          <select
            className={selectClass}
            disabled={!state.database || state.schemas.length === 0}
            value={state.schema}
            onChange={(e) => handleSchemaChange(e.target.value)}
          >
            <option value="">— 选择 Schema —</option>
            {state.schemas.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      )}

      {/* Table */}
      <div>
        <label className="mb-1 block text-[11px] text-muted-foreground">表名</label>
        <select
          className={selectClass}
          disabled={!state.database || state.tables.length === 0}
          value={state.table}
          onChange={(e) => onChange({ table: e.target.value })}
        >
          <option value="">— 选择表 —</option>
          {state.tables.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          加载中…
        </div>
      )}
    </div>
  );
}

// ─── Diff view ────────────────────────────────────────────────────

function DiffView({ lines }: { lines: DiffLine[] }) {
  const hunks = buildHunks(lines, 3);
  if (hunks.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-sm text-green-600 dark:text-green-400">
        <GitCompare className="size-4" />
        两张表结构完全相同
      </div>
    );
  }
  return (
    <div className="font-mono text-xs">
      {hunks.map((hunk, hi) => (
        <div key={hi} className="border-b border-border/30">
          {hunk.lines.map((line, li) => (
            <div
              key={li}
              className={cn(
                "flex gap-0 whitespace-pre",
                line.kind === "added" && "bg-green-500/10 text-green-700 dark:text-green-400",
                line.kind === "removed" && "bg-red-500/10 text-red-700 dark:text-red-400",
                line.kind === "same" && "text-muted-foreground",
              )}
            >
              {/* Line numbers */}
              <span className="w-10 shrink-0 select-none border-r border-border/30 px-1 text-right text-[10px] text-muted-foreground/50">
                {line.leftNo ?? " "}
              </span>
              <span className="w-10 shrink-0 select-none border-r border-border/30 px-1 text-right text-[10px] text-muted-foreground/50">
                {line.rightNo ?? " "}
              </span>
              {/* Sign */}
              <span className="w-5 shrink-0 select-none text-center">
                {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
              </span>
              {/* Content */}
              <span className="flex-1 px-1">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Sync SQL panel ───────────────────────────────────────────────

function SyncSqlPanel({
  srcState,
  tgtState,
  dbType,
}: {
  srcState: DesignerState;
  tgtState: DesignerState;
  dbType: DatabaseType;
}) {
  const [open, setOpen] = useState(false);
  const stmts = generateAlterTable(tgtState, srcState, dbType);

  const sql = stmts.join("\n\n");

  const handleCopy = () => {
    navigator.clipboard.writeText(sql);
  };

  return (
    <div className="border-t border-border">
      <button
        className="flex w-full items-center gap-2 px-4 py-2.5 text-xs font-medium hover:bg-muted/40"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        同步 SQL（将目标表同步为来源结构）
        <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {stmts.length} 条语句
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4">
          {stmts.length === 0 ? (
            <p className="text-xs text-green-600 dark:text-green-400">
              结构相同，无需同步
            </p>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 text-[11px]"
                  onClick={handleCopy}
                >
                  <Copy className="size-3" />
                  复制
                </Button>
              </div>
              <pre className="overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-5 whitespace-pre">
                {sql}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SchemaDiffTab ────────────────────────────────────────────────

export function SchemaDiffTab() {
  const [left, setLeft] = useState<SideState>(emptySide());
  const [right, setRight] = useState<SideState>(emptySide());
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffLines_, setDiffLines] = useState<DiffLine[] | null>(null);
  const [leftState, setLeftState] = useState<DesignerState | null>(null);
  const [rightState, setRightState] = useState<DesignerState | null>(null);

  const patchLeft = useCallback((patch: Partial<SideState>) => {
    setLeft((s) => ({ ...s, ...patch }));
    setDiffLines(null);
  }, []);

  const patchRight = useCallback((patch: Partial<SideState>) => {
    setRight((s) => ({ ...s, ...patch }));
    setDiffLines(null);
  }, []);

  const canCompare =
    left.connectionId && left.database && left.table &&
    right.connectionId && right.database && right.table;

  const handleCompare = async () => {
    if (!canCompare) return;
    setComparing(true);
    setError(null);
    setDiffLines(null);
    try {
      const [ls, rs] = await Promise.all([
        getTableDesignerState(
          left.connectionId, left.database,
          left.dbType === "postgres" ? (left.schema || "public") : undefined,
          left.table, left.dbType,
        ),
        getTableDesignerState(
          right.connectionId, right.database,
          right.dbType === "postgres" ? (right.schema || "public") : undefined,
          right.table, right.dbType,
        ),
      ]);
      setLeftState(ls);
      setRightState(rs);
      const leftDdl = generateCreateTable(ls, left.dbType);
      const rightDdl = generateCreateTable(rs, right.dbType);
      setDiffLines(diffLines(leftDdl, rightDdl));
    } catch (e) {
      setError(String(e));
    } finally {
      setComparing(false);
    }
  };

  // Determine sync SQL dbType: use left side's dbType
  const syncDbType = left.dbType;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Top: table selectors */}
      <div className="shrink-0 border-b border-border px-4 py-4">
        <div className="flex items-start gap-4">
          <SideSelector label="来源（左）" state={left} onChange={patchLeft} />

          <div className="flex shrink-0 items-center pt-8">
            <ArrowRight className="size-5 text-muted-foreground" />
          </div>

          <SideSelector label="目标（右）" state={right} onChange={patchRight} />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={!canCompare || comparing}
            onClick={handleCompare}
          >
            {comparing ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                对比中…
              </>
            ) : (
              <>
                <GitCompare className="size-3.5" />
                比较结构
              </>
            )}
          </Button>

          {diffLines_ !== null && (
            <span className="text-xs text-muted-foreground">
              {diffLines_.filter((l) => l.kind !== "same").length === 0
                ? "结构完全相同"
                : `${diffLines_.filter((l) => l.kind === "added").length} 行增加，${diffLines_.filter((l) => l.kind === "removed").length} 行删除`}
            </span>
          )}
        </div>

        {error && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="size-3" />
            {error}
          </div>
        )}
      </div>

      {/* Diff area */}
      {diffLines_ !== null && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Column headers */}
          <div className="flex shrink-0 border-b border-border bg-muted/50 text-[11px] font-medium text-muted-foreground">
            <span className="w-10 shrink-0" />
            <span className="w-10 shrink-0" />
            <span className="w-5 shrink-0" />
            <span className="flex-1 px-2 py-1.5">
              {left.table} @ {left.database}
            </span>
            <span className="w-px bg-border" />
            <span className="flex-1 px-2 py-1.5">
              {right.table} @ {right.database}
            </span>
          </div>

          <div className="flex-1 overflow-auto">
            <DiffView lines={diffLines_} />
          </div>

          {/* Sync SQL */}
          {leftState && rightState && (
            <SyncSqlPanel
              srcState={leftState}
              tgtState={rightState}
              dbType={syncDbType}
            />
          )}
        </div>
      )}

      {/* Empty state */}
      {diffLines_ === null && !comparing && !error && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <GitCompare className="size-10 opacity-20" />
          <p className="text-sm">选择两张表后点击"比较结构"</p>
        </div>
      )}
    </div>
  );
}

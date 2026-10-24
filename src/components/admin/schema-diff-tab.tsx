import { useState, useCallback, useMemo } from "react";
import {
  Loader2,
  ArrowRight,
  GitCompare,
  AlertCircle,
  Copy,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  FileCode,
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
import { formatDbError } from "@/lib/error";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useEditorStore } from "@/stores/editor-store";
import { quoteIdent } from "@/lib/sql-literal";

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
  /** Whole-database mode: pick connection / database / schema only. */
  withTable: boolean;
}

function SideSelector({
  label,
  state,
  onChange,
  withTable,
}: SideSelectorProps) {
  const { data: connections = [] } = useConnections();
  const [loading, setLoading] = useState(false);

  const handleConnectionChange = useCallback(
    async (connectionId: string) => {
      const conn = connections.find((c) => c.id === connectionId);
      const dbType: DatabaseType = conn?.dbType ?? "mysql";
      onChange({
        connectionId,
        dbType,
        database: "",
        schema: "",
        table: "",
        databases: [],
        schemas: [],
        tables: [],
      });
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
          const objs = await listObjects(
            state.connectionId,
            database,
            undefined,
          );
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
        const objs = await listObjects(
          state.connectionId,
          state.database,
          schema,
        );
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
        <label className="mb-1 block text-[11px] text-muted-foreground">
          连接
        </label>
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
        <label className="mb-1 block text-[11px] text-muted-foreground">
          数据库
        </label>
        <select
          className={selectClass}
          disabled={!state.connectionId || state.databases.length === 0}
          value={state.database}
          onChange={(e) => handleDatabaseChange(e.target.value)}
        >
          <option value="">— 选择数据库 —</option>
          {state.databases.map((db) => (
            <option key={db} value={db}>
              {db}
            </option>
          ))}
        </select>
      </div>

      {/* Schema (PG only) */}
      {state.dbType === "postgres" && (
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">
            Schema
          </label>
          <select
            className={selectClass}
            disabled={!state.database || state.schemas.length === 0}
            value={state.schema}
            onChange={(e) => handleSchemaChange(e.target.value)}
          >
            <option value="">— 选择 Schema —</option>
            {state.schemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Table */}
      {withTable && (
        <div>
          <label className="mb-1 block text-[11px] text-muted-foreground">
            表名
          </label>
          <select
            className={selectClass}
            disabled={!state.database || state.tables.length === 0}
            value={state.table}
            onChange={(e) => onChange({ table: e.target.value })}
          >
            <option value="">— 选择表 —</option>
            {state.tables.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}

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
                line.kind === "added" &&
                  "bg-green-500/10 text-green-700 dark:text-green-400",
                line.kind === "removed" &&
                  "bg-red-500/10 text-red-700 dark:text-red-400",
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
                {line.kind === "added"
                  ? "+"
                  : line.kind === "removed"
                    ? "−"
                    : " "}
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
  schema,
}: {
  srcState: DesignerState;
  tgtState: DesignerState;
  dbType: DatabaseType;
  schema?: string;
}) {
  const [open, setOpen] = useState(false);
  const stmts = generateAlterTable(tgtState, srcState, dbType, schema);

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
        {open ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRightIcon className="size-3.5" />
        )}
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

// ─── Whole-database compare ───────────────────────────────────────

type TableStatus = "added" | "removed" | "changed" | "same";

interface TableDiff {
  table: string;
  status: TableStatus;
  left?: DesignerState;
  right?: DesignerState;
  /** Statements that make the target table match the source. */
  sync: string[];
}

const STATUS_LABEL: Record<TableStatus, string> = {
  added: "仅来源有",
  removed: "仅目标有",
  changed: "结构不同",
  same: "相同",
};

const STATUS_CLASS: Record<TableStatus, string> = {
  added: "bg-green-500/15 text-green-700 dark:text-green-400",
  removed: "bg-red-500/15 text-red-700 dark:text-red-400",
  changed: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  same: "bg-muted text-muted-foreground",
};

/** Runs `work` over `items`, at most `limit` at a time. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function schemaOf(side: SideState) {
  return side.dbType === "postgres" ? side.schema || "public" : undefined;
}

async function listSideTables(side: SideState) {
  const objs = await listObjects(
    side.connectionId,
    side.database,
    schemaOf(side),
  );
  return objs.tables;
}

async function compareDatabases(
  left: SideState,
  right: SideState,
  onProgress: (done: number, total: number) => void,
): Promise<TableDiff[]> {
  const [leftTables, rightTables] = await Promise.all([
    listSideTables(left),
    listSideTables(right),
  ]);
  const rightSet = new Set(rightTables);
  const leftSet = new Set(leftTables);
  const names = [...new Set([...leftTables, ...rightTables])].sort((a, b) =>
    a.localeCompare(b),
  );
  const load = (side: SideState, table: string) =>
    getTableDesignerState(
      side.connectionId,
      side.database,
      schemaOf(side),
      table,
      side.dbType,
    );
  const tgtSchema = schemaOf(right);
  let done = 0;
  onProgress(0, names.length);
  const diffs = await mapLimited(names, 4, async (table) => {
    let diff: TableDiff;
    if (!rightSet.has(table)) {
      const l = await load(left, table);
      diff = {
        table,
        status: "added",
        left: l,
        sync: [generateCreateTable(l, right.dbType, tgtSchema)],
      };
    } else if (!leftSet.has(table)) {
      const r = await load(right, table);
      const ref =
        right.dbType === "postgres"
          ? `${quoteIdent(tgtSchema!, "postgres")}.${quoteIdent(table, "postgres")}`
          : quoteIdent(table, "mysql");
      diff = {
        table,
        status: "removed",
        right: r,
        sync: [`DROP TABLE ${ref};`],
      };
    } else {
      const [l, r] = await Promise.all([load(left, table), load(right, table)]);
      const sync = generateAlterTable(r, l, right.dbType, tgtSchema);
      diff = {
        table,
        status: sync.length > 0 ? "changed" : "same",
        left: l,
        right: r,
        sync,
      };
    }
    onProgress(++done, names.length);
    return diff;
  });
  return diffs;
}

function DatabaseDiffView({
  diffs,
  left,
  right,
}: {
  diffs: TableDiff[];
  left: SideState;
  right: SideState;
}) {
  const [onlyDifferent, setOnlyDifferent] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  // Dropping tables that exist only in the target loses data: opt-in.
  const [included, setIncluded] = useState<Set<string>>(
    () =>
      new Set(
        diffs
          .filter((d) => d.status === "added" || d.status === "changed")
          .map((d) => d.table),
      ),
  );
  const [copied, setCopied] = useState(false);
  const addTab = useWorkspaceStore((s) => s.addTab);
  const setContent = useEditorStore((s) => s.setContent);

  const counts = useMemo(() => {
    const c: Record<TableStatus, number> = {
      added: 0,
      removed: 0,
      changed: 0,
      same: 0,
    };
    for (const d of diffs) c[d.status]++;
    return c;
  }, [diffs]);
  const shown = onlyDifferent
    ? diffs.filter((d) => d.status !== "same")
    : diffs;
  const current = diffs.find((d) => d.table === selected);
  const currentLines = useMemo(
    () =>
      current
        ? diffLines(
            current.left ? generateCreateTable(current.left, left.dbType) : "",
            current.right
              ? generateCreateTable(current.right, right.dbType)
              : "",
          )
        : null,
    [current, left.dbType, right.dbType],
  );
  const syncSql = diffs
    .filter((d) => included.has(d.table) && d.sync.length > 0)
    .map(
      (d) => `-- ${d.table}（${STATUS_LABEL[d.status]}）\n${d.sync.join("\n")}`,
    )
    .join("\n\n");

  const toggle = (table: string) =>
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(table)) next.delete(table);
      else next.add(table);
      return next;
    });

  const openInQuery = () => {
    const tabId = `query-${right.connectionId}-sync-${Date.now()}`;
    setContent(tabId, syncSql);
    addTab({
      id: tabId,
      title: `同步 ${right.database}`,
      type: "query",
      connectionId: right.connectionId,
      metadata: { database: right.database, schema: schemaOf(right) },
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        {(["added", "removed", "changed", "same"] as const).map((st) => (
          <span
            key={st}
            className={cn("rounded px-1.5 py-0.5", STATUS_CLASS[st])}
          >
            {STATUS_LABEL[st]} {counts[st]}
          </span>
        ))}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyDifferent}
            onChange={(e) => setOnlyDifferent(e.target.checked)}
            className="size-3 accent-primary"
          />
          只显示有差异的表
        </label>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Table list */}
        <div className="w-72 shrink-0 overflow-auto border-r border-border">
          {shown.length === 0 && (
            <p className="px-4 py-6 text-sm text-green-600 dark:text-green-400">
              两个库的表结构完全相同
            </p>
          )}
          {shown.map((d) => (
            <div
              key={d.table}
              className={cn(
                "flex cursor-pointer items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs hover:bg-muted/40",
                selected === d.table && "bg-primary/10",
              )}
              onClick={() => setSelected(d.table)}
            >
              <input
                type="checkbox"
                className="size-3 accent-primary"
                title="包含在同步 SQL 中"
                disabled={d.sync.length === 0}
                checked={included.has(d.table)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggle(d.table)}
              />
              <span className="min-w-0 flex-1 truncate font-mono">
                {d.table}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                  STATUS_CLASS[d.status],
                )}
              >
                {STATUS_LABEL[d.status]}
              </span>
            </div>
          ))}
        </div>

        {/* Selected table's DDL diff */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {currentLines ? (
            <>
              <div className="flex shrink-0 border-b border-border bg-muted/50 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
                {current!.table}：左 {left.database} → 右 {right.database}
              </div>
              <div className="flex-1 overflow-auto">
                <DiffView lines={currentLines} />
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              点击左侧的表查看结构差异
            </div>
          )}
        </div>
      </div>

      {/* Combined sync SQL */}
      <div className="max-h-[40%] shrink-0 overflow-auto border-t border-border px-4 py-3">
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="font-medium">同步 SQL（让目标库与来源一致）</span>
          <span className="text-muted-foreground">
            已选{" "}
            {
              [...included].filter(
                (t) => diffs.find((d) => d.table === t)?.sync.length,
              ).length
            }{" "}
            张表；勾选"仅目标有"的表会生成 DROP TABLE
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-6 gap-1 text-[11px]"
            disabled={!syncSql}
            onClick={async () => {
              await navigator.clipboard.writeText(syncSql);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy className="size-3" />
            {copied ? "已复制" : "复制"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 text-[11px]"
            disabled={!syncSql}
            onClick={openInQuery}
            title="在目标连接的新查询标签中打开，检查后再执行"
          >
            <FileCode className="size-3" />
            在查询中打开
          </Button>
        </div>
        {syncSql ? (
          <pre className="overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-5 whitespace-pre">
            {syncSql}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">没有需要同步的语句</p>
        )}
      </div>
    </div>
  );
}

// ─── SchemaDiffTab ────────────────────────────────────────────────

export function SchemaDiffTab() {
  const [mode, setMode] = useState<"table" | "database">("table");
  const [left, setLeft] = useState<SideState>(emptySide());
  const [right, setRight] = useState<SideState>(emptySide());
  const [comparing, setComparing] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffLines_, setDiffLines] = useState<DiffLine[] | null>(null);
  const [leftState, setLeftState] = useState<DesignerState | null>(null);
  const [rightState, setRightState] = useState<DesignerState | null>(null);
  const [dbDiffs, setDbDiffs] = useState<TableDiff[] | null>(null);

  const clearResults = () => {
    setDiffLines(null);
    setDbDiffs(null);
  };

  const patchLeft = useCallback((patch: Partial<SideState>) => {
    setLeft((s) => ({ ...s, ...patch }));
    setDiffLines(null);
    setDbDiffs(null);
  }, []);

  const patchRight = useCallback((patch: Partial<SideState>) => {
    setRight((s) => ({ ...s, ...patch }));
    setDiffLines(null);
    setDbDiffs(null);
  }, []);

  const sideReady = (side: SideState) =>
    !!side.connectionId &&
    !!side.database &&
    (mode === "database" || !!side.table);
  const canCompare = sideReady(left) && sideReady(right);

  const handleCompare = async () => {
    if (!canCompare) return;
    setComparing(true);
    setError(null);
    clearResults();
    try {
      if (mode === "database") {
        setDbDiffs(
          await compareDatabases(left, right, (done, total) =>
            setProgress({ done, total }),
          ),
        );
        return;
      }
      const [ls, rs] = await Promise.all([
        getTableDesignerState(
          left.connectionId,
          left.database,
          schemaOf(left),
          left.table,
          left.dbType,
        ),
        getTableDesignerState(
          right.connectionId,
          right.database,
          schemaOf(right),
          right.table,
          right.dbType,
        ),
      ]);
      setLeftState(ls);
      setRightState(rs);
      const leftDdl = generateCreateTable(ls, left.dbType);
      const rightDdl = generateCreateTable(rs, right.dbType);
      setDiffLines(diffLines(leftDdl, rightDdl));
    } catch (e) {
      setError(formatDbError(e));
    } finally {
      setComparing(false);
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Top: selectors */}
      <div className="shrink-0 border-b border-border px-4 py-4">
        <div className="mb-3 flex w-fit rounded-md border border-border p-0.5 text-xs">
          {(
            [
              ["table", "单表对比"],
              ["database", "整库对比"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={cn(
                "rounded px-3 py-1",
                mode === value
                  ? "bg-primary/15 font-medium text-primary"
                  : "hover:bg-muted",
              )}
              onClick={() => {
                setMode(value);
                clearResults();
                setError(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-start gap-4">
          <SideSelector
            label="来源（左）"
            state={left}
            onChange={patchLeft}
            withTable={mode === "table"}
          />

          <div className="flex shrink-0 items-center pt-8">
            <ArrowRight className="size-5 text-muted-foreground" />
          </div>

          <SideSelector
            label="目标（右）"
            state={right}
            onChange={patchRight}
            withTable={mode === "table"}
          />
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
                对比中{progress ? ` ${progress.done}/${progress.total}` : "…"}
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
          {mode === "database" &&
            left.dbType !== right.dbType &&
            left.connectionId &&
            right.connectionId && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                两侧数据库类型不同，同步 SQL 按目标库生成，类型映射需人工检查
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

      {/* Whole-database result */}
      {mode === "database" && dbDiffs && (
        <DatabaseDiffView diffs={dbDiffs} left={left} right={right} />
      )}

      {/* Diff area */}
      {mode === "table" && diffLines_ !== null && (
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

          {/* Sync SQL — runs on the target, so in its dialect */}
          {leftState && rightState && (
            <SyncSqlPanel
              srcState={leftState}
              tgtState={rightState}
              dbType={right.dbType}
              schema={schemaOf(right)}
            />
          )}
        </div>
      )}

      {/* Empty state */}
      {diffLines_ === null && dbDiffs === null && !comparing && !error && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <GitCompare className="size-10 opacity-20" />
          <p className="text-sm">
            {mode === "table"
              ? '选择两张表后点击"比较结构"'
              : '选择两个数据库（PostgreSQL 还需选择 Schema，默认 public）后点击"比较结构"'}
          </p>
        </div>
      )}
    </div>
  );
}

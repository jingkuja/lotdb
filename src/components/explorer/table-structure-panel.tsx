import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, AlertCircle, Key, Hash, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useTableColumns,
  useTableIndexes,
  useTableForeignKeys,
} from "@/hooks/use-table-structure";

interface Props {
  connectionId: string;
  database: string;
  schema?: string;
  table: string;
}

// ─── Shared table primitives ──────────────────────────────────────

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "sticky top-0 bg-muted/80 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground backdrop-blur",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={cn("px-3 py-1.5 text-xs", className)}>{children}</td>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      <span>加载中...</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-destructive">
      <AlertCircle className="size-4" />
      <span>{message}</span>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="p-4 text-center text-xs text-muted-foreground">{text}</div>
  );
}

// ─── Columns tab ──────────────────────────────────────────────────

function ColumnsTab({ connectionId, database, schema, table }: Props) {
  const { data: columns, isLoading, isError, error } = useTableColumns({
    connectionId,
    database,
    schema,
    table,
  });

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState message={String(error)} />;
  if (!columns?.length) return <EmptyState text="无列信息" />;

  return (
    <ScrollArea className="flex-1">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <Th className="w-6">{""}</Th>
            <Th>列名</Th>
            <Th>类型</Th>
            <Th>可空</Th>
            <Th>默认值</Th>
            <Th>备注</Th>
            <Th>额外</Th>
          </tr>
        </thead>
        <tbody>
          {columns.map((col, i) => (
            <tr
              key={col.name}
              className={cn(
                "border-b border-border/50 hover:bg-muted/30",
                i % 2 === 0 ? "bg-background" : "bg-muted/10",
              )}
            >
              <Td className="text-center">
                {col.isPrimaryKey && (
                  <Key className="inline size-3 text-amber-500" />
                )}
              </Td>
              <Td className="font-mono font-medium">{col.name}</Td>
              <Td className="font-mono text-blue-600 dark:text-blue-400">
                {col.dataType}
              </Td>
              <Td>
                <span
                  className={cn(
                    "rounded px-1 py-0.5 text-[10px]",
                    col.nullable
                      ? "bg-muted text-muted-foreground"
                      : "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
                  )}
                >
                  {col.nullable ? "YES" : "NO"}
                </span>
              </Td>
              <Td className="font-mono text-muted-foreground">
                {col.defaultValue ?? <span className="italic opacity-40">NULL</span>}
              </Td>
              <Td className="text-muted-foreground">{col.comment ?? ""}</Td>
              <Td className="text-muted-foreground">{col.extra ?? ""}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

// ─── Indexes tab ──────────────────────────────────────────────────

function IndexesTab({ connectionId, database, schema, table }: Props) {
  const { data: indexes, isLoading, isError, error } = useTableIndexes({
    connectionId,
    database,
    schema,
    table,
  });

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState message={String(error)} />;
  if (!indexes?.length) return <EmptyState text="无索引信息" />;

  return (
    <ScrollArea className="flex-1">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <Th>索引名</Th>
            <Th>列</Th>
            <Th>类型</Th>
            <Th>唯一</Th>
            <Th>主键</Th>
          </tr>
        </thead>
        <tbody>
          {indexes.map((idx, i) => (
            <tr
              key={idx.name}
              className={cn(
                "border-b border-border/50 hover:bg-muted/30",
                i % 2 === 0 ? "bg-background" : "bg-muted/10",
              )}
            >
              <Td className="font-mono">
                <span className="flex items-center gap-1">
                  {idx.primary && <Key className="size-3 text-amber-500" />}
                  {idx.name}
                </span>
              </Td>
              <Td className="font-mono text-muted-foreground">
                {idx.columns.join(", ")}
              </Td>
              <Td>{idx.indexType}</Td>
              <Td>
                {idx.unique && (
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    YES
                  </span>
                )}
              </Td>
              <Td>
                {idx.primary && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                    YES
                  </span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

// ─── Foreign Keys tab ─────────────────────────────────────────────

function ForeignKeysTab({ connectionId, database, schema, table }: Props) {
  const { data: fks, isLoading, isError, error } = useTableForeignKeys({
    connectionId,
    database,
    schema,
    table,
  });

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState message={String(error)} />;
  if (!fks?.length) return <EmptyState text="无外键" />;

  return (
    <ScrollArea className="flex-1">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <Th>约束名</Th>
            <Th>本表列</Th>
            <Th>{""}</Th>
            <Th>引用表</Th>
            <Th>引用列</Th>
            <Th>ON UPDATE</Th>
            <Th>ON DELETE</Th>
          </tr>
        </thead>
        <tbody>
          {fks.map((fk, i) => (
            <tr
              key={fk.name}
              className={cn(
                "border-b border-border/50 hover:bg-muted/30",
                i % 2 === 0 ? "bg-background" : "bg-muted/10",
              )}
            >
              <Td className="font-mono">{fk.name}</Td>
              <Td className="font-mono text-muted-foreground">
                {fk.columns.join(", ")}
              </Td>
              <Td>
                <ArrowRight className="size-3 text-muted-foreground" />
              </Td>
              <Td className="font-mono font-medium">{fk.refTable}</Td>
              <Td className="font-mono text-muted-foreground">
                {fk.refColumns.join(", ")}
              </Td>
              <Td>
                <RuleChip rule={fk.onUpdate} />
              </Td>
              <Td>
                <RuleChip rule={fk.onDelete} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function RuleChip({ rule }: { rule: string }) {
  const color =
    rule === "CASCADE"
      ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
      : rule === "SET NULL"
        ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
        : "bg-muted text-muted-foreground";
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px]", color)}>
      {rule}
    </span>
  );
}

// ─── TableStructurePanel — exported component ─────────────────────

export function TableStructurePanel({ connectionId, database, schema, table }: Props) {
  const qualifier = [schema, table].filter(Boolean).join(".");
  const dbLabel = schema ? `${database} › ${qualifier}` : `${database}.${table}`;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <Hash className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{dbLabel}</span>
        <span className="ml-auto rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          结构
        </span>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="columns" className="flex flex-1 flex-col overflow-hidden">
        <TabsList className="mx-4 mt-2 w-auto self-start">
          <TabsTrigger value="columns">列</TabsTrigger>
          <TabsTrigger value="indexes">索引</TabsTrigger>
          <TabsTrigger value="foreign-keys">外键</TabsTrigger>
        </TabsList>

        <TabsContent
          value="columns"
          className="mt-2 flex flex-1 flex-col overflow-hidden"
        >
          <ColumnsTab
            connectionId={connectionId}
            database={database}
            schema={schema}
            table={table}
          />
        </TabsContent>

        <TabsContent
          value="indexes"
          className="mt-2 flex flex-1 flex-col overflow-hidden"
        >
          <IndexesTab
            connectionId={connectionId}
            database={database}
            schema={schema}
            table={table}
          />
        </TabsContent>

        <TabsContent
          value="foreign-keys"
          className="mt-2 flex flex-1 flex-col overflow-hidden"
        >
          <ForeignKeysTab
            connectionId={connectionId}
            database={database}
            schema={schema}
            table={table}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Database,
  Layers,
  Table2,
  Eye,
  FunctionSquare,
  Folder,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDatabases, useSchemas, useObjects } from "@/hooks/use-schema";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { DatabaseType } from "@/types/database";

// ─── TreeRow — generic row with indent, icon, label ──────────────

interface TreeRowProps {
  level: number;
  icon: React.ReactNode;
  label: string;
  expanded?: boolean;
  expandable?: boolean;
  loading?: boolean;
  error?: boolean;
  active?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  children?: React.ReactNode;
}

function TreeRow({
  level,
  icon,
  label,
  expanded,
  expandable,
  loading,
  error,
  active,
  onClick,
  onDoubleClick,
}: TreeRowProps) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded py-[2px] text-xs cursor-pointer select-none",
        "hover:bg-sidebar-accent/60",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
        error && "text-destructive",
      )}
      style={{ paddingLeft: `${level * 14 + 4}px`, paddingRight: "4px" }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* Chevron */}
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {loading ? (
          <Loader2 className="size-3 animate-spin" />
        ) : expandable ? (
          expanded ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )
        ) : null}
      </span>

      {/* Icon */}
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center",
          error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {error ? <AlertCircle className="size-3" /> : icon}
      </span>

      {/* Label */}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </div>
  );
}

// ─── ObjectLeaf — table / view / function ─────────────────────────

interface ObjectLeafProps {
  name: string;
  type: "table" | "view" | "function";
  level: number;
  connectionId: string;
  database: string;
  schema?: string;
}

function ObjectLeaf({
  name,
  type,
  level,
  connectionId,
  database,
  schema,
}: ObjectLeafProps) {
  const addTab = useWorkspaceStore((s) => s.addTab);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);

  const tabId = [connectionId, database, schema, type, name]
    .filter(Boolean)
    .join("/");

  const icon =
    type === "table" ? (
      <Table2 className="size-3" />
    ) : type === "view" ? (
      <Eye className="size-3" />
    ) : (
      <FunctionSquare className="size-3" />
    );

  const handleOpen = () => {
    const existing = tabs.find((t) => t.id === tabId);
    if (existing) {
      setActiveTab(tabId);
    } else {
      addTab({
        id: tabId,
        title: name,
        type: type === "table" ? "table-structure" : "query",
        connectionId,
        metadata: { database, schema, objectName: name, objectType: type },
      });
    }
  };

  return (
    <TreeRow
      level={level}
      icon={icon}
      label={name}
      expandable={false}
      onClick={handleOpen}
      onDoubleClick={handleOpen}
    />
  );
}

// ─── CategoryNode — "Tables" / "Views" / "Functions" folder ───────

interface CategoryNodeProps {
  label: string;
  items: string[];
  type: "table" | "view" | "function";
  level: number;
  connectionId: string;
  database: string;
  schema?: string;
}

function CategoryNode({
  label,
  items,
  type,
  level,
  connectionId,
  database,
  schema,
}: CategoryNodeProps) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 0) return null;

  return (
    <>
      <TreeRow
        level={level}
        icon={<Folder className="size-3" />}
        label={`${label} (${items.length})`}
        expandable
        expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded &&
        items.map((name) => (
          <ObjectLeaf
            key={name}
            name={name}
            type={type}
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
        ))}
    </>
  );
}

// ─── SchemaNode — PG schema, loads objects on expand ──────────────

interface SchemaNodeProps {
  schema: string;
  database: string;
  connectionId: string;
  level: number;
}

function SchemaNode({ schema, database, connectionId, level }: SchemaNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, isError } = useObjects(
    connectionId,
    database,
    schema,
    expanded,
  );

  return (
    <>
      <TreeRow
        level={level}
        icon={<Layers className="size-3" />}
        label={schema}
        expandable
        expanded={expanded}
        loading={expanded && isLoading}
        error={isError}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded && data && (
        <>
          <CategoryNode
            label="Tables"
            items={data.tables}
            type="table"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
          <CategoryNode
            label="Views"
            items={data.views}
            type="view"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
          <CategoryNode
            label="Functions"
            items={data.functions}
            type="function"
            level={level + 1}
            connectionId={connectionId}
            database={database}
            schema={schema}
          />
        </>
      )}
    </>
  );
}

// ─── MySqlDbNode — MySQL database, loads objects directly ─────────

interface MySqlDbNodeProps {
  database: string;
  connectionId: string;
  level: number;
}

function MySqlDbNode({ database, connectionId, level }: MySqlDbNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, isError } = useObjects(
    connectionId,
    database,
    undefined,
    expanded,
  );

  return (
    <>
      <TreeRow
        level={level}
        icon={<Database className="size-3" />}
        label={database}
        expandable
        expanded={expanded}
        loading={expanded && isLoading}
        error={isError}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded && data && (
        <>
          <CategoryNode
            label="Tables"
            items={data.tables}
            type="table"
            level={level + 1}
            connectionId={connectionId}
            database={database}
          />
          <CategoryNode
            label="Views"
            items={data.views}
            type="view"
            level={level + 1}
            connectionId={connectionId}
            database={database}
          />
          <CategoryNode
            label="Functions"
            items={data.functions}
            type="function"
            level={level + 1}
            connectionId={connectionId}
            database={database}
          />
        </>
      )}
    </>
  );
}

// ─── PgDbNode — PG database (= current db), loads schemas ─────────

interface PgDbNodeProps {
  database: string;
  connectionId: string;
  level: number;
}

function PgDbNode({ database, connectionId, level }: PgDbNodeProps) {
  // Auto-expand since PG always shows a single database
  const [expanded, setExpanded] = useState(true);
  const { data: schemas = [], isLoading, isError } = useSchemas(
    connectionId,
    database,
    expanded,
  );

  return (
    <>
      <TreeRow
        level={level}
        icon={<Database className="size-3" />}
        label={database}
        expandable
        expanded={expanded}
        loading={expanded && isLoading}
        error={isError}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded &&
        schemas.map((schema) => (
          <SchemaNode
            key={schema}
            schema={schema}
            database={database}
            connectionId={connectionId}
            level={level + 1}
          />
        ))}
    </>
  );
}

// ─── ObjectTree — top-level export ───────────────────────────────

interface ObjectTreeProps {
  connectionId: string;
  dbType: DatabaseType;
}

export function ObjectTree({ connectionId, dbType }: ObjectTreeProps) {
  const { data: databases = [], isLoading, isError } = useDatabases(connectionId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        <span>加载中...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-destructive">
        <AlertCircle className="size-3" />
        <span>加载失败</span>
      </div>
    );
  }

  return (
    <div className="py-0.5">
      {databases.map((db) =>
        dbType === "mysql" ? (
          <MySqlDbNode
            key={db}
            database={db}
            connectionId={connectionId}
            level={1}
          />
        ) : (
          <PgDbNode
            key={db}
            database={db}
            connectionId={connectionId}
            level={1}
          />
        ),
      )}
    </div>
  );
}

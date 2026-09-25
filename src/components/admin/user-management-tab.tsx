import { useState, useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Plus,
  Trash2,
  ShieldCheck,
  ShieldOff,
  User,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listUsers,
  getUserGrants,
  createUser,
  dropUser,
  grantPrivilege,
  revokePrivilege,
  listDatabases,
  type UserInfo,
  type DbPrivilege,
} from "@/services/tauri-commands";
import type { DatabaseType } from "@/types/database";

// ─── Create user form (inline panel) ─────────────────────────────

interface CreateUserFormProps {
  connectionId: string;
  dbType: DatabaseType;
  onSuccess: () => void;
  onCancel: () => void;
}

function CreateUserForm({
  connectionId,
  dbType,
  onSuccess,
  onCancel,
}: CreateUserFormProps) {
  const [username, setUsername] = useState("");
  const [host, setHost] = useState("%");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await createUser(connectionId, username.trim(), host.trim(), password);
      onSuccess();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3"
    >
      <p className="text-xs font-medium text-muted-foreground">
        {dbType === "mysql" ? "新建用户" : "新建角色"}
      </p>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="mb-1 block text-[10px] text-muted-foreground">
            {dbType === "mysql" ? "用户名" : "角色名"}
          </label>
          <Input
            autoFocus
            className="h-7 text-xs font-mono"
            placeholder={dbType === "mysql" ? "newuser" : "newrole"}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        {dbType === "mysql" && (
          <div className="w-28">
            <label className="mb-1 block text-[10px] text-muted-foreground">
              Host
            </label>
            <Input
              className="h-7 text-xs font-mono"
              placeholder="%"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          </div>
        )}
      </div>
      <div>
        <label className="mb-1 block text-[10px] text-muted-foreground">
          密码{dbType === "postgres" && "（可留空）"}
        </label>
        <Input
          type="password"
          className="h-7 text-xs"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && (
        <p className="rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          className="h-7 flex-1 text-xs"
          disabled={loading || !username.trim()}
        >
          {loading ? <Loader2 className="size-3 animate-spin" /> : "创建"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={onCancel}
        >
          取消
        </Button>
      </div>
    </form>
  );
}

// ─── User list (left panel) ───────────────────────────────────────

interface UserListProps {
  connectionId: string;
  dbType: DatabaseType;
  users: UserInfo[];
  selectedUser: UserInfo | null;
  onSelect: (user: UserInfo) => void;
  onRefresh: () => void;
}

function UserList({
  connectionId,
  dbType,
  users,
  selectedUser,
  onSelect,
  onRefresh,
}: UserListProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [dropping, setDropping] = useState<string | null>(null);

  const handleDrop = async (user: UserInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    const label =
      dbType === "mysql" ? `${user.username}@${user.host}` : user.username;
    if (
      !confirm(
        `确定要删除${dbType === "mysql" ? "用户" : "角色"} "${label}" 吗？`,
      )
    )
      return;
    const key = `${user.username}@${user.host}`;
    setDropping(key);
    try {
      await dropUser(connectionId, user.username, user.host);
      onRefresh();
    } catch (err) {
      alert(String(err));
    } finally {
      setDropping(null);
    }
  };

  return (
    <div className="flex w-52 shrink-0 flex-col border-r border-border">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          {dbType === "mysql" ? "用户" : "角色"} ({users.length})
        </span>
        <div className="flex gap-1">
          <button
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="刷新"
            onClick={onRefresh}
          >
            <RefreshCw className="size-3" />
          </button>
          <button
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={dbType === "mysql" ? "新建用户" : "新建角色"}
            onClick={() => setShowCreate((v) => !v)}
          >
            <Plus className="size-3" />
          </button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="border-b border-border p-2">
          <CreateUserForm
            connectionId={connectionId}
            dbType={dbType}
            onSuccess={() => {
              setShowCreate(false);
              onRefresh();
            }}
            onCancel={() => setShowCreate(false)}
          />
        </div>
      )}

      {/* User rows */}
      <div className="flex-1 overflow-auto py-0.5">
        {users.map((user) => {
          const key = `${user.username}@${user.host}`;
          const isSelected =
            selectedUser?.username === user.username &&
            selectedUser?.host === user.host;
          const isDropping = dropping === key;

          return (
            <div
              key={key}
              className={cn(
                "group flex cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-xs",
                "hover:bg-sidebar-accent/60",
                isSelected &&
                  "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              onClick={() => onSelect(user)}
            >
              <User className="size-3 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono font-medium">
                  {user.username}
                </p>
                {dbType === "mysql" && (
                  <p className="truncate text-[10px] text-muted-foreground">
                    @{user.host}
                  </p>
                )}
                {dbType === "postgres" && !user.canLogin && (
                  <p className="text-[10px] text-muted-foreground">no login</p>
                )}
              </div>
              {user.isSuper && (
                <span title="超级用户">
                  <ShieldCheck className="size-3 shrink-0 text-amber-500" />
                </span>
              )}
              <button
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                title="删除"
                onClick={(e) => handleDrop(user, e)}
                disabled={isDropping}
              >
                {isDropping ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Trash2 className="size-3" />
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Database privilege row ───────────────────────────────────────

interface DbPrivRowProps {
  dbName: string;
  grant: DbPrivilege | undefined;
  connectionId: string;
  username: string;
  host: string;
  onRefresh: () => void;
}

function DbPrivRow({
  dbName,
  grant,
  connectionId,
  username,
  host,
  onRefresh,
}: DbPrivRowProps) {
  const [loading, setLoading] = useState<"grant" | "revoke" | null>(null);

  const handleGrant = async () => {
    setLoading("grant");
    try {
      await grantPrivilege(connectionId, username, host, dbName);
      onRefresh();
    } catch (err) {
      alert(String(err));
    } finally {
      setLoading(null);
    }
  };

  const handleRevoke = async () => {
    if (!confirm(`撤销 ${username} 对数据库 "${dbName}" 的权限？`)) return;
    setLoading("revoke");
    try {
      await revokePrivilege(connectionId, username, host, dbName);
      onRefresh();
    } catch (err) {
      alert(String(err));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-border/50 px-3 py-1.5 last:border-b-0 hover:bg-muted/30">
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        {dbName}
      </span>
      {grant ? (
        <>
          <div className="flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400">
            <CheckCircle2 className="size-3" />
            <span className="max-w-[120px] truncate">{grant.privileges}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[11px] text-destructive hover:bg-destructive/10"
            disabled={loading !== null}
            onClick={handleRevoke}
          >
            {loading === "revoke" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              "撤销"
            )}
          </Button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ShieldOff className="size-3" />
            <span>无权限</span>
          </div>
          <Button
            size="sm"
            className="h-6 text-[11px]"
            disabled={loading !== null}
            onClick={handleGrant}
          >
            {loading === "grant" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              "授权"
            )}
          </Button>
        </>
      )}
    </div>
  );
}

// ─── User detail (right panel) ────────────────────────────────────

interface UserDetailProps {
  connectionId: string;
  dbType: DatabaseType;
  user: UserInfo;
}

function UserDetail({ connectionId, dbType, user }: UserDetailProps) {
  const queryClient = useQueryClient();

  const grantsKey = useMemo(
    () => ["user-grants", connectionId, user.username, user.host],
    [connectionId, user.username, user.host],
  );
  const dbsKey = ["databases", connectionId];

  const {
    data: grants = [],
    isLoading: grantsLoading,
    isError: grantsError,
  } = useQuery({
    queryKey: grantsKey,
    queryFn: () => getUserGrants(connectionId, user.username, user.host),
    staleTime: 10_000,
  });

  const { data: databases = [], isLoading: dbsLoading } = useQuery({
    queryKey: dbsKey,
    queryFn: () => listDatabases(connectionId),
    staleTime: 30_000,
  });

  const refreshGrants = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: grantsKey });
  }, [queryClient, grantsKey]);

  const grantMap = new Map(grants.map((g) => [g.database, g]));

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* User header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <User className="size-4 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium font-mono">
            {user.username}
            {dbType === "mysql" && (
              <span className="text-muted-foreground">@{user.host}</span>
            )}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            {user.isSuper && (
              <span className="flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                <ShieldCheck className="size-3" />
                超级用户
              </span>
            )}
            {dbType === "postgres" && (
              <span className="text-[10px] text-muted-foreground">
                {user.canLogin ? "可登录" : "不可登录"}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Database privileges */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-xs font-medium text-muted-foreground">
            数据库权限
          </span>
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={refreshGrants}
            title="刷新权限"
          >
            <RefreshCw className="size-3" />
          </button>
        </div>

        {(grantsLoading || dbsLoading) && (
          <div className="flex items-center gap-1.5 px-4 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            加载中…
          </div>
        )}

        {grantsError && (
          <div className="flex items-center gap-1.5 px-4 py-3 text-xs text-destructive">
            <AlertCircle className="size-3" />
            加载权限失败
          </div>
        )}

        {!grantsLoading && !dbsLoading && !grantsError && (
          <div className="flex-1 overflow-auto">
            {databases.length === 0 ? (
              <p className="px-4 py-3 text-xs text-muted-foreground">
                没有数据库
              </p>
            ) : (
              databases.map((db) => (
                <DbPrivRow
                  key={db}
                  dbName={db}
                  grant={grantMap.get(db)}
                  connectionId={connectionId}
                  username={user.username}
                  host={user.host}
                  onRefresh={refreshGrants}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── UserManagementTab — top-level export ─────────────────────────

interface UserManagementTabProps {
  connectionId: string;
  dbType: DatabaseType;
}

export function UserManagementTab({
  connectionId,
  dbType,
}: UserManagementTabProps) {
  const queryClient = useQueryClient();
  const [selectedUser, setSelectedUser] = useState<UserInfo | null>(null);

  const usersKey = useMemo(() => ["users", connectionId], [connectionId]);
  const {
    data: users = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: usersKey,
    queryFn: () => listUsers(connectionId),
    staleTime: 15_000,
  });

  const refreshUsers = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: usersKey });
    setSelectedUser(null);
  }, [queryClient, usersKey]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="size-5 animate-spin opacity-50" />
        <span className="text-sm">加载用户列表…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-destructive">
        <AlertCircle className="size-5" />
        <span className="text-sm">加载失败</span>
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <UserList
        connectionId={connectionId}
        dbType={dbType}
        users={users}
        selectedUser={selectedUser}
        onSelect={setSelectedUser}
        onRefresh={refreshUsers}
      />

      {selectedUser ? (
        <UserDetail
          key={`${selectedUser.username}@${selectedUser.host}`}
          connectionId={connectionId}
          dbType={dbType}
          user={selectedUser}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <User className="size-10 opacity-20" />
          <p className="text-sm">
            选择{dbType === "mysql" ? "用户" : "角色"}查看权限
          </p>
        </div>
      )}
    </div>
  );
}

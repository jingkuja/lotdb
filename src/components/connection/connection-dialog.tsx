import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { useConnectionGroups } from "@/hooks/use-connections";
import { Loader2 } from "lucide-react";

const DEFAULT_PORTS: Record<DatabaseType, number> = {
  mysql: 3306,
  postgres: 5432,
};

interface ConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ConnectionConfig;
  onSave: (config: ConnectionConfig) => void;
  onTest: (config: ConnectionConfig) => Promise<string>;
}

export function ConnectionDialog({
  open,
  onOpenChange,
  initial,
  onSave,
  onTest,
}: ConnectionDialogProps) {
  const isEdit = !!initial;

  // General
  const [dbType, setDbType] = useState<DatabaseType>(
    initial?.dbType ?? "mysql",
  );
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "127.0.0.1");
  const [port, setPort] = useState(initial?.port ?? DEFAULT_PORTS.mysql);
  const [user, setUser] = useState(initial?.user ?? "root");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [readonly, setReadonly] = useState(initial?.readonly ?? false);
  const [groupId, setGroupId] = useState(initial?.groupId ?? "__none__");
  const { data: groups = [] } = useConnectionGroups();

  // SSH
  const [sshEnabled, setSshEnabled] = useState(!!initial?.ssh);
  const [sshFingerprint, setSshFingerprint] = useState(initial?.ssh?.hostKeyFingerprint ?? "");
  const [sshHost, setSshHost] = useState(initial?.ssh?.host ?? "");
  const [sshPort, setSshPort] = useState(initial?.ssh?.port ?? 22);
  const [sshUser, setSshUser] = useState(initial?.ssh?.user ?? "");
  const [sshPassword, setSshPassword] = useState(initial?.ssh?.password ?? "");
  const [sshAuthType, setSshAuthType] = useState<"password" | "key">(
    (initial?.ssh?.authType as "password" | "key") ?? "password",
  );
  const [sshKeyPath, setSshKeyPath] = useState(
    initial?.ssh?.privateKeyPath ?? "",
  );

  // SSL
  const [sslEnabled, setSslEnabled] = useState(
    initial?.ssl?.enabled ?? false,
  );
  const [sslCaPath, setSslCaPath] = useState(initial?.ssl?.caPath ?? "");
  const [sslCertPath, setSslCertPath] = useState(
    initial?.ssl?.clientCertPath ?? "",
  );
  const [sslKeyPath, setSslKeyPath] = useState(
    initial?.ssl?.clientKeyPath ?? "",
  );

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const handleDbTypeChange = (value: DatabaseType) => {
    setDbType(value);
    setPort(DEFAULT_PORTS[value]);
    if (value === "postgres" && user === "root") setUser("postgres");
    else if (value === "mysql" && user === "postgres") setUser("root");
  };

  const buildConfig = (): ConnectionConfig => ({
    id: initial?.id ?? crypto.randomUUID(),
    name: name || `${host}:${port}`,
    dbType,
    host,
    port,
    user,
    password,
    database: database || undefined,
    readonly,
    groupId: groupId !== "__none__" ? groupId : undefined,
    ssh: sshEnabled
      ? {
          host: sshHost,
          hostKeyFingerprint: sshFingerprint.trim() || undefined,
          port: sshPort,
          user: sshUser,
          authType: sshAuthType,
          password: sshAuthType === "password" ? sshPassword || undefined : undefined,
          privateKeyPath: sshAuthType === "key" ? sshKeyPath || undefined : undefined,
        }
      : undefined,
    ssl: {
      enabled: sslEnabled,
      caPath: sslCaPath || undefined,
      clientCertPath: sslCertPath || undefined,
      clientKeyPath: sslKeyPath || undefined,
    },
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await onTest(buildConfig());
      setTestResult(result);
    } catch (e) {
      setTestResult(String(e));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    onSave(buildConfig());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑连接" : "新建连接"}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="general" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="general">常规</TabsTrigger>
            <TabsTrigger value="ssh">SSH</TabsTrigger>
            <TabsTrigger value="ssl">SSL</TabsTrigger>
          </TabsList>

          {/* ── General ── */}
          <TabsContent value="general" className="space-y-4 pt-4">
            <div className="grid grid-cols-[100px_1fr] items-center gap-3">
              <Label>类型</Label>
              <Select value={dbType} onValueChange={handleDbTypeChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mysql">MySQL</SelectItem>
                  <SelectItem value="postgres">PostgreSQL</SelectItem>
                </SelectContent>
              </Select>

              <Label>连接名称</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="可选，默认使用 host:port"
              />

              <Label>主机</Label>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="127.0.0.1"
              />

              <Label>端口</Label>
              <Input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />

              <Label>用户名</Label>
              <Input value={user} onChange={(e) => setUser(e.target.value)} />

              <Label>密码</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />

              <Label>数据库</Label>
              <Input
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder="可选"
              />

              <Label>分组</Label>
              <Select value={groupId} onValueChange={setGroupId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不分组</SelectItem>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label>只读模式</Label>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="readonly-enabled"
                  className="size-4"
                  checked={readonly}
                  onChange={(e) => setReadonly(e.target.checked)}
                />
                <span className="text-xs text-muted-foreground">
                  拦截数据及结构变更；修改连接设置后需重新连接
                </span>
              </div>
            </div>
          </TabsContent>

          {/* ── SSH ── */}
          <TabsContent value="ssh" className="space-y-4 pt-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="ssh-enabled"
                checked={sshEnabled}
                onChange={(e) => setSshEnabled(e.target.checked)}
                className="size-4 rounded border"
              />
              <Label htmlFor="ssh-enabled">使用 SSH 隧道</Label>
            </div>

            {sshEnabled && (
              <div className="grid grid-cols-[100px_1fr] items-center gap-3">
                <Label>SSH 主机</Label>
                <Input value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
                <Label htmlFor="ssh-fingerprint">服务器指纹（可选）</Label>
                <Input id="ssh-fingerprint" value={sshFingerprint} onChange={e => setSshFingerprint(e.target.value)} placeholder="SHA256:…" />
                <p className="text-xs text-muted-foreground">默认校验 ~/.ssh/known_hosts；也可填写通过可信渠道确认的 SHA256 指纹。未知或变更的主机密钥会被拒绝。</p>

                <Label>SSH 端口</Label>
                <Input
                  type="number"
                  value={sshPort}
                  onChange={(e) => setSshPort(Number(e.target.value))}
                />

                <Label>SSH 用户</Label>
                <Input value={sshUser} onChange={(e) => setSshUser(e.target.value)} />

                <Label>认证方式</Label>
                <Select
                  value={sshAuthType}
                  onValueChange={(v) => setSshAuthType(v as "password" | "key")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="password">密码</SelectItem>
                    <SelectItem value="key">私钥</SelectItem>
                  </SelectContent>
                </Select>

                {sshAuthType === "password" ? (
                  <>
                    <Label>SSH 密码</Label>
                    <Input
                      type="password"
                      value={sshPassword}
                      onChange={(e) => setSshPassword(e.target.value)}
                    />
                  </>
                ) : (
                  <>
                    <Label>私钥路径</Label>
                    <Input
                      value={sshKeyPath}
                      onChange={(e) => setSshKeyPath(e.target.value)}
                      placeholder="/Users/you/.ssh/id_rsa"
                    />
                  </>
                )}
              </div>
            )}
          </TabsContent>

          {/* ── SSL ── */}
          <TabsContent value="ssl" className="space-y-4 pt-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="ssl-enabled"
                checked={sslEnabled}
                onChange={(e) => setSslEnabled(e.target.checked)}
                className="size-4 rounded border"
              />
              <Label htmlFor="ssl-enabled">使用 SSL/TLS 加密连接</Label>
            </div>

            {sslEnabled && (
              <div className="grid grid-cols-[110px_1fr] items-center gap-3">
                <Label>CA 证书</Label>
                <Input
                  value={sslCaPath}
                  onChange={(e) => setSslCaPath(e.target.value)}
                  placeholder="/path/to/ca.pem（可选）"
                />

                <Label>客户端证书</Label>
                <Input
                  value={sslCertPath}
                  onChange={(e) => setSslCertPath(e.target.value)}
                  placeholder="/path/to/client-cert.pem（可选）"
                />

                <Label>客户端密钥</Label>
                <Input
                  value={sslKeyPath}
                  onChange={(e) => setSslKeyPath(e.target.value)}
                  placeholder="/path/to/client-key.pem（可选）"
                />

                <div className="col-span-2 text-xs text-muted-foreground">
                  {sslCaPath
                    ? "模式：VerifyCA（验证服务器证书）"
                    : "模式：Require（仅加密，不验证证书）"}
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>

        {testResult && (
          <div
            className={`rounded-md px-3 py-2 text-sm ${
              testResult === "连接成功"
                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
            }`}
          >
            {testResult}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing && <Loader2 className="animate-spin" />}
            测试连接
          </Button>
          <Button onClick={handleSave}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

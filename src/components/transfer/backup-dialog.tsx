import { useState, useCallback, useEffect } from "react";
import { Download, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { downloadDir, join } from "@tauri-apps/api/path";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { backupDatabase } from "@/services/tauri-commands";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface BackupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  database: string;
}

type ContentMode = "all" | "schema" | "data";

export function BackupDialog({
  open,
  onOpenChange,
  connectionId,
  database,
}: BackupDialogProps) {
  const [filePath, setFilePath] = useState("");
  const [contentMode, setContentMode] = useState<ContentMode>("all");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ size: number; stderr: string } | null>(null);

  // Pre-fill with downloads dir on open
  useEffect(() => {
    if (open && !filePath) {
      downloadDir().then((dir) =>
        join(dir, `${database}_backup.sql`).then(setFilePath),
      ).catch(() => {});
    }
  }, [open, database, filePath]);

  const resetState = () => {
    setRunning(false);
    setDone(false);
    setError(null);
    setResult(null);
    setFilePath("");
    setContentMode("all");
  };

  const handleBackup = useCallback(async () => {
    if (!filePath.trim()) {
      alert("请选择备份文件路径");
      return;
    }
    setRunning(true);
    setDone(false);
    setError(null);
    try {
      const res = await backupDatabase(
        connectionId,
        database,
        filePath,
        contentMode === "schema",
        contentMode === "data",
        [],
      );
      setResult({ size: res.sizeBytes, stderr: res.stderrOutput });
      setDone(true);
    } catch (e) {
      setError(String(e));
      setDone(true);
    } finally {
      setRunning(false);
    }
  }, [connectionId, database, filePath, contentMode]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!running) {
          onOpenChange(v);
          if (!v) resetState();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Download className="inline size-4 mr-1.5 mb-0.5" />
            备份数据库 — {database}
          </DialogTitle>
        </DialogHeader>

        {!done ? (
          <div className="flex flex-col gap-4">
            {/* File path */}
            <div>
              <Label className="text-xs mb-1 block">输出文件（绝对路径）</Label>
              <Input
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="/path/to/backup.sql"
                className="h-8 text-xs"
                disabled={running}
              />
            </div>

            {/* Content mode */}
            <div>
              <Label className="text-xs mb-1.5 block">备份内容</Label>
              <div className="flex gap-2">
                {(
                  [
                    { value: "all", label: "结构 + 数据" },
                    { value: "schema", label: "仅结构" },
                    { value: "data", label: "仅数据" },
                  ] as { value: ContentMode; label: string }[]
                ).map((opt) => (
                  <label
                    key={opt.value}
                    className="flex items-center gap-1.5 cursor-pointer select-none text-xs"
                  >
                    <input
                      type="radio"
                      name="content-mode"
                      checked={contentMode === opt.value}
                      onChange={() => setContentMode(opt.value)}
                      disabled={running}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              使用 mysqldump / pg_dump 执行备份，需要本机已安装对应 CLI 工具。
            </p>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
                取消
              </Button>
              <Button onClick={handleBackup} disabled={running || !filePath}>
                {running ? (
                  <><Loader2 className="size-3.5 mr-1.5 animate-spin" />备份中…</>
                ) : (
                  "开始备份"
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            {error ? (
              <div className="flex items-start gap-2 text-destructive">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">备份失败</span>
                  <span className="text-xs whitespace-pre-wrap break-all">{error}</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="size-4 shrink-0" />
                  <span className="text-sm font-medium">备份完成</span>
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p>文件：{filePath}</p>
                  <p>大小：{result ? formatBytes(result.size) : "—"}</p>
                </div>
                {result?.stderr && (
                  <pre className="max-h-24 overflow-auto rounded bg-muted p-2 text-[10px] text-muted-foreground whitespace-pre-wrap">
                    {result.stderr}
                  </pre>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={resetState}>再次备份</Button>
              <Button onClick={() => { onOpenChange(false); resetState(); }}>关闭</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

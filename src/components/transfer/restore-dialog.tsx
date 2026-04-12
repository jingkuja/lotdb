import { useState, useCallback } from "react";
import { Upload, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
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
import { restoreDatabase } from "@/services/tauri-commands";

interface RestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  database: string;
}

export function RestoreDialog({
  open,
  onOpenChange,
  connectionId,
  database,
}: RestoreDialogProps) {
  const [filePath, setFilePath] = useState("");
  const [createDb, setCreateDb] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stderr, setStderr] = useState("");

  const resetState = () => {
    setRunning(false);
    setDone(false);
    setError(null);
    setStderr("");
    setFilePath("");
    setCreateDb(false);
  };


  const handleRestore = useCallback(async () => {
    if (!filePath.trim()) {
      alert("请选择备份文件");
      return;
    }
    setRunning(true);
    setDone(false);
    setError(null);
    try {
      const res = await restoreDatabase(connectionId, database, filePath, createDb);
      setStderr(res.stderrOutput);
      setDone(true);
    } catch (e) {
      setError(String(e));
      setDone(true);
    } finally {
      setRunning(false);
    }
  }, [connectionId, database, filePath, createDb]);

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
            <Upload className="inline size-4 mr-1.5 mb-0.5" />
            恢复数据库 — {database}
          </DialogTitle>
        </DialogHeader>

        {!done ? (
          <div className="flex flex-col gap-4">
            {/* File path */}
            <div>
              <Label className="text-xs mb-1 block">备份文件（绝对路径）</Label>
              <Input
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="/path/to/backup.sql"
                className="h-8 text-xs"
                disabled={running}
              />
            </div>

            {/* Options */}
            <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={createDb}
                onChange={(e) => setCreateDb(e.target.checked)}
                disabled={running}
              />
              恢复前自动创建数据库（仅 MySQL）
            </label>

            <div className="rounded border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-2 text-[11px] text-amber-700 dark:text-amber-400">
              警告：恢复操作会覆盖目标数据库中的数据，请确认后再执行。
            </div>

            <p className="text-[11px] text-muted-foreground">
              使用 mysql / psql 执行恢复，需要本机已安装对应 CLI 工具。
            </p>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={handleRestore}
                disabled={running || !filePath}
              >
                {running ? (
                  <><Loader2 className="size-3.5 mr-1.5 animate-spin" />恢复中…</>
                ) : (
                  "开始恢复"
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
                  <span className="text-sm font-medium">恢复失败</span>
                  <span className="text-xs whitespace-pre-wrap break-all">{error}</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="size-4 shrink-0" />
                  <span className="text-sm font-medium">恢复完成</span>
                </div>
                {stderr && (
                  <pre className="max-h-32 overflow-auto rounded bg-muted p-2 text-[10px] text-muted-foreground whitespace-pre-wrap">
                    {stderr}
                  </pre>
                )}
              </div>
            )}
            <DialogFooter>
              <Button onClick={() => { onOpenChange(false); resetState(); }}>关闭</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Upload, Check, AlertCircle, Loader2 } from "lucide-react";
import { getConnections, importConnections } from "@/services/tauri-commands";
import type { ConnectionConfig } from "@/types/database";
import { useQueryClient } from "@tanstack/react-query";

interface ImportExportConnectionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Tab = "export" | "import";

export function ImportExportConnectionsDialog({
  open,
  onOpenChange,
}: ImportExportConnectionsDialogProps) {
  const [tab, setTab] = useState<Tab>("export");

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportDone, setExportDone] = useState(false);

  // Import state
  const [preview, setPreview] = useState<ConnectionConfig[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const handleExport = async () => {
    setExporting(true);
    try {
      const conns = await getConnections();
      // Strip passwords before export
      const sanitized = conns.map((c) => ({ ...c, password: "" }));
      const json = JSON.stringify(sanitized, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "lotdb-connections.json";
      a.click();
      URL.revokeObjectURL(url);
      setExportDone(true);
      setTimeout(() => setExportDone(false), 2000);
    } catch (e) {
      console.error(e);
    } finally {
      setExporting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setImportResult(null);
    setPreview(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as unknown;
        if (!Array.isArray(parsed)) throw new Error("文件格式错误：顶层应为数组");
        setPreview(parsed as ConnectionConfig[]);
      } catch (err) {
        setImportError(String(err));
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!preview) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await importConnections(preview);
      setImportResult(result);
      await qc.invalidateQueries({ queryKey: ["connections"] });
      setPreview(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      setImportError(String(e));
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    setPreview(null);
    setImportError(null);
    setImportResult(null);
    setExportDone(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>连接配置导入/导出</DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-border">
          {(["export", "import"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-xs font-medium transition-colors ${
                tab === t
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "export" ? "导出" : "导入"}
            </button>
          ))}
        </div>

        {tab === "export" && (
          <div className="flex flex-col gap-4 py-2">
            <p className="text-xs text-muted-foreground">
              将所有连接配置导出为 JSON 文件。密码不会包含在导出文件中。
            </p>
            <Button onClick={handleExport} disabled={exporting} className="gap-2 self-start">
              {exporting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : exportDone ? (
                <Check className="size-4 text-emerald-500" />
              ) : (
                <Download className="size-4" />
              )}
              {exportDone ? "已导出" : "导出连接配置"}
            </Button>
          </div>
        )}

        {tab === "import" && (
          <div className="flex flex-col gap-4 py-2">
            <p className="text-xs text-muted-foreground">
              从 JSON 文件导入连接配置。已存在（ID 相同）的连接将被跳过。
            </p>

            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="size-4" />
                选择文件
              </Button>
              {preview && (
                <span className="text-xs text-muted-foreground">
                  已读取 {preview.length} 条连接
                </span>
              )}
            </div>

            {importError && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                {importError}
              </div>
            )}

            {importResult && (
              <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="size-3.5 shrink-0" />
                导入完成：{importResult.imported} 条已导入，{importResult.skipped} 条已跳过
              </div>
            )}

            {preview && preview.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-[11px] font-medium text-muted-foreground">预览（前 10 条）</p>
                <div className="max-h-40 overflow-y-auto rounded-md border border-border text-xs">
                  {preview.slice(0, 10).map((c, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-0"
                    >
                      <span
                        className={`flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white ${
                          c.dbType === "mysql" ? "bg-blue-600" : "bg-sky-700"
                        }`}
                      >
                        {c.dbType === "mysql" ? "M" : "P"}
                      </span>
                      <span className="flex-1 truncate font-medium">{c.name}</span>
                      <span className="text-muted-foreground">
                        {c.host}:{c.port}
                      </span>
                    </div>
                  ))}
                  {preview.length > 10 && (
                    <div className="px-3 py-1.5 text-muted-foreground">
                      …还有 {preview.length - 10} 条
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={handleClose}>
                关闭
              </Button>
              <Button
                size="sm"
                onClick={handleImport}
                disabled={!preview || preview.length === 0 || importing}
                className="gap-2"
              >
                {importing && <Loader2 className="size-3.5 animate-spin" />}
                确认导入
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, Loader2, AlertCircle, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sqls: string[];
  onCommit: () => Promise<void>;
}

export function ChangePreviewDialog({ open, onOpenChange, sqls, onCommit }: Props) {
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const handleCommit = async () => {
    setStatus("running");
    setErrorMsg("");
    try {
      await onCommit();
      setStatus("done");
      // Auto-close after short delay on success
      setTimeout(() => { onOpenChange(false); setStatus("idle"); }, 800);
    } catch (e) {
      setStatus("error");
      setErrorMsg(String(e));
    }
  };

  const handleCopy = (sql: string, idx: number) => {
    void navigator.clipboard.writeText(sql);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  };

  const handleClose = () => {
    if (status === "running") return;
    setStatus("idle");
    setErrorMsg("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="flex max-h-[600px] flex-col gap-0 p-0 sm:max-w-[680px]">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm">
            变更预览 — {sqls.length} 条 SQL
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 px-4 py-3">
          <div className="flex flex-col gap-2">
            {sqls.map((sql, idx) => (
              <div
                key={idx}
                className="group relative rounded-md border border-border bg-muted/40 px-3 py-2"
              >
                <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                  {sql}
                </pre>
                <button
                  className="absolute right-2 top-2 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                  title="复制"
                  onClick={() => handleCopy(sql, idx)}
                >
                  {copiedIdx === idx ? (
                    <Check className="size-3 text-emerald-500" />
                  ) : (
                    <Copy className="size-3 text-muted-foreground" />
                  )}
                </button>
              </div>
            ))}
          </div>
        </ScrollArea>

        {status === "error" && (
          <div className="flex items-start gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="font-mono">{errorMsg}</span>
          </div>
        )}

        {status === "done" && (
          <div className="flex items-center gap-2 border-t border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-600 dark:text-emerald-400">
            <Check className="size-3.5" />
            提交成功
          </div>
        )}

        <DialogFooter className="border-t border-border px-4 py-3">
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={status === "running"}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleCommit}
            disabled={status === "running" || status === "done" || sqls.length === 0}
            className={cn("gap-1.5", status === "done" && "bg-emerald-600")}
          >
            {status === "running" ? (
              <><Loader2 className="size-3 animate-spin" />执行中…</>
            ) : status === "done" ? (
              <><Check className="size-3" />已提交</>
            ) : (
              "确认提交"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

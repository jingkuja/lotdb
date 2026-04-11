import { useState } from "react";
import { Copy, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { generateCreateTable, generateAlterTable } from "@/lib/generate-ddl";
import type { DesignerState } from "@/types/designer";
import type { DatabaseType } from "@/types/database";

interface DdlPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: DesignerState;
  /** If provided, generate ALTER TABLE (diff from original) instead of CREATE TABLE */
  originalState?: DesignerState;
  dbType: DatabaseType;
  /** PG schema, used for fully-qualified table references */
  schema?: string;
}

export function DdlPreviewDialog({
  open,
  onOpenChange,
  state,
  originalState,
  dbType,
  schema,
}: DdlPreviewDialogProps) {
  const [copied, setCopied] = useState(false);

  const isAlter = !!originalState;

  const sql = isAlter
    ? generateAlterTable(originalState!, state, dbType, schema).join("\n\n")
    : generateCreateTable(state, dbType, schema);

  const isEmpty = isAlter && sql.trim() === "";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[720px] max-w-[95vw] flex-col gap-0 p-0">
        <DialogHeader className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">
            {isAlter
              ? `DDL 预览 — ALTER TABLE \`${originalState!.tableName || "?"}\``
              : `DDL 预览 — CREATE TABLE`}
          </DialogTitle>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={isEmpty}
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <Check className="size-3 text-green-500" />
                已复制
              </>
            ) : (
              <>
                <Copy className="size-3" />
                复制
              </>
            )}
          </Button>
        </DialogHeader>

        <div className="flex-1 overflow-auto p-4">
          {isEmpty ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              与原始结构相比无变化
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
              {sql}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

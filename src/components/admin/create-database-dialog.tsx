import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createDatabase } from "@/services/tauri-commands";
import type { DatabaseType } from "@/types/database";

// MySQL charset/collation options
const MYSQL_CHARSETS = [
  { value: "utf8mb4", label: "utf8mb4 (推荐)" },
  { value: "utf8", label: "utf8" },
  { value: "latin1", label: "latin1" },
  { value: "ascii", label: "ascii" },
];

const MYSQL_COLLATIONS: Record<string, { value: string; label: string }[]> = {
  utf8mb4: [
    { value: "utf8mb4_unicode_ci", label: "utf8mb4_unicode_ci" },
    { value: "utf8mb4_general_ci", label: "utf8mb4_general_ci" },
    { value: "utf8mb4_bin", label: "utf8mb4_bin" },
    { value: "utf8mb4_0900_ai_ci", label: "utf8mb4_0900_ai_ci (MySQL 8+)" },
  ],
  utf8: [
    { value: "utf8_unicode_ci", label: "utf8_unicode_ci" },
    { value: "utf8_general_ci", label: "utf8_general_ci" },
    { value: "utf8_bin", label: "utf8_bin" },
  ],
  latin1: [
    { value: "latin1_swedish_ci", label: "latin1_swedish_ci" },
    { value: "latin1_bin", label: "latin1_bin" },
  ],
  ascii: [
    { value: "ascii_general_ci", label: "ascii_general_ci" },
    { value: "ascii_bin", label: "ascii_bin" },
  ],
};

interface CreateDatabaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  dbType: DatabaseType;
  onSuccess: () => void;
}

export function CreateDatabaseDialog({
  open,
  onOpenChange,
  connectionId,
  dbType,
  onSuccess,
}: CreateDatabaseDialogProps) {
  const [name, setName] = useState("");
  const [charset, setCharset] = useState("utf8mb4");
  const [collation, setCollation] = useState("utf8mb4_unicode_ci");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setCharset("utf8mb4");
    setCollation("utf8mb4_unicode_ci");
    setLoading(false);
    setError(null);
  }, [open]);

  // When charset changes, reset collation to first option of that charset
  const handleCharsetChange = (cs: string) => {
    setCharset(cs);
    const first = MYSQL_COLLATIONS[cs]?.[0]?.value ?? "";
    setCollation(first);
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("数据库名称不能为空");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await createDatabase(
        connectionId,
        trimmed,
        dbType === "mysql" ? charset : undefined,
        dbType === "mysql" ? collation : undefined,
      );
      onSuccess();
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !loading) handleCreate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[420px] max-w-[95vw] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-medium">新建数据库</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4 py-4">
          {/* Name */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              数据库名称
            </label>
            <Input
              autoFocus
              className="h-7 font-mono text-xs"
              placeholder="my_database"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>

          {/* MySQL-only: charset + collation */}
          {dbType === "mysql" && (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  字符集
                </label>
                <select
                  className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
                  value={charset}
                  onChange={(e) => handleCharsetChange(e.target.value)}
                >
                  {MYSQL_CHARSETS.map((cs) => (
                    <option key={cs.value} value={cs.value}>
                      {cs.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  排序规则
                </label>
                <select
                  className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
                  value={collation}
                  onChange={(e) => setCollation(e.target.value)}
                >
                  {(MYSQL_COLLATIONS[charset] ?? []).map((co) => (
                    <option key={co.value} value={co.value}>
                      {co.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* Error */}
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="border-t border-border px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={loading || !name.trim()}
            onClick={handleCreate}
          >
            {loading ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                创建中…
              </>
            ) : (
              "创建"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

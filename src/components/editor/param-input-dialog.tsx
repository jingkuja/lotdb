import { useState, useEffect } from "react";
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
import { Play } from "lucide-react";
import type { SqlParam } from "@/lib/sql-params";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  params: SqlParam[];
  onExecute: (values: (string | null)[]) => void;
}

export function ParamInputDialog({ open, onOpenChange, params, onExecute }: Props) {
  const [values, setValues] = useState<string[]>([]);

  // Reset when params change (new query)
  useEffect(() => {
    setValues(params.map(() => ""));
  }, [params]);

  const handleExecute = () => {
    // Treat empty string as NULL
    const bound = values.map((v) => (v.trim() === "" ? null : v));
    onExecute(bound);
    onOpenChange(false);
  };

  const set = (i: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setValues((prev) => {
      const next = [...prev];
      next[i] = e.target.value;
      return next;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleExecute();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]" onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle className="text-sm">填写查询参数</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          {params.map((param, i) => (
            <div key={param.index} className="grid gap-1.5">
              <Label className="font-mono text-xs text-muted-foreground">{param.label}</Label>
              <Input
                autoFocus={i === 0}
                value={values[i] ?? ""}
                onChange={set(i)}
                placeholder="留空视为 NULL"
                className="h-8 font-mono text-sm"
              />
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" onClick={handleExecute} className="gap-1.5">
            <Play className="size-3" />
            执行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

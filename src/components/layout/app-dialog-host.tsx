import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useAppDialogStore,
  type DialogRequest,
} from "@/stores/app-dialog-store";

/** Renders queued confirm / prompt / alert requests one at a time. */
export function AppDialogHost() {
  const current = useAppDialogStore((s) => s.queue[0]);
  if (!current) return null;
  return <RequestDialog key={current.id} request={current} />;
}

function RequestDialog({ request }: { request: DialogRequest }) {
  const settle = useAppDialogStore((s) => s.settle);
  const [value, setValue] = useState(
    request.kind === "prompt" ? (request.defaultValue ?? "") : "",
  );

  const finish = (ok: boolean) => {
    settle(request.id);
    if (request.kind === "confirm") request.resolve(ok);
    else if (request.kind === "prompt") request.resolve(ok ? value : null);
    else request.resolve();
  };

  const title =
    request.title ??
    (request.kind === "confirm"
      ? "请确认"
      : request.kind === "prompt"
        ? "请输入"
        : "提示");

  return (
    <Dialog open onOpenChange={(open) => !open && finish(false)}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="max-h-72 overflow-auto whitespace-pre-wrap break-words">
            {request.message}
          </DialogDescription>
        </DialogHeader>
        {request.kind === "prompt" && (
          <Input
            autoFocus
            aria-label={title}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                finish(true);
              }
            }}
          />
        )}
        <DialogFooter>
          {request.kind !== "alert" && (
            <Button variant="outline" onClick={() => finish(false)}>
              取消
            </Button>
          )}
          <Button
            autoFocus={request.kind !== "prompt"}
            variant={
              request.kind === "confirm" && request.destructive
                ? "destructive"
                : "default"
            }
            onClick={() => finish(true)}
          >
            {request.kind === "confirm"
              ? (request.confirmLabel ?? "确定")
              : "确定"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

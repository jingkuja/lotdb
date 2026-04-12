import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SHORTCUTS } from "@/lib/shortcuts";

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[11px] leading-none text-muted-foreground shadow-sm">
      {children}
    </kbd>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  // Group by category
  const categories = Array.from(new Set(SHORTCUTS.map((s) => s.category)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5 max-h-[70vh] overflow-y-auto pr-1">
          {categories.map((cat) => (
            <div key={cat}>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {cat}
              </p>
              <div className="flex flex-col gap-1">
                {SHORTCUTS.filter((s) => s.category === cat).map((s) => (
                  <div
                    key={s.label}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-sm">{s.label}</span>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {s.keys.map((k, i) => (
                        <Kbd key={i}>{k}</Kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

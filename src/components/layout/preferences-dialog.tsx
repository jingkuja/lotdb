import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  usePreferencesStore,
  type EditorFontFamily,
  type Preferences,
} from "@/stores/preferences-store";

interface PreferencesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const FONT_FAMILIES: EditorFontFamily[] = [
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Menlo",
  "Monaco",
  "monospace",
];

const PAGE_SIZES: Preferences["pageSize"][] = [50, 100, 200, 500];

const MAX_ROWS_OPTIONS: { value: number; label: string }[] = [
  { value: 100, label: "100" },
  { value: 500, label: "500" },
  { value: 1000, label: "1000" },
  { value: 5000, label: "5000" },
  { value: 0, label: "无限制" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <div className="flex flex-col gap-3 pl-1">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className="text-xs shrink-0">{label}</Label>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function PreferencesDialog({ open, onOpenChange }: PreferencesDialogProps) {
  const { prefs, setPref, reset } = usePreferencesStore();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>偏好设置</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-1">
          {/* Editor */}
          <Section title="SQL 编辑器">
            <Row label="字体">
              <select
                value={prefs.editorFontFamily}
                onChange={(e) =>
                  setPref("editorFontFamily", e.target.value as EditorFontFamily)
                }
                className="rounded border border-border bg-background px-2 py-1 text-xs"
              >
                {FONT_FAMILIES.map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>
                    {f}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="字号">
              <input
                type="range"
                min={11}
                max={20}
                value={prefs.editorFontSize}
                onChange={(e) =>
                  setPref("editorFontSize", Number(e.target.value))
                }
                className="w-24"
              />
              <span className="w-8 text-center text-xs tabular-nums">
                {prefs.editorFontSize}px
              </span>
            </Row>
          </Section>

          {/* Grid */}
          <Section title="数据网格">
            <Row label="每页行数">
              <div className="flex gap-1">
                {PAGE_SIZES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setPref("pageSize", s)}
                    className={`rounded px-2 py-0.5 text-xs border ${
                      prefs.pageSize === s
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="字号">
              <input
                type="range"
                min={11}
                max={16}
                value={prefs.gridFontSize}
                onChange={(e) =>
                  setPref("gridFontSize", Number(e.target.value))
                }
                className="w-24"
              />
              <span className="w-8 text-center text-xs tabular-nums">
                {prefs.gridFontSize}px
              </span>
            </Row>
          </Section>

          {/* Behavior */}
          <Section title="行为">
            <Row label="查询结果行数上限">
              <select
                value={prefs.queryMaxRows}
                onChange={(e) => setPref("queryMaxRows", Number(e.target.value))}
                className="rounded border border-border bg-background px-2 py-1 text-xs"
              >
                {MAX_ROWS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="保存查询历史">
              <input
                type="checkbox"
                checked={prefs.saveQueryHistory}
                onChange={(e) => setPref("saveQueryHistory", e.target.checked)}
              />
            </Row>
            <Row label="DML 执行前确认">
              <input
                type="checkbox"
                checked={prefs.confirmDml}
                onChange={(e) => setPref("confirmDml", e.target.checked)}
              />
            </Row>
          </Section>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={reset} className="mr-auto">
            恢复默认
          </Button>
          <Button onClick={() => onOpenChange(false)}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Copy, Check, Braces, AlignLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columnName: string;
  value: unknown;
}

type ViewMode = "pretty" | "raw";

function tryParseJson(value: unknown): { ok: true; parsed: unknown } | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { ok: false };
  try {
    return { ok: true, parsed: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** Basic JSON syntax highlighting via className spans */
function JsonHighlight({ json }: { json: string }) {
  // Simple regex-based coloring
  const parts: { text: string; type: string }[] = [];
  const regex = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(json)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: json.slice(lastIndex, match.index), type: "plain" });
    }
    const m = match[0];
    let type = "number";
    if (/^"/.test(m)) {
      type = /:$/.test(m) ? "key" : "string";
    } else if (/true|false/.test(m)) {
      type = "boolean";
    } else if (/null/.test(m)) {
      type = "null";
    }
    parts.push({ text: m, type });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < json.length) {
    parts.push({ text: json.slice(lastIndex), type: "plain" });
  }

  return (
    <code className="text-[11px] leading-relaxed">
      {parts.map((p, i) => (
        <span
          key={i}
          className={cn(
            p.type === "key" && "text-blue-400",
            p.type === "string" && "text-emerald-400",
            p.type === "number" && "text-amber-400",
            p.type === "boolean" && "text-purple-400",
            p.type === "null" && "text-muted-foreground italic",
            p.type === "plain" && "text-foreground",
          )}
        >
          {p.text}
        </span>
      ))}
    </code>
  );
}

export function CellViewerDialog({ open, onOpenChange, columnName, value }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("pretty");
  const [copied, setCopied] = useState(false);

  const jsonResult = useMemo(() => tryParseJson(value), [value]);
  const isJson = jsonResult.ok;
  const isNull = value === null || value === undefined;

  const rawText = renderValue(value);
  const prettyJson = isJson
    ? JSON.stringify((jsonResult as { ok: true; parsed: unknown }).parsed, null, 2)
    : rawText;

  const displayText = isJson && viewMode === "pretty" ? prettyJson : rawText;

  const charCount = isNull ? 0 : rawText === "NULL" ? 0 : rawText.length;

  const handleCopy = () => {
    void navigator.clipboard.writeText(isNull ? "" : displayText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[70vh] flex-col gap-0 p-0 sm:max-w-[680px]">
        {/* Header */}
        <DialogHeader className="flex-row items-center gap-2 border-b border-border px-4 py-2.5">
          <DialogTitle className="flex-1 truncate font-mono text-sm text-muted-foreground">
            <span className="text-foreground">{columnName}</span>
          </DialogTitle>

          {/* JSON toggle */}
          {isJson && (
            <div className="flex rounded-md border border-border text-xs">
              <button
                className={cn(
                  "flex items-center gap-1 px-2 py-1 transition-colors",
                  viewMode === "pretty"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
                onClick={() => setViewMode("pretty")}
              >
                <Braces className="size-3" />
                美化
              </button>
              <button
                className={cn(
                  "flex items-center gap-1 border-l border-border px-2 py-1 transition-colors",
                  viewMode === "raw"
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50",
                )}
                onClick={() => setViewMode("raw")}
              >
                <AlignLeft className="size-3" />
                原始
              </button>
            </div>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={handleCopy}
            disabled={isNull}
          >
            {copied ? (
              <><Check className="size-3 text-emerald-500" />已复制</>
            ) : (
              <><Copy className="size-3" />复制</>
            )}
          </Button>
        </DialogHeader>

        {/* Content */}
        <ScrollArea className="flex-1">
          <div className="px-4 py-3">
            {isNull ? (
              <span className="font-mono text-sm italic text-muted-foreground">NULL</span>
            ) : isJson && viewMode === "pretty" ? (
              <pre className="whitespace-pre-wrap break-all">
                <JsonHighlight json={prettyJson} />
              </pre>
            ) : (
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                {displayText}
              </pre>
            )}
          </div>
        </ScrollArea>

        {/* Footer — stats */}
        <div className="flex items-center gap-3 border-t border-border px-4 py-1.5 text-[11px] text-muted-foreground">
          {isJson && (
            <span className="flex items-center gap-1">
              <Braces className="size-3" />
              JSON
            </span>
          )}
          {!isNull && (
            <span>{charCount.toLocaleString()} 字符</span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

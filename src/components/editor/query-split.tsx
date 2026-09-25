import { useEffect, useRef, useState, type ReactNode } from "react";

export function QuerySplit({
  editor,
  children,
}: {
  editor: ReactNode;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [percent, setPercent] = useState(55);

  useEffect(() => () => cleanupRef.current?.(), []);

  return (
    <div
      ref={containerRef}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div
        ref={editorRef}
        className="shrink-0 overflow-hidden"
        style={{
          height: `clamp(min(80px, 50%), ${percent}%, max(50%, calc(100% - 126px)))`,
        }}
      >
        {editor}
      </div>
      <div
        role="separator"
        aria-label="调整 SQL 编辑器和查询结果高度"
        aria-orientation="horizontal"
        className="group relative flex h-1.5 shrink-0 cursor-row-resize items-center justify-center bg-border hover:bg-primary/40"
        onMouseDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          cleanupRef.current?.();
          const containerHeight =
            containerRef.current!.getBoundingClientRect().height;
          if (containerHeight <= 6) return;
          const startHeight = editorRef.current!.getBoundingClientRect().height;
          const startY = event.clientY;
          const min = Math.min(80, containerHeight / 2);
          const max = Math.max(containerHeight / 2, containerHeight - 126);
          const { cursor, userSelect } = document.body.style;
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
          const onMove = (move: MouseEvent) => {
            const height = Math.min(
              max,
              Math.max(min, startHeight + move.clientY - startY),
            );
            setPercent((height / containerHeight) * 100);
          };
          const cleanup = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", cleanup);
            window.removeEventListener("blur", cleanup);
            document.body.style.cursor = cursor;
            document.body.style.userSelect = userSelect;
            cleanupRef.current = null;
          };
          cleanupRef.current = cleanup;
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", cleanup);
          window.addEventListener("blur", cleanup);
        }}
      >
        <div className="h-0.5 w-8 rounded-full bg-muted-foreground/30 group-hover:bg-primary/60" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}

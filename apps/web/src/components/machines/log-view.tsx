"use client";

import { ArrowDown, Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { tables, useTable } from "@/lib/stdb";
import { cn } from "@/lib/utils";

/** Live log tail. Follows new output until you scroll up. */
export function LogView({ workloadId, className }: { workloadId: bigint; className?: string }) {
  const [rows] = useTable(tables.myLogs);
  const text = useMemo(
    () =>
      rows
        .filter((r) => r.workloadId === workloadId)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((r) => r.text)
        .join(""),
    [rows, workloadId],
  );
  const lines = useMemo(() => text.split("\n").slice(-4000), [text]);
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length, follow]);

  return (
    <div className={cn("relative flex min-h-0 flex-col overflow-hidden rounded-xl border bg-muted/30", className)}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">Output</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Copy logs"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            toast("Logs copied");
          }}
        >
          <Copy />
        </Button>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="min-h-0 flex-1 overflow-auto py-2 font-mono text-xs leading-5"
      >
        {text.trim() ? (
          lines.map((line, i) => (
            <div key={i} className="flex hover:bg-muted/60">
              <span className="w-12 shrink-0 pr-3 text-right text-muted-foreground/50 select-none tabular">{i + 1}</span>
              <span
                className={cn(
                  "pr-4 break-all whitespace-pre-wrap",
                  /error|traceback|exception|failed/i.test(line) ? "text-destructive" : /warn/i.test(line) ? "text-warning" : "text-foreground/85",
                )}
              >
                {line || " "}
              </span>
            </div>
          ))
        ) : (
          <div className="px-4 text-muted-foreground">Waiting for output…</div>
        )}
      </div>
      {!follow && (
        <Button size="sm" variant="outline" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-sm" onClick={() => setFollow(true)}>
          <ArrowDown /> Follow output
        </Button>
      )}
    </div>
  );
}

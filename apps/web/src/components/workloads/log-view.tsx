"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { tables, useTable } from "@/lib/stdb";
import { IconArrowUp, IconCopy } from "../icons";
import { IconButton } from "../ui/button";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";

/** Streaming terminal-style log tail that follows new output until you scroll up. */
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
    <div className={cn("relative overflow-hidden rounded-xl bg-[oklch(0.13_0.004_260)] shadow-[inset_0_0_0_1px_var(--color-line)]", className)}>
      <div className="absolute top-2 right-2 z-10 flex gap-1">
        <Tooltip content="Copy logs">
          <IconButton
            label="Copy logs"
            size="xs"
            onClick={() => {
              void navigator.clipboard.writeText(text);
              toast.success("Logs copied");
            }}
          >
            <IconCopy />
          </IconButton>
        </Tooltip>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="h-full overflow-auto py-3 font-mono text-[11.5px] leading-[1.65]"
      >
        {text.trim() ? (
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="hover:bg-white/[0.025]">
                  <td className="w-10 pr-3 pl-3 text-right align-top text-fg-faint/60 select-none tabular">{i + 1}</td>
                  <td
                    className={cn(
                      "pr-4 break-all whitespace-pre-wrap",
                      /error|traceback|exception|failed/i.test(line) ? "text-bad" : /warn/i.test(line) ? "text-wait" : "text-fg-muted",
                    )}
                  >
                    {line || " "}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 text-fg-faint">Waiting for output…</div>
        )}
      </div>
      {!follow && (
        <button
          type="button"
          onClick={() => setFollow(true)}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 animate-rise items-center gap-1.5 rounded-full bg-overlay px-3 py-1 text-xs text-fg shadow-overlay outline-none transition-colors hover:bg-raised focus-ring"
        >
          <IconArrowUp size={12} className="rotate-180" /> Follow output
        </button>
      )}
    </div>
  );
}

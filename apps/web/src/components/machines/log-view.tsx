"use client";

import { ArrowDown, Copy, Download, Search, WrapText, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { tables, useTable } from "@/lib/stdb";
import { cn } from "@/lib/utils";

type Level = "all" | "warn" | "error";
type Line = { key: string; n: number; text: string; time: string; level: "error" | "warn" | "info" };
/** One chunk split into newline-separated parts, parsed once and reused. */
type Parsed = { time: string; parts: string[]; levels: Line["level"][] };

const ERR = /error|traceback|exception|failed|fatal|cuda out of memory/i;
const WARN = /warn/i;
const levelOf = (t: string): Line["level"] => (ERR.test(t) ? "error" : WARN.test(t) ? "warn" : "info");

let timeFormat: Intl.DateTimeFormat | null = null;
function formatTime(d: Date) {
  // Same output as toLocaleTimeString(undefined, { hour12: false }), without
  // building a formatter per call.
  timeFormat ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: false });
  return timeFormat.format(d);
}

/**
 * Live log tail, terminal-style. Follows new output until you scroll up;
 * filter by text or severity without losing your place.
 */
export function LogView({ workloadId, className, title = "Logs", toolbar }: { workloadId: bigint; className?: string; title?: ReactNode; toolbar?: ReactNode }) {
  const [rows] = useTable(tables.myLogs);
  // Chunks are immutable, so each is split, timestamped and classified once.
  const [cache] = useState(() => new Map<bigint, Parsed>());
  const lines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    let carry = "";
    let carryTime = "";
    let carryKey = "";
    const chunks = rows.filter((r) => r.workloadId === workloadId).sort((a, b) => (a.id < b.id ? -1 : 1));
    const live = new Set<bigint>();
    for (const c of chunks) {
      live.add(c.id);
      let parsed = cache.get(c.id);
      if (!parsed) {
        const parts = c.text.split("\n");
        parsed = { time: formatTime(c.createdAt.toDate()), parts, levels: parts.map(levelOf) };
        cache.set(c.id, parsed);
      }
      const { time, parts, levels } = parsed;
      const last = parts.length - 1;
      for (let i = 0; i < last; i++) {
        // A line that began in an earlier chunk keeps that chunk's key and time.
        const joined = i === 0 && carry !== "";
        const text = joined ? carry + parts[0] : parts[i];
        out.push({ key: joined ? carryKey : `${c.id}:${i}`, n: out.length + 1, text, time: carryTime || time, level: joined ? levelOf(text) : levels[i] });
      }
      if (last === 0) {
        if (carry === "") carryKey = `${c.id}:0`;
        carry += parts[0];
      } else {
        carry = parts[last];
        carryKey = `${c.id}:${last}`;
      }
      carryTime = carry ? time : "";
    }
    if (carry) out.push({ key: carryKey, n: out.length + 1, text: carry, time: carryTime, level: levelOf(carry) });
    // Forget chunks the server has trimmed.
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    return out.slice(-5000);
  }, [rows, workloadId, cache]);

  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<Level>("all");
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const counts = useMemo(() => ({ warn: lines.filter((l) => l.level === "warn").length, error: lines.filter((l) => l.level === "error").length }), [lines]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => (level === "all" || l.level === level) && (!q || l.text.toLowerCase().includes(q)));
  }, [lines, query, level]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, follow]);

  const plain = () => lines.map((l) => l.text).join("\n");

  return (
    <div className={cn("relative flex min-h-0 flex-col overflow-hidden bg-terminal text-neutral-300", className)}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
        <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-200">
          {title}
          <span className="font-mono text-[11px] font-normal text-neutral-500 tabular">{lines.length.toLocaleString()} lines</span>
        </div>
        {toolbar}
        <div className="ml-auto flex items-center gap-1">
          <div className="flex items-center rounded-md border border-white/[0.07] p-0.5 text-[11px]">
            {(["all", "warn", "error"] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLevel(l)}
                className={cn(
                  "flex h-5 items-center gap-1 rounded px-1.5 transition-colors",
                  level === l ? "bg-white/10 text-white" : "text-neutral-500 hover:text-neutral-200",
                )}
              >
                {l === "all" ? "All" : l === "warn" ? "Warn" : "Error"}
                {l !== "all" && counts[l] > 0 && <span className={cn("font-mono tabular", l === "error" ? "text-red-400" : "text-amber-300")}>{counts[l]}</span>}
              </button>
            ))}
          </div>
          <label className="relative hidden items-center sm:flex">
            <Search className="pointer-events-none absolute left-2 size-3 text-neutral-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter"
              className="h-6 w-32 rounded-md border border-white/[0.07] bg-transparent pr-6 pl-6 font-mono text-[11px] text-neutral-200 outline-none placeholder:text-neutral-600 focus:w-44 focus:border-white/20 transition-[width]"
            />
            {query && (
              <button type="button" aria-label="Clear filter" onClick={() => setQuery("")} className="absolute right-1.5 text-neutral-500 hover:text-white">
                <X className="size-3" />
              </button>
            )}
          </label>
          <Tool label={wrap ? "Don’t wrap lines" : "Wrap lines"} onClick={() => setWrap((w) => !w)} active={wrap}>
            <WrapText />
          </Tool>
          <Tool
            label="Copy all"
            onClick={() => {
              void navigator.clipboard.writeText(plain());
              toast("Logs copied");
            }}
          >
            <Copy />
          </Tool>
          <Tool
            label="Download .log"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([plain()], { type: "text/plain" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = `workload-${workloadId}.log`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download />
          </Tool>
        </div>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[11.5px] leading-[19px]"
      >
        {shown.length ? (
          shown.map((l) => (
            <div key={l.key} className={cn("group flex [contain-intrinsic-size:auto_19px] [content-visibility:auto] hover:bg-white/[0.03]", l.level === "error" && "bg-red-500/[0.06]")}>
              <span className="w-11 shrink-0 pr-2 text-right text-neutral-700 select-none tabular group-hover:text-neutral-500">{l.n}</span>
              <span className="hidden w-[68px] shrink-0 text-neutral-600 select-none tabular md:inline">{l.time}</span>
              <span className={cn("pr-4", wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre", l.level === "error" ? "text-red-400" : l.level === "warn" ? "text-amber-300" : "text-neutral-300")}>
                {query ? highlight(l.text, query) : l.text || " "}
              </span>
            </div>
          ))
        ) : (
          <div className="flex items-center gap-2 px-4 py-2 text-neutral-500">
            {lines.length ? (
              "No lines match."
            ) : (
              <>
                <span className="inline-block h-3.5 w-1.5 animate-pulse bg-neutral-500" /> Waiting for output…
              </>
            )}
          </div>
        )}
      </div>
      {!follow && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 border border-white/10 bg-neutral-900 text-neutral-200 shadow-lg hover:bg-neutral-800"
          onClick={() => setFollow(true)}
        >
          <ArrowDown /> Follow output
        </Button>
      )}
    </div>
  );
}

function highlight(text: string, q: string): ReactNode {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-amber-300/30 text-amber-100">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function Tool({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            onClick={onClick}
            className={cn("text-neutral-500 hover:bg-white/[0.06] hover:text-white", active && "text-neutral-200")}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

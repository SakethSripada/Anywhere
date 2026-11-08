"use client";

/*
 * Expandable agent trace: a shimmering header while working that settles to a
 * summary, over a step list with a growing guide line.
 * Adapted from Beautiful UI "Thinking" (beautifului.dev, MIT © 2026 Shane Levine),
 * made data-driven: rows and state come from live agent data.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { LoaderGrid } from "./loader";

export type TraceRow = {
  key: string;
  primary: ReactNode;
  secondary?: ReactNode;
  mono?: boolean;
  /** active = spinner, done = muted check, error = red cross, note = no glyph, prose styling */
  state: "active" | "done" | "error" | "note";
  /** revealed when the row is clicked */
  detail?: ReactNode;
};

const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

export function Check({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={cn("shrink-0", className)}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn("size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2", className)} style={{ animation: "spin 700ms linear infinite" }} />;
}

export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--ink-3)"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 transition-transform duration-300", className)}
      style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function Trace({
  working,
  active,
  done,
  rows,
  meta,
  icon,
  defaultOpen,
  footer,
}: {
  working: boolean;
  active: string;
  done: string;
  rows: TraceRow[];
  /** right of the label, e.g. an elapsed timer */
  meta?: ReactNode;
  icon?: ReactNode;
  defaultOpen?: boolean;
  /** below the rows, e.g. a result or a thumbnail; a function gets whether the trace is expanded */
  footer?: ReactNode | ((expanded: boolean) => ReactNode);
}) {
  const [manual, setManual] = useState<boolean | null>(null);
  const expanded = manual ?? defaultOpen ?? working;
  const traceRef = useRef<HTMLDivElement>(null);
  const [lineHeight, setLineHeight] = useState(0);
  const [openRow, setOpenRow] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (traceRef.current) setLineHeight(traceRef.current.offsetHeight);
  }, [rows.length, expanded, openRow]);

  return (
    <div className="flex w-full flex-col" style={{ animation: `fade-up 300ms ${EASE} both` }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setManual(!expanded)}
        className="-mx-1.5 flex w-fit max-w-full items-center gap-2 rounded-control px-1.5 py-1 transition-colors duration-100 hover:bg-hover-2"
      >
        <span className="flex shrink-0 items-center">{icon ?? (working ? <LoaderGrid variant="orbit" /> : <Check />)}</span>
        <span role="status" className="contents">
          {working ? (
            <span className="bui-shimmer truncate text-[13px] font-medium whitespace-nowrap">{active}</span>
          ) : (
            <span className="truncate text-[13px] font-medium whitespace-nowrap text-ink-2" style={{ animation: "fade-in 350ms ease-out both" }}>
              {done}
            </span>
          )}
        </span>
        {meta && <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">{meta}</span>}
        <Chevron open={expanded} />
      </button>

      <div className="grid transition-[grid-template-rows,opacity] duration-400" style={{ gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0, transitionTimingFunction: EASE }}>
        <div className="overflow-hidden">
          <div className="relative mt-1 ml-[5px] pl-4">
            <span aria-hidden className="absolute left-[3px] w-px bg-line" style={{ top: -8, height: lineHeight ? lineHeight - 2 : 0, transition: `height 500ms ${EASE}` }} />
            <div ref={traceRef} className="flex flex-col gap-0.5 py-1">
              {rows.map((row) => {
                const open = openRow === row.key;
                const body = (
                  <>
                    {row.state === "active" ? <Spinner className="mx-px" /> : row.state === "done" ? <Check /> : row.state === "error" ? <Cross /> : <span className="grid size-3.5 shrink-0 place-items-center"><span className="size-1 rounded-full bg-ink-3" /></span>}
                    <span className={cn("min-w-0 truncate text-[12.5px]", row.state === "note" ? "whitespace-normal text-ink-2" : row.state === "error" ? "font-medium text-red" : "font-medium text-ink")}>{row.primary}</span>
                    {row.secondary && <span className={cn("ml-auto shrink-0 text-[11.5px] text-ink-3", row.mono && "font-mono")}>{row.secondary}</span>}
                  </>
                );
                const cls = "flex min-h-7 w-full items-center gap-2 rounded-[6px] px-1.5 py-0.5 text-left";
                return (
                  <div key={row.key} style={{ animation: `fade-up 320ms ${EASE} both` }}>
                    {row.detail ? (
                      <button type="button" aria-expanded={open} onClick={() => setOpenRow(open ? null : row.key)} className={cn(cls, "transition-colors duration-150", open ? "bg-inset" : "hover:bg-hover")}>
                        {body}
                      </button>
                    ) : (
                      <div className={cls}>{body}</div>
                    )}
                    {row.detail && (
                      <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: EASE }}>
                        <div className="min-h-0 overflow-hidden">
                          <div className="mt-0.5 mb-1 ml-2 border-l border-line py-0.5 pl-3.5">{row.detail}</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {typeof footer === "function" ? footer(expanded) : footer}
          </div>
        </div>
      </div>
    </div>
  );
}

function Cross() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

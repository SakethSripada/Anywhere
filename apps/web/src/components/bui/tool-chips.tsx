"use client";

/*
 * Tool calls as compact rows: icon (chevron on hover), a verb, and an inline
 * chip naming the object. Every row expands to show what the tool did.
 * Adapted from Beautiful UI "Tool Chips" (beautifului.dev, MIT © 2026 Shane Levine).
 */

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "./trace";

const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

export const ToolIcons = {
  plan: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </g>
  ),
  check: (
    <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </g>
  ),
  read: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </g>
  ),
  run: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17l6-5-6-5M12 19h8" />
    </g>
  ),
  stop: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </g>
  ),
  play: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4v16l13-8z" />
    </g>
  ),
  save: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </g>
  ),
  trash: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </g>
  ),
  search: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </g>
  ),
  cursor: (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M5 3l14 7-6 2-2 6z" />
    </g>
  ),
} as const;

export type ToolIconName = keyof typeof ToolIcons;

export function ToolGroup({ header, running, children, defaultOpen = true }: { header: ReactNode; running?: boolean; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="w-full" style={{ animation: `fade-up 300ms ${EASE} both` }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className={cn("tabular-nums", running && "bui-shimmer")}>{header}</span>
      </button>
      <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}>
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
          <div className="mt-1 flex flex-col gap-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function ToolRow({
  icon,
  label,
  chip,
  mono,
  state = "done",
  detail,
  defaultOpen = false,
}: {
  icon: ToolIconName;
  label: ReactNode;
  chip?: ReactNode;
  mono?: boolean;
  state?: "running" | "done" | "failed";
  detail?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ animation: `fade-up 300ms ${EASE} both` }}>
      <button
        type="button"
        aria-expanded={open}
        disabled={!detail}
        onClick={() => setOpen((o) => !o)}
        className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 enabled:hover:bg-hover-2"
      >
        <span className={cn("relative flex size-4 shrink-0 items-center justify-center", state === "failed" ? "text-red" : "text-ink-3")}>
          {state === "running" ? (
            <Spinner />
          ) : (
            <>
              <svg width="13" height="13" viewBox="0 0 24 24" className={cn("transition-opacity duration-100", detail && "group-hover/row:opacity-0", open && "opacity-0")}>
                {ToolIcons[icon]}
              </svg>
              {detail && (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={cn("absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100", open ? "opacity-100" : "opacity-0")}
                  style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              )}
            </>
          )}
        </span>
        <span className={cn("shrink-0 text-[12.5px] font-medium", state === "running" ? "bui-shimmer" : state === "failed" ? "text-red" : "text-ink")}>{label}</span>
        {chip && <Chip mono={mono}>{chip}</Chip>}
      </button>
      {detail && (
        <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: EASE }}>
          <div className="min-h-0 overflow-hidden">
            <div className="mt-0.5 mb-1 ml-2 border-l border-line py-0.5 pl-3.5">{detail}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Inline object chip — the hairline pill that names what a tool touched. */
export function Chip({ children, mono, className }: { children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex h-5.5 min-w-0 items-center truncate rounded-chip bg-field px-1.5 text-[11.5px] text-ink-2 shadow-hairline", mono && "font-mono", className)}>
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Tappable suggestion pill (follow-ups, quick prompts). */
export function SuggestionChip({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 shrink-0 items-center rounded-chip bg-card px-2.5 text-[12px] whitespace-nowrap text-ink-2 shadow-btn transition-[background-color,color,transform] duration-100 hover:bg-hover-2 hover:text-ink active:scale-[0.97]"
    >
      {children}
    </button>
  );
}

export function DetailLines({ lines, mono }: { lines: { text: string; tone?: "add" | "del" | "muted" }[]; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((l, i) => (
        <span key={i} className={cn("text-[11.5px] leading-[1.6] break-words", mono && "font-mono", l.tone === "add" ? "text-green" : l.tone === "del" ? "text-red" : "text-ink-2")}>
          {l.text}
        </span>
      ))}
    </div>
  );
}

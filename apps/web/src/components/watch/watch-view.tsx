"use client";

import { Eye, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppLogo } from "@/components/app/app-logo";
import { VncScreen } from "@/components/machines/vnc-screen";
import { apiWsUrl, config } from "@/lib/config";
import { cn } from "@/lib/utils";

/*
 * What someone with a watch link sees: the desktop, live and view-only, and what the
 * agent is doing on it. No account needed. Input is refused by the desktop's own
 * view-only VNC server, not just by this page.
 */

type Step = { seq: number; kind: string; summary: string };
type View = {
  title: string;
  status: string;
  gpu: string;
  app: string | null;
  controller: string;
  expires_at: string;
  agent: { goal: string; status: string; result: string; steps: Step[] } | null;
};

function useWatch(token: string) {
  const [view, setView] = useState<View | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const res = await fetch(`${config.apiUrl}/v1/watch/${encodeURIComponent(token)}`, { cache: "no-store" });
        if (res.status === 404) {
          const body = await res.json().catch(() => ({}));
          if (!stop) setGone(typeof body.detail === "string" ? body.detail : "This watch link has expired or was turned off");
          return;
        }
        if (res.ok && !stop) setView((await res.json()) as View);
      } catch {
        /* offline for a moment: keep the last view and try again */
      }
      if (!stop) timer = setTimeout(load, 2000);
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [token]);
  return { view, gone };
}

function left(iso: string) {
  const mins = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}

export function WatchView({ token }: { token: string }) {
  const { view, gone } = useWatch(token);
  const streamUrl = useCallback(async () => apiWsUrl(`/v1/watch/${encodeURIComponent(token)}/vnc`), [token]);
  const running = view?.status === "running";

  if (gone) {
    return (
      <Centered>
        <p className="text-sm font-medium">{gone}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">Ask whoever shared it for a new link.</p>
      </Centered>
    );
  }
  if (!view) {
    return (
      <Centered>
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </Centered>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 text-[13px]">
        <span className="font-semibold tracking-tight">Anywhere</span>
        <span className="text-faint">/</span>
        <AppLogo app={view.app ?? "terminal"} size={16} />
        <h1 className="min-w-0 truncate font-medium">{view.title}</h1>
        <span className="hidden text-muted-foreground sm:inline">· {view.gpu}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-[12px] text-muted-foreground">
          <Eye className="size-3.5" /> View only
        </span>
        <span className="hidden shrink-0 text-[12px] text-muted-foreground md:inline">link ends in {left(view.expires_at)}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative min-h-[40vh] flex-1 bg-black lg:min-h-0">
          {running ? (
            <VncScreen streamKey={token} streamUrl={streamUrl} viewOnly scale="fit" quality="balanced" className="bg-black" />
          ) : (
            <div className="grid h-full place-items-center text-center text-sm text-neutral-400">
              <div>
                <p className="font-medium text-neutral-200">{view.status === "stopped" ? "This desktop is stopped" : "This desktop isn't live right now"}</p>
                <p className="mt-1 text-[13px] text-neutral-500">The stream picks up again when it&apos;s running.</p>
              </div>
            </div>
          )}
        </div>
        <AgentPanel view={view} />
      </div>
    </div>
  );
}

function AgentPanel({ view }: { view: View }) {
  const a = view.agent;
  const working = a?.status === "running" && view.controller === "agent";
  const list = useRef<HTMLOListElement>(null);
  const count = a?.steps.length ?? 0;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [count]);

  return (
    <aside className="flex max-h-[45vh] min-h-0 flex-col border-t lg:max-h-none lg:w-80 lg:border-t-0 lg:border-l">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", working ? "animate-pulse bg-[var(--chart-1)]" : "bg-muted-foreground/40")} />
          {working ? "Agent is working" : a ? (a.status === "done" ? "Agent finished" : a.status === "paused" ? "Agent paused" : "Agent stopped") : "Agent"}
        </div>
        <p className="mt-1 text-[13.5px] font-medium">{a?.goal || "Nothing asked of the agent yet"}</p>
      </div>
      {a && a.steps.length > 0 ? (
        <ol ref={list} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3 text-[13px]">
          {a.steps.map((s, i) => (
            <li key={s.seq} className="flex gap-2">
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  s.kind === "error" ? "bg-destructive" : working && i === a.steps.length - 1 ? "animate-pulse bg-[var(--chart-1)]" : "bg-muted-foreground/50",
                )}
              />
              <span className={cn(s.kind === "error" && "text-destructive", s.kind === "done" && "font-medium")}>{s.summary}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">When the agent works on this desktop, each step shows up here as it happens.</p>
      )}
      {a?.result && a.status !== "running" && <p className="border-t px-4 py-3 text-[12.5px] text-muted-foreground">{a.result}</p>}
    </aside>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center bg-background px-6 text-center">{<div>{children}</div>}</div>;
}

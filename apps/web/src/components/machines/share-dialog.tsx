"use client";

import type { Workload } from "@anywhere/stdb";
import { Copy, Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ApiError, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";

const DURATIONS = [
  { hours: 1, label: "1 hour" },
  { hours: 4, label: "4 hours" },
  { hours: 24, label: "1 day" },
] as const;

type Status = { active: boolean; expires_at?: string };

/** A watch-only link to a running desktop: people see the screen and the agent, and can't touch anything. */
export function ShareButton({ w }: { w: Workload }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Eye />
        <span className="hidden md:inline">Share</span>
      </Button>
      {open && <ShareDialog w={w} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareDialog({ w, onClose }: { w: Workload; onClose: () => void }) {
  const api = useApi();
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [hours, setHours] = useState<number>(4);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api.ready) return;
    const ctl = new AbortController();
    api
      .get<Status>(`/v1/workloads/${w.id}/share`, { signal: ctl.signal })
      .then((s) => !ctl.signal.aborted && setStatus(s))
      .catch(() => !ctl.signal.aborted && setStatus({ active: false }));
    return () => ctl.abort();
  }, [api, w.id]);

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ token: string; expires_at: string }>(`/v1/workloads/${w.id}/share`, { hours });
      setLink(`${window.location.origin}/watch/${r.token}`);
      setStatus({ active: true, expires_at: r.expires_at });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't make a link.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      await api.del(`/v1/workloads/${w.id}/share`);
      setStatus({ active: false });
      setLink(null);
      toast("Watch link turned off");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't turn the link off.");
    } finally {
      setBusy(false);
    }
  }

  const until = status?.expires_at ? new Date(status.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-4 sm:max-w-md">
        <div>
          <DialogTitle className="text-[15px] font-semibold tracking-tight">Share a watch-only link</DialogTitle>
          <DialogDescription className="mt-1 text-[13px]">
            Anyone with the link can watch {w.title} and the agent live from their own browser. They can&apos;t click, type or see your clipboard, and
            watching doesn&apos;t keep the desktop from idle-stopping.
          </DialogDescription>
        </div>

        {link ? (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Watch link" className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-[12px]" />
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(link);
                  toast("Link copied");
                }}
              >
                <Copy /> Copy
              </Button>
            </div>
            <p className="text-[12px] text-muted-foreground">Works until {until}. Copy it now: for safety it isn&apos;t shown again.</p>
          </div>
        ) : status?.active ? (
          <p className="rounded-md bg-muted px-3 py-2 text-[13px]">A watch link is on until {until}. Making a new one turns the old one off.</p>
        ) : null}

        {!link && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-muted-foreground">Link lasts</span>
            <div className="flex rounded-md border p-0.5" role="group" aria-label="Link lasts">
              {DURATIONS.map((d) => (
                <button
                  key={d.hours}
                  type="button"
                  aria-pressed={hours === d.hours}
                  onClick={() => setHours(d.hours)}
                  className={cn("rounded-[5px] px-2 py-0.5 text-[12px]", hours === d.hours ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <Button size="sm" className="ml-auto" disabled={busy || !status} onClick={() => void make()}>
              {busy ? "Setting up…" : status?.active ? "Make a new link" : "Make link"}
            </Button>
          </div>
        )}

        {error && <p className="text-[13px] text-destructive">{error}</p>}
        {status?.active && (
          <button type="button" disabled={busy} onClick={() => void turnOff()} className="w-fit text-[12.5px] text-destructive underline-offset-2 hover:underline">
            Turn the link off now
          </button>
        )}
      </DialogContent>
    </Dialog>
  );
}

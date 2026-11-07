"use client";

import type { Workload } from "@anywhere/stdb";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, useApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useWorkload } from "@/lib/data";
import { IconAgent, IconChevronLeft, IconHand, IconMore, IconPlay, IconPower, IconTrash } from "../icons";
import { PlanCard } from "../app/plan-card";
import { Button, IconButton } from "../ui/button";
import { MenuContent, MenuItem, MenuRoot, MenuSeparator, MenuTrigger } from "../ui/menu";
import { StatusPill } from "../ui/status";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { BootProgress, ConfirmDialog, EventFeed, LiveCost, Uptime, useWorkloadAction } from "../workloads/shared";
import { AgentPanel } from "./agent-panel";
import { VncScreen } from "./vnc-screen";

export function DesktopView({ id }: { id: string }) {
  const wid = /^\d+$/.test(id) ? BigInt(id) : null;
  const { workload: w, ready } = useWorkload(wid);

  if (!w) {
    return (
      <div className="grid flex-1 place-items-center text-sm text-fg-subtle">
        {ready ? "This desktop doesn't exist or isn't yours." : <div className="skeleton h-6 w-48" />}
      </div>
    );
  }
  return <Desktop w={w} />;
}

function Desktop({ w }: { w: Workload }) {
  const live = w.status === "running" || w.status === "saving";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header w={w} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative min-h-[320px] min-w-0 flex-1 bg-canvas">
          {live ? <LiveScreen w={w} /> : <OfflineState w={w} />}
        </div>
        <AgentPanel w={w} />
      </div>
    </div>
  );
}

function Header({ w }: { w: Workload }) {
  const router = useRouter();
  const { busy, run } = useWorkloadAction(w.id);
  const [confirm, setConfirm] = useState<"stop" | "delete" | null>(null);
  const canStop = w.status === "running";
  const canResume = w.status === "stopped";
  const canDelete = !["terminated", "cancelled", "planned"].includes(w.status);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3 sm:px-4">
      <Tooltip content="All desktops">
        <Link
          href="/desktops"
          className="grid size-7 place-items-center rounded-md text-fg-subtle outline-none transition-colors hover:bg-hover hover:text-fg focus-ring"
          aria-label="All desktops"
        >
          <IconChevronLeft size={16} />
        </Link>
      </Tooltip>
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-sm font-medium text-fg">{w.title}</h1>
        <StatusPill status={w.status} />
      </div>
      <div className="hidden items-center gap-4 pl-2 text-xs text-fg-subtle md:flex">
        <span className="truncate">{w.gpuName}</span>
        <span className="h-3 w-px bg-line-strong" />
        <span>
          Up <Uptime w={w} />
        </span>
        <span className="h-3 w-px bg-line-strong" />
        <LiveCost w={w} />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {canStop && (
          <Button
            size="sm"
            variant="secondary"
            leading={<IconPower />}
            loading={busy === "stop"}
            onClick={() => (w.stoppable ? setConfirm("stop") : setConfirm("delete"))}
          >
            {w.stoppable ? "Stop" : "Shut down"}
          </Button>
        )}
        {canResume && (
          <Button size="sm" variant="primary" leading={<IconPlay />} loading={busy === "resume"} onClick={() => void run("resume")}>
            Resume
          </Button>
        )}
        <MenuRoot>
          <MenuTrigger render={<IconButton label="More actions" />}>
            <IconMore />
          </MenuTrigger>
          <MenuContent align="end" width="w-52">
            <MenuItem
              onClick={() => {
                void navigator.clipboard.writeText(String(w.id));
                toast.success("Copied desktop ID");
              }}
            >
              Copy desktop ID
            </MenuItem>
            {w.conversationId > 0n && <MenuItem onClick={() => router.push(`/c/${w.conversationId}`)}>Open conversation</MenuItem>}
            {canDelete && (
              <>
                <MenuSeparator />
                <MenuItem tone="danger" icon={<IconTrash />} onClick={() => setConfirm("delete")}>
                  Delete machine
                </MenuItem>
              </>
            )}
          </MenuContent>
        </MenuRoot>
      </div>

      <ConfirmDialog
        open={confirm === "stop"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Stop this desktop?"
        description="Anywhere saves ~/Projects to durable storage first, then stops the machine. Billing pauses; resume anytime."
        confirm="Save & stop"
        tone="primary"
        busy={busy === "stop"}
        onConfirm={async () => {
          if (await run("stop")) setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this machine?"
        description={
          w.status === "running"
            ? "Your project files are saved before the machine is destroyed. Anything outside ~/Projects is lost."
            : "The machine is destroyed permanently. Saved project files stay in your storage."
        }
        confirm="Delete machine"
        busy={busy === "delete"}
        onConfirm={async () => {
          if (await run("delete")) setConfirm(null);
        }}
      />
    </header>
  );
}

function LiveScreen({ w }: { w: Workload }) {
  const api = useApi();
  const agentDriving = w.controller === "agent";
  const [switching, setSwitching] = useState(false);

  async function handOff(to: "user" | "agent") {
    setSwitching(true);
    try {
      await api.post(`/v1/workloads/${w.id}/agent/${to === "user" ? "stop" : "resume"}`);
    } catch (err) {
      toast.error("Couldn't switch control", err instanceof ApiError ? err.message : undefined);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="absolute inset-0 p-0 sm:p-3">
      <div
        className={cn(
          "relative h-full overflow-hidden transition-shadow duration-300 sm:rounded-xl",
          agentDriving
            ? "shadow-[0_0_0_1px_var(--color-accent-line),0_0_0_4px_var(--color-accent-soft)]"
            : "shadow-[0_0_0_1px_var(--color-line-strong)]",
        )}
      >
        <VncScreen workloadId={w.id} viewOnly={agentDriving}>
          {w.status === "saving" && (
            <div className="absolute top-3 left-3 flex animate-fade-in items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs text-fg backdrop-blur">
              <span className="size-1.5 animate-pulse-dot rounded-full bg-busy text-busy" /> Saving project…
            </div>
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <div className="pointer-events-auto flex animate-rise items-center gap-3 rounded-full bg-black/75 py-1.5 pr-1.5 pl-3.5 shadow-overlay backdrop-blur-md">
              {agentDriving ? (
                <>
                  <span className="flex items-center gap-2 text-xs text-fg">
                    <IconAgent size={14} className="text-accent" />
                    Agent has control
                  </span>
                  <Button size="xs" variant="primary" leading={<IconHand />} loading={switching} onClick={() => void handOff("user")}>
                    Take over
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-2 text-xs text-fg">
                    <IconHand size={14} className="text-fg-muted" />
                    You have control
                  </span>
                  <Button size="xs" variant="secondary" leading={<IconAgent />} loading={switching} onClick={() => void handOff("agent")}>
                    Hand to agent
                  </Button>
                </>
              )}
            </div>
          </div>
        </VncScreen>
      </div>
    </div>
  );
}

function OfflineState({ w }: { w: Workload }) {
  const { busy, run } = useWorkloadAction(w.id);

  if (w.status === "planned") {
    return (
      <div className="absolute inset-0 grid place-items-center overflow-y-auto p-6">
        <PlanCard workloadId={w.id} />
      </div>
    );
  }

  const booting = ["approved", "provisioning", "configuring"].includes(w.status);
  return (
    <div className="absolute inset-0 grid place-items-center overflow-y-auto p-6">
      <div className="w-full max-w-md animate-rise">
        {booting ? (
          <>
            <h2 className="text-lg font-semibold tracking-tight text-fg">Getting your desktop ready</h2>
            <p className="mt-1 mb-6 text-sm text-fg-subtle">
              This usually takes 5–10 minutes. You can close this tab — we’ll keep going and notify you.
            </p>
            <BootProgress w={w} />
          </>
        ) : w.status === "stopped" ? (
          <>
            <h2 className="text-lg font-semibold tracking-tight text-fg">Desktop stopped</h2>
            <p className="mt-1 mb-5 text-sm text-fg-subtle">Your project is saved and billing is paused. Resuming takes a few minutes.</p>
            <Button variant="primary" size="lg" leading={<IconPlay />} loading={busy === "resume"} onClick={() => void run("resume")}>
              Resume desktop
            </Button>
          </>
        ) : w.status === "stopping" ? (
          <>
            <h2 className="text-lg font-semibold tracking-tight text-fg">Stopping</h2>
            <p className="mt-1 text-sm text-fg-subtle">{w.statusDetail || "Saving files, then stopping the machine."}</p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold tracking-tight text-fg">
              {w.status === "failed"
                ? "This desktop ran into a problem"
                : w.status === "cancelled"
                  ? "This desktop was cancelled"
                  : "This desktop was deleted"}
            </h2>
            <p className="mt-1 text-sm text-fg-subtle">{w.statusDetail || "No machine is running or billing for it."}</p>
          </>
        )}
        <div className="mt-8 border-t border-line pt-5">
          <div className="mb-3 text-2xs font-medium uppercase tracking-[0.06em] text-fg-faint">Activity</div>
          <EventFeed workloadId={w.id} limit={8} />
        </div>
      </div>
    </div>
  );
}

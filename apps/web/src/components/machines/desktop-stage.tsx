"use client";

import type { AgentStep, Workload } from "@anywhere/stdb";
import {
  Camera,
  ClipboardCopy,
  ClipboardPaste,
  Command,
  Expand,
  Gauge,
  Hand,
  Keyboard,
  Lock,
  LockOpen,
  Maximize2,
  Minimize2,
  MousePointer2,
  Play,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ACTION_VERB, parseDetail, useAgentState, type Control } from "@/lib/agent";
import { ApiError, useApi } from "@/lib/api";
import { apiWsUrl } from "@/lib/config";
import { useNow } from "@/lib/data";
import { duration, ms } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentOrb } from "@/components/bui/orb";
import { PlanCard } from "../chat/plan-card";
import { BootProgress, EventFeed, useWorkloadAction } from "./shared";
import { VncScreen, type Phase, type Quality, type Scale, type ScreenRect, type VncHandle } from "./vnc-screen";

/* ── Live desktop ────────────────────────────────────────────────────── */

export function DesktopStage({ w, onAskAgent }: { w: Workload; onAskAgent: () => void }) {
  if (w.status === "running" || w.status === "saving") return <LiveDesktop w={w} onAskAgent={onAskAgent} />;
  return <DesktopState w={w} />;
}

function LiveDesktop({ w, onAskAgent }: { w: Workload; onAskAgent: () => void }) {
  const api = useApi();
  const agent = useAgentState(w);
  const screen = useRef<VncHandle>(null);
  const streamUrl = useCallback(async () => {
    const { ticket } = await api.post<{ ticket: string }>(`/v1/desktops/${w.id}/session`);
    return apiWsUrl(`/v1/desktops/${w.id}/vnc?ticket=${encodeURIComponent(ticket)}`);
  }, [api, w.id]);
  const stage = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState<Scale>("fit");
  const [quality, setQuality] = useState<Quality>("balanced");
  const [shared, setShared] = useState(false);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [rect, setRect] = useState<ScreenRect | null>(null);
  const [remoteClip, setRemoteClip] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [nudge, setNudge] = useState(0);
  const [isFull, setIsFull] = useState(false);

  const working = agent.working;
  const viewOnly = working && !shared;

  useEffect(() => {
    const on = () => setIsFull(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => setNudge(0), 2600);
    return () => clearTimeout(t);
  }, [nudge]);

  async function setControl(to: "user" | "agent") {
    if (to === "agent" && agent.control === "user") return onAskAgent();
    setSwitching(true);
    try {
      // Taking over pauses the run, so handing back resumes the same goal.
      await api.post(`/v1/workloads/${w.id}/agent/${to === "user" ? "stop?pause=true" : "resume"}`);
      if (to === "user") requestAnimationFrame(() => screen.current?.focus());
    } catch (err) {
      toast.error("Couldn’t switch control", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setSwitching(false);
    }
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return toast("Your clipboard is empty");
      screen.current?.paste(text);
      toast("Sent to the desktop clipboard", { description: "Press Ctrl+V in the desktop to paste." });
    } catch {
      toast.error("Clipboard access was blocked by the browser");
    }
  }

  function snapshot() {
    const url = screen.current?.screenshot();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${w.title.replace(/[^\w-]+/g, "-").toLowerCase()}-${Date.now()}.png`;
    a.click();
  }

  function fullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen();
  }

  return (
    <div ref={stage} className="@container/stage flex h-full min-h-0 flex-col bg-screen">
      {/* Screen toolbar */}
      <div className="grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-white/[0.06] bg-[#0c0c0e] px-2.5 text-neutral-300">
        <ConnectionPill phase={phase} rect={rect} quality={quality} />
        <ControlSwitch control={agent.control} busy={switching} onChange={(c) => void setControl(c)} />
        <div className="flex items-center justify-end gap-0.5">
          {working && (
            <ToolButton
              label={shared ? "Shared input: your mouse and keyboard work alongside the agent" : "Input locked while the agent drives. Click to work alongside it."}
              onClick={() => setShared((s) => !s)}
              active={shared}
            >
              {shared ? <LockOpen /> : <Lock />}
            </ToolButton>
          )}
          {remoteClip && (
            <ToolButton
              label="Copy the desktop’s clipboard to yours"
              onClick={() => {
                void navigator.clipboard.writeText(remoteClip);
                setRemoteClip(null);
                toast("Copied from the desktop");
              }}
              active
            >
              <ClipboardCopy />
            </ToolButton>
          )}
          <span className="hidden items-center gap-0.5 @lg/stage:flex">
            <ToolButton label="Paste your clipboard into the desktop" onClick={() => void paste()} disabled={phase !== "live"}>
              <ClipboardPaste />
            </ToolButton>
            <ToolButton label="Save a screenshot" onClick={snapshot} disabled={phase !== "live"}>
              <Camera />
            </ToolButton>
          </span>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger render={<DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" className="text-neutral-400 hover:bg-white/[0.06] hover:text-white" aria-label="Display and input" />} />}>
                <Gauge />
              </TooltipTrigger>
              <TooltipContent>Display and input</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Scaling</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={scale} onValueChange={(v) => setScale(v as Scale)}>
                  <DropdownMenuRadioItem value="fit">Fit to window</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="native">Actual pixels</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Stream quality</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={quality} onValueChange={(v) => setQuality(v as Quality)}>
                  <DropdownMenuRadioItem value="high">Sharp</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="balanced">Balanced</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="low">Low bandwidth</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="@lg/stage:hidden" disabled={phase !== "live"} onClick={() => void paste()}>
                <ClipboardPaste /> Paste into desktop
              </DropdownMenuItem>
              <DropdownMenuItem className="@lg/stage:hidden" disabled={phase !== "live"} onClick={snapshot}>
                <Camera /> Save screenshot
              </DropdownMenuItem>
              <DropdownMenuItem disabled={phase !== "live" || viewOnly} onClick={() => screen.current?.ctrlAltDel()}>
                <Keyboard /> Send Ctrl+Alt+Del
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => screen.current?.reconnect()}>
                <RotateCw /> Reconnect stream
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ToolButton label={isFull ? "Exit full screen" : "Full screen"} onClick={fullscreen}>
            {isFull ? <Minimize2 /> : <Maximize2 />}
          </ToolButton>
        </div>
      </div>

      {/* Stream */}
      <div className="relative min-h-0 flex-1">
        <VncScreen
          ref={screen}
          streamKey={String(w.id)}
          streamUrl={streamUrl}
          viewOnly={viewOnly}
          scale={scale}
          quality={quality}
          onPhase={setPhase}
          onRect={setRect}
          onRemoteClipboard={setRemoteClip}
          overlay={
            <>
              {/* The agent's presence: a breathing frame around the screen it is driving. */}
              <div className={cn("pointer-events-none absolute inset-0 transition-opacity duration-500", working ? "agent-glow opacity-100" : "opacity-0")} />
              {working && rect && agent.lastAct && <AgentCursor step={agent.lastAct} rect={rect} />}
              {viewOnly && phase === "live" && <div className="absolute inset-0 cursor-not-allowed" onPointerDown={() => setNudge((n) => n + 1)} />}
            </>
          }
        />
        <Hud
          w={w}
          control={agent.control}
          goal={agent.run?.goal}
          step={agent.last}
          stepCount={agent.steps.filter((s) => s.kind === "act").length}
          startedAt={agent.run ? ms(agent.run.startedAt) : 0}
          nudged={nudge > 0}
          busy={switching}
          onTakeOver={() => void setControl("user")}
          onHandBack={() => void setControl("agent")}
        />
      </div>
    </div>
  );
}

function ToolButton({ label, onClick, children, disabled, active }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className={cn("text-neutral-400 hover:bg-white/[0.06] hover:text-white", active && "bg-agent/15 text-agent hover:bg-agent/25 hover:text-agent")}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{label}</TooltipContent>
    </Tooltip>
  );
}

function ConnectionPill({ phase, rect, quality }: { phase: Phase; rect: ScreenRect | null; quality: Quality }) {
  const live = phase === "live";
  return (
    <div className="flex min-w-0 items-center gap-2 pl-1 text-[12px]">
      <span className={cn("relative flex size-2", !live && "opacity-70")}>
        <span className={cn("relative size-1.5 rounded-full", live ? "bg-green/70" : phase === "failed" ? "bg-red" : "bg-warning")} />
      </span>
      <span className="hidden font-medium text-neutral-200 @md/stage:inline">{live ? "Live" : phase === "failed" ? "Offline" : "Connecting"}</span>
      {live && rect && (
        <span className="hidden truncate text-[11px] text-neutral-500 @3xl/stage:inline">
          {rect.fbWidth}×{rect.fbHeight} · {quality}
        </span>
      )}
    </div>
  );
}

/** Who drives: a two-way switch. The agent side lights violet; your side green. */
function ControlSwitch({ control, busy, onChange }: { control: Control; busy: boolean; onChange: (c: "user" | "agent") => void }) {
  const agentSide = control === "agent";
  return (
    <div role="radiogroup" aria-label="Who controls the desktop" className="relative flex h-7.5 items-center rounded-lg border border-white/[0.07] bg-white/[0.03] p-0.5 text-[12px] font-medium">
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0.5 w-[calc(50%-2px)] rounded-md transition-[left,background-color] duration-300 ease-[var(--ease-out)]",
          agentSide ? "left-0.5 bg-agent/20 ring-1 ring-agent/40" : "left-1/2 bg-white/[0.08] ring-1 ring-white/10",
        )}
      />
      <button
        type="button"
        role="radio"
        aria-checked={agentSide}
        disabled={busy}
        onClick={() => !agentSide && onChange("agent")}
        className={cn("relative z-10 flex h-full w-[76px] items-center justify-center gap-1.5 rounded-md transition-colors @xl/stage:w-24", agentSide ? "text-white" : "text-neutral-400 hover:text-neutral-200")}
      >
        {/* Greyed out when you drive: "offline" is the same opacity-50 grayscale look, but frozen. */}
        <AgentOrb state={agentSide ? "working" : "offline"} size={11} />
        Agent
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={!agentSide}
        disabled={busy}
        onClick={() => agentSide && onChange("user")}
        className={cn("relative z-10 flex h-full w-[76px] items-center justify-center gap-1.5 rounded-md transition-colors @xl/stage:w-24", !agentSide ? "text-white" : "text-neutral-400 hover:text-neutral-200")}
      >
        <MousePointer2 className={cn("size-3.5", !agentSide && "text-brand")} />
        You
      </button>
    </div>
  );
}

/** A ghost cursor at the agent's last action, with a ripple on each click. */
function AgentCursor({ step, rect }: { step: AgentStep; rect: ScreenRect }) {
  const d = parseDetail(step);
  if (!d || d.x == null || d.y == null || !d.frame) return null;
  const left = rect.left + (d.x / d.frame[0]) * rect.width;
  const top = rect.top + (d.y / d.frame[1]) * rect.height;
  const verb = ACTION_VERB[d.action ?? ""] ?? "Act";
  const clicky = d.action?.includes("click");
  return (
    <div className="pointer-events-none absolute z-10 transition-[left,top] duration-500 ease-[var(--ease-out)]" style={{ left, top }}>
      {clicky && <span key={String(step.id)} className="agent-ripple absolute top-0 left-0 size-10 rounded-full border-2 border-agent" />}
      <svg viewBox="0 0 20 20" className="relative -mt-0.5 -ml-0.5 size-5 drop-shadow-[0_2px_6px_rgba(0,0,0,0.5)]" aria-hidden>
        <path d="M3 2.5 16.5 9l-6 1.6L8 17z" fill="var(--agent)" stroke="white" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      <span className="absolute top-4 left-4 flex max-w-56 items-center gap-1 rounded-md bg-agent px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-white shadow-lg">
        {verb}
        {d.action === "type" && d.text && <span className="truncate opacity-80">“{d.text}”</span>}
        {d.action === "key" && d.keys && <span className="truncate opacity-80">{d.keys.join("+")}</span>}
      </span>
    </div>
  );
}

function Hud(props: {
  w: Workload;
  control: Control;
  goal?: string;
  step?: AgentStep;
  stepCount: number;
  startedAt: number;
  nudged: boolean;
  busy: boolean;
  onTakeOver: () => void;
  onHandBack: () => void;
}) {
  const { control, w } = props;
  const saving = w.status === "saving";
  // Don't tick while the HUD is hidden (the user has control).
  const now = useNow(1000, !(control === "user" && !saving));
  if (control === "user" && !saving) return null;
  const thought = props.step ? parseDetail(props.step)?.thought : undefined;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-4">
      <div
        className={cn(
          "glass pointer-events-auto flex w-full max-w-[560px] items-center gap-3 rounded-2xl py-2 pr-2 pl-2.5 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.6)] transition-transform duration-300",
          props.nudged && "animate-[hud-nudge_400ms_ease-in-out]",
        )}
      >
        {saving ? (
          <>
            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-white/[0.06]">
              <Expand className="size-4 animate-pulse text-neutral-300" />
            </span>
            <div className="min-w-0 flex-1 text-[13px]">
              <div className="font-medium">Saving your project</div>
              <div className="truncate text-[12px] text-neutral-400">Copying ~/Projects to durable storage</div>
            </div>
          </>
        ) : control === "agent" ? (
          <>
            <span className="grid size-8 shrink-0 place-items-center">
              <AgentOrb state="working" size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[13px]">
                <span className="truncate font-medium">{props.nudged ? "The agent is driving" : (props.step?.summary ?? "Starting…")}</span>
                <span className="ml-auto shrink-0 text-[11px] text-neutral-500 tabular">
                  {props.stepCount > 0 && `step ${props.stepCount} · `}
                  {props.startedAt && now ? duration(now - props.startedAt) : ""}
                </span>
              </div>
              <div className="truncate text-[12px] text-neutral-400">{props.nudged ? "Take over to use the mouse and keyboard yourself." : thought || props.goal}</div>
            </div>
            <Button size="sm" className="h-8 shrink-0 bg-white px-3 text-[13px] text-black hover:bg-white/90" disabled={props.busy} onClick={props.onTakeOver}>
              <Hand className="size-3.5" /> Take over
            </Button>
          </>
        ) : (
          <>
            <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand">
              <MousePointer2 className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">You have control</div>
              <div className="truncate text-[12px] text-neutral-400">Agent paused on “{props.goal}”</div>
            </div>
            <Button size="sm" variant="agent" className="h-8 shrink-0 px-3 text-[13px]" disabled={props.busy} onClick={props.onHandBack}>
              <Play className="size-3 fill-current" /> Hand back
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Not running: the screen-shaped placeholder ──────────────────────── */

function DesktopState({ w }: { w: Workload }) {
  const { busy, run } = useWorkloadAction(w.id);
  const booting = ["approved", "provisioning", "configuring"].includes(w.status);
  // Only the boot timer moves; stopped or failed machines don't need a clock.
  const now = useNow(1000, booting);

  if (w.status === "planned") {
    return (
      <div className="h-full overflow-y-auto canvas-dots">
        <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center px-6 py-12">
          <div className="eyebrow mb-3 text-neutral-500">Awaiting your approval</div>
          <PlanCard workloadId={w.id} />
          <p className="mt-4 text-center text-[12px] text-neutral-500">Nothing is billed until you approve.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto canvas-dots p-6">
      <div className="w-full max-w-2xl">
        <Monitor dim={!booting}>
          {booting ? (
            <div className="flex w-full max-w-sm flex-col">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[15px] font-medium text-white">Starting your desktop</span>
                <span className="text-[11px] text-neutral-500 tabular">{w.startedAt && now ? duration(now - ms(w.startedAt)) : ""}</span>
              </div>
              <p className="mb-5 text-[13px] text-neutral-400">Usually takes 5 to 10 minutes. You can close this tab.</p>
              <div className="progress-indeterminate mb-5 h-0.5 rounded-full bg-white/10" />
              <div className="dark">
                <BootProgress w={w} />
              </div>
            </div>
          ) : w.status === "stopped" ? (
            <div className="flex flex-col items-center text-center">
              <span className="mb-4 grid size-11 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-neutral-300">
                <Command className="size-5" />
              </span>
              <div className="text-[15px] font-medium text-white">Desktop paused</div>
              <p className="mt-1 max-w-xs text-[13px] leading-5 text-neutral-400">Your project is saved and billing is paused. Resuming restores everything in a few minutes.</p>
              <Button className="mt-5 bg-white text-black hover:bg-white/90" disabled={busy === "resume"} onClick={() => void run("resume")}>
                <Play className="size-3.5 fill-current" /> {busy === "resume" ? "Resuming…" : "Resume desktop"}
              </Button>
            </div>
          ) : (
            <div className="flex max-w-sm flex-col items-center text-center">
              <div className={cn("text-[15px] font-medium", w.status === "failed" ? "text-destructive" : "text-white")}>
                {w.status === "failed" ? "This desktop ran into a problem" : w.status === "stopping" ? "Stopping…" : w.status === "succeeded" ? "Session finished" : w.status === "cancelled" ? "Cancelled" : "Deleted"}
              </div>
              <p className="mt-1 text-[13px] leading-5 text-neutral-400">{w.statusDetail || "No machine is running or billing for this."}</p>
            </div>
          )}
        </Monitor>
        <div className="mx-auto mt-8 max-w-md">
          <div className="eyebrow mb-3 text-neutral-500">Activity</div>
          <div className="dark text-foreground">
            <EventFeed workloadId={w.id} limit={6} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Monitor({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return (
    <div className={cn("relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-white/[0.08] bg-[#08080a] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]", dim && "opacity-95")}>
      <div className="flex h-7 items-center gap-1.5 border-b border-white/[0.05] px-3">
        <span className="size-2 rounded-full bg-white/10" />
        <span className="size-2 rounded-full bg-white/10" />
        <span className="size-2 rounded-full bg-white/10" />
      </div>
      <div className="absolute inset-x-0 top-7 bottom-0 grid place-items-center p-8">{children}</div>
    </div>
  );
}

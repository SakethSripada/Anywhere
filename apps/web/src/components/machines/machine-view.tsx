"use client";

import type { Workload } from "@anywhere/stdb";
import { ChevronRight, Copy, MessageSquare, MoreHorizontal, Pause, Play, Save, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useSidebar } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAgentState } from "@/lib/agent";
import { useWorkload } from "@/lib/data";
import { cn } from "@/lib/utils";
import { MobileNavTrigger } from "../app/mobile-nav";
import { AgentOrb } from "@/components/bui/orb";
import { AppLogo, appKey } from "../app/app-logo";
import { AgentPanel, type AgentPanelHandle, type AgentPanelMemory } from "./agent-panel";
import { DesktopStage } from "./desktop-stage";
import { Insights } from "./insights";
import { ShareButton } from "./share-dialog";
import { JobStage } from "./job-stage";
import { LiveCost, Uptime, useWorkloadAction } from "./shared";
import { StatusChip } from "./status";

export function MachineView({ id }: { id: string }) {
  const wid = /^\d+$/.test(id) ? BigInt(id) : null;
  const { workload: w, ready } = useWorkload(wid);
  if (!w) {
    return (
      <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
        {ready ? "This machine doesn’t exist or isn’t yours." : <Skeleton className="h-5 w-48" />}
      </div>
    );
  }
  return <Workspace w={w} />;
}

let pendingRestore: ReturnType<typeof setTimeout> | null = null;

/**
 * One machine, one screen: the work itself fills the stage (the live desktop,
 * or the job's progress and output) and the agent rides alongside in a
 * collapsible panel that keeps the machine's conversation going.
 */
function Workspace({ w }: { w: Workload }) {
  const mobile = useIsMobile();
  const panel = usePanelRef();
  const agentRef = useRef<AgentPanelHandle>(null);
  const agentMemory = useRef<AgentPanelMemory>({ cid: null, draft: "" });
  const [open, setOpen] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [animating, setAnimating] = useState(false);
  const [view, setView] = useState<"work" | "insights">("work");
  const animTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nav = useSidebar();

  // The stage is the point of this page: fold the app nav to its icon rail
  // while you're here (on laptop-sized screens) and put it back when you leave.
  const navRef = useRef(nav);
  useEffect(() => {
    navRef.current = nav;
  });
  useEffect(() => {
    const { open: wasOpen, setOpen: setNav } = navRef.current;
    // Hopping straight to another machine: keep the rail folded, no flicker.
    if (pendingRestore) {
      clearTimeout(pendingRestore);
      pendingRestore = null;
    } else if (!wasOpen || window.innerWidth >= 1600) return;
    else setNav(false);
    return () => {
      pendingRestore = setTimeout(() => {
        pendingRestore = null;
        navRef.current.setOpen(true);
      }, 50);
    };
  }, []);

  useEffect(() => {
    document.title = `${w.title} · Anywhere`;
  }, [w.title]);

  function toggle(force?: boolean) {
    if (mobile) return setSheet((s) => force ?? !s);
    const p = panel.current;
    if (!p) return;
    const next = force ?? p.isCollapsed();
    if (next === !p.isCollapsed()) return;
    // Animate only programmatic toggles; dragging the handle stays 1:1.
    setAnimating(true);
    if (animTimer.current) clearTimeout(animTimer.current);
    animTimer.current = setTimeout(() => {
      animTimer.current = null;
      setAnimating(false);
    }, 480);
    setOpen(next);
    requestAnimationFrame(() => (next ? p.expand() : p.collapse()));
  }

  function askAgent() {
    toggle(true);
    setTimeout(() => agentRef.current?.focus(), 60);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const work = w.kind === "desktop" ? <DesktopStage w={w} onAskAgent={askAgent} /> : <JobStage w={w} />;
  // The desktop stays mounted while Insights is open, so its stream doesn't reconnect on every switch.
  const stage = (
    <>
      <div className={cn("h-full min-h-0", view !== "work" && "hidden")}>{work}</div>
      {view === "insights" && <Insights w={w} />}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header w={w} agentOpen={mobile ? sheet : open} onToggleAgent={() => toggle()} view={view} onView={setView} />
      {mobile ? (
        <>
          <div className="min-h-0 flex-1">{stage}</div>
          <Sheet open={sheet} onOpenChange={setSheet}>
            <SheetContent side="right" className="w-full p-0 sm:max-w-md" showCloseButton={false}>
              <SheetTitle className="sr-only">Agent</SheetTitle>
              <AgentPanel ref={agentRef} w={w} memory={agentMemory} onCollapse={() => setSheet(false)} />
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" data-animating={animating ? "true" : undefined}>
          <ResizablePanel id="stage" minSize="40%">
            <div className="h-full min-h-0">{stage}</div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel
            id="agent"
            panelRef={panel}
            defaultSize="380px"
            minSize="320px"
            maxSize="50%"
            collapsible
            collapsedSize="0px"
            onResize={(size) => !animTimer.current && setOpen(size.inPixels > 0)}
          >
            {/* Fixed-width content: the panel clips it while animating instead of re-wrapping every frame. */}
            <div className={cn("h-full w-full min-w-[320px] transition-opacity duration-300", !open && "opacity-0")}>
              {/* Collapsed, the panel used to stay fully live behind opacity-0 (subscriptions,
                  timers, orbs, screenshot fetches). Unmount it once the collapse finishes. */}
              {(open || animating) && <AgentPanel ref={agentRef} w={w} memory={agentMemory} onCollapse={() => toggle(false)} />}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}

function Header({
  w,
  agentOpen,
  onToggleAgent,
  view,
  onView,
}: {
  w: Workload;
  agentOpen: boolean;
  onToggleAgent: () => void;
  view: "work" | "insights";
  onView: (v: "work" | "insights") => void;
}) {
  const router = useRouter();
  const { busy, run } = useWorkloadAction(w.id);
  const agent = useAgentState(w);
  const [confirm, setConfirm] = useState<"stop" | "delete" | null>(null);
  const running = w.status === "running";
  const canDelete = !["terminated", "cancelled", "planned"].includes(w.status);
  const desktop = w.kind === "desktop";

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
      <MobileNavTrigger />
      <nav className="flex min-w-0 items-center gap-1 text-[13px]">
        <Link href="/machines" className="hidden shrink-0 text-muted-foreground transition-colors hover:text-foreground sm:inline">
          {desktop ? "Desktops" : "Jobs"}
        </Link>
        <ChevronRight className="hidden size-3.5 shrink-0 text-faint sm:inline" />
        <AppLogo app={appKey(w)} size={16} className="ml-0.5" />
        <h1 className="truncate font-medium">{w.title}</h1>
      </nav>
      <StatusChip status={w.status} className="ml-1 text-[12px]" />
      <div role="tablist" aria-label="View" className="ml-2 flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
        {(
          [
            ["work", desktop ? "Desktop" : "Job"],
            ["insights", "Insights"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => onView(key)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors",
              view === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="hidden items-center gap-3 pl-2 text-[12px] text-muted-foreground xl:flex">
        <span className="h-3.5 w-px bg-border" />
        <span>{w.gpuName}</span>
        <span className="h-3.5 w-px bg-border" />
        <span className="tabular">
          <Uptime w={w} />
        </span>
        <span className="h-3.5 w-px bg-border" />
        <LiveCost w={w} className="text-foreground" />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {desktop && w.status === "running" && <ShareButton w={w} />}
        {running && (
          <Button size="sm" variant="outline" onClick={() => setConfirm(desktop && w.stoppable ? "stop" : "delete")}>
            {desktop && w.stoppable ? <Pause /> : <Square className="size-3" />}
            <span className="hidden md:inline">{desktop ? (w.stoppable ? "Stop" : "Shut down") : "Stop job"}</span>
          </Button>
        )}
        {w.status === "stopped" && (
          <Button size="sm" disabled={busy === "resume"} onClick={() => void run("resume")}>
            <Play className="fill-current" /> Resume
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {w.conversationId > 0n && (
              <DropdownMenuItem onClick={() => router.push(`/c/${w.conversationId}`)}>
                <MessageSquare /> Open full conversation
              </DropdownMenuItem>
            )}
            {desktop && running && (
              <DropdownMenuItem disabled={busy === "save"} onClick={() => void run("save")}>
                <Save /> Save project files now
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(String(w.id));
                toast("Machine ID copied");
              }}
            >
              <Copy /> Copy machine ID
            </DropdownMenuItem>
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setConfirm("delete")}>
                  <Trash2 /> Delete machine
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="mx-0.5 h-5 w-px bg-border" />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onToggleAgent}
                aria-pressed={agentOpen}
                className={cn(
                  "flex h-7 items-center gap-2 rounded-control border pr-2.5 pl-2 text-[12.5px] font-medium transition-colors",
                  agentOpen ? "border-agent/30 bg-agent-soft text-foreground" : "bg-card text-muted-foreground hover:text-foreground",
                )}
              />
            }
          >
            <AgentOrb size={16} state={agent.working ? "working" : agent.control === "paused" ? "paused" : running ? "ready" : "offline"} />
            Agent
          </TooltipTrigger>
          <TooltipContent>
            {agentOpen ? "Hide" : "Show"} agent <span className="ml-1 opacity-60">⌘.</span>
          </TooltipContent>
        </Tooltip>
      </div>

      <Confirm
        open={confirm === "stop"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Stop this desktop?"
        description="Anywhere saves ~/Projects to durable storage, then stops the machine. Billing pauses and you can resume any time."
        action="Save and stop"
        onConfirm={async () => (await run("stop")) && setConfirm(null)}
      />
      <Confirm
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={running && !desktop ? "Stop this job?" : "Delete this machine?"}
        description={
          running
            ? desktop
              ? "Project files are saved before the machine is destroyed. Anything outside ~/Projects is lost."
              : "Training stops now. Checkpoints and outputs saved so far stay in your storage."
            : "The machine is destroyed permanently. Saved project files and outputs stay in your storage."
        }
        action={running && !desktop ? "Stop job" : "Delete machine"}
        destructive
        onConfirm={async () => (await run(w.status === "running" && w.kind === "batch" ? "stop" : "delete")) && setConfirm(null)}
      />
    </header>
  );
}

function Confirm(props: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; action: string; destructive?: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant={props.destructive ? "destructive" : "default"} onClick={props.onConfirm}>
            {props.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

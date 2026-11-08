"use client";

import type { Workload } from "@anywhere/stdb";
import { ArrowUpRight, Ban, MoreHorizontal, Pause, Play, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import { cn } from "@/lib/utils";
import { href } from "@/lib/workloads";
import { useWorkloadAction, type Action } from "./shared";

type Confirm = { action: Action; title: string; description: string; label: string; destructive?: boolean };

/**
 * Everything you can do to a machine from a list (sidebar, cards, the machines
 * table), offering only the actions its current state allows. Stopping and
 * deleting ask first; cancelling a plan that never ran doesn't need to.
 */
export function MachineMenu({ w, className, align = "end" }: { w: Workload; className?: string; align?: "start" | "end" }) {
  const { busy, run } = useWorkloadAction(w.id);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const desktop = w.kind === "desktop";
  const running = w.status === "running";
  const planned = w.status === "planned";
  const canDelete = !["terminated", "cancelled", "planned"].includes(w.status);

  const stop: Confirm | null = !running
    ? null
    : desktop && w.stoppable
      ? {
          action: "stop",
          title: "Stop this desktop?",
          description: "Anywhere saves ~/Projects, then stops the machine. Billing pauses and you can resume any time.",
          label: "Save and stop",
        }
      : desktop
        ? null
        : { action: "stop", title: "Stop this job?", description: "Training stops now. Checkpoints and outputs saved so far stay in your storage.", label: "Stop job", destructive: true };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Manage ${w.title}`}
              className={cn("text-muted-foreground hover:text-foreground", className)}
              onClick={(e) => e.stopPropagation()}
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-48" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem render={<Link href={href(w)} />}>
            <ArrowUpRight /> {planned ? "Review plan" : "Open"}
          </DropdownMenuItem>
          {planned && (
            <DropdownMenuItem disabled={busy === "cancel"} onClick={() => void run("cancel")}>
              <Ban /> Cancel plan
            </DropdownMenuItem>
          )}
          {stop && (
            <DropdownMenuItem onClick={() => setConfirm(stop)}>
              {desktop ? <Pause /> : <Square className="size-3.5" />} {desktop ? "Stop" : "Stop job"}
            </DropdownMenuItem>
          )}
          {w.status === "stopped" && (
            <DropdownMenuItem disabled={busy === "resume"} onClick={() => void run("resume")}>
              <Play /> Resume
            </DropdownMenuItem>
          )}
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  setConfirm({
                    action: "delete",
                    title: "Delete this machine?",
                    description: running
                      ? "Project files are saved before the machine is destroyed. Anything outside ~/Projects is lost."
                      : "The machine is destroyed permanently. Saved project files and outputs stay in your storage.",
                    label: "Delete machine",
                    destructive: true,
                  })
                }
              >
                <Trash2 /> Delete machine
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant={confirm?.destructive ? "destructive" : "default"}
              disabled={!!busy}
              onClick={async () => {
                if (confirm && (await run(confirm.action))) setConfirm(null);
              }}
            >
              {confirm?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

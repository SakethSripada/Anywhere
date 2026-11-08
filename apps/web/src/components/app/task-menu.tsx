"use client";

import { EyeOff, MoreHorizontal, Pencil } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { reducers, useReducer } from "@/lib/stdb";
import { cn } from "@/lib/utils";

/** Rename or hide a task (conversation) from the sidebar's Recent tasks list. */
export function TaskMenu({ id, title, className }: { id: bigint; title: string; className?: string }) {
  const rename = useReducer(reducers.renameConversation);
  const archive = useReducer(reducers.archiveConversation);
  const router = useRouter();
  const pathname = usePathname();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(title);
  const [busy, setBusy] = useState(false);

  async function hide() {
    try {
      await archive({ id });
      toast("Task hidden");
      // Hiding the task you're looking at takes you somewhere that still exists.
      if (pathname === `/c/${id}`) router.push("/");
    } catch (err) {
      toast.error("Couldn’t hide that task", { description: String((err as Error).message ?? err) });
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const next = name.trim();
    if (!next || next === title) return setEditing(false);
    setBusy(true);
    try {
      await rename({ id, title: next });
      setEditing(false);
    } catch (err) {
      toast.error("Couldn’t rename", { description: String((err as Error).message ?? err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`Manage ${title || "task"}`} className={cn("text-muted-foreground hover:text-foreground", className)} />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem
            onClick={() => {
              setName(title);
              setEditing(true);
            }}
          >
            <Pencil /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void hide()}>
            <EyeOff /> Hide
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename task</DialogTitle>
          </DialogHeader>
          <form onSubmit={save} className="grid gap-4">
            <Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-label="Task name" />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

"use client";

import { ArrowUp, Check, ChevronDown, FileText, Paperclip, Square, X } from "lucide-react";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, uploadDataset, useApi, type UploadProfile } from "@/lib/api";
import { useAccount } from "@/lib/data";
import { bytes } from "@/lib/format";
import { reducers, useReducer } from "@/lib/stdb";
import { cn } from "@/lib/utils";

type Attachment = { key: string; file: File; progress: number; uploadId?: number; profile?: UploadProfile; error?: string };

export type ComposerHandle = { focus(): void; fill(text: string): void };

const PREFS = [
  { value: "balanced", label: "Balanced", description: "Good hardware at a fair price" },
  { value: "cheapest", label: "Cheapest", description: "Lowest cost that fits the task" },
  { value: "fastest", label: "Fastest", description: "More GPU for quicker results" },
] as const;

export const Composer = forwardRef<
  ComposerHandle,
  {
    onSubmit: (text: string, uploadIds: number[]) => Promise<void>;
    placeholder?: string;
    autoFocus?: boolean;
    busy?: boolean;
    compact?: boolean;
    allowAttachments?: boolean;
  }
>(function Composer({ onSubmit, placeholder = "Ask Anywhere to do something…", autoFocus, busy, compact, allowAttachments = true }, ref) {
  const api = useApi();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    fill: (t) => {
      setText(t);
      requestAnimationFrame(() => {
        area.current?.focus();
        area.current?.setSelectionRange(t.length, t.length);
      });
    },
  }));

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const uploading = attachments.some((a) => a.uploadId === undefined && !a.error);
  const canSend = text.trim().length > 0 && !sending && !uploading;

  async function send() {
    if (!canSend) return;
    setSending(true);
    try {
      await onSubmit(text.trim(), attachments.flatMap((a) => (a.uploadId ? [a.uploadId] : [])));
      setText("");
      setAttachments([]);
    } catch (err) {
      toast.error("Message not sent", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setSending(false);
      area.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function attach(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files).slice(0, 4 - attachments.length)) {
      if (!/\.(jsonl|json|csv)$/i.test(file.name)) {
        toast.error("Unsupported file", { description: "Attach a .jsonl or .csv dataset." });
        continue;
      }
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      setAttachments((prev) => [...prev, { key, file, progress: 0 }]);
      const patch = (p: Partial<Attachment>) => setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, ...p } : a)));
      uploadDataset(api, file, (progress) => patch({ progress }))
        .then(({ uploadId, profile }) => patch({ uploadId, profile, progress: 1 }))
        .catch((err) => patch({ error: err instanceof ApiError ? err.message : "Upload failed" }));
    }
  }

  return (
    <div
      className="w-full rounded-2xl border bg-card transition-[border-color,box-shadow] focus-within:border-foreground/25"
      onDragOver={(e) => allowAttachments && e.preventDefault()}
      onDrop={(e) => {
        if (!allowAttachments) return;
        e.preventDefault();
        attach(e.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <AttachmentChip key={a.key} a={a} onRemove={() => setAttachments((p) => p.filter((x) => x.key !== a.key))} />
          ))}
        </div>
      )}
      <textarea
        ref={area}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        rows={1}
        maxLength={4000}
        placeholder={placeholder}
        aria-label="Message"
        className={cn(
          "block w-full resize-none bg-transparent px-4 text-[15px] leading-6 outline-none placeholder:text-muted-foreground",
          compact ? "min-h-11 pt-3" : "min-h-14 pt-4",
        )}
      />
      <div className="flex items-center gap-1 px-2.5 pb-2.5">
        {allowAttachments && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept=".jsonl,.json,.csv"
              multiple
              hidden
              onChange={(e) => {
                attach(e.target.files);
                e.target.value = "";
              }}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label="Attach a dataset" onClick={() => fileInput.current?.click()} />
                }
              >
                <Paperclip />
              </TooltipTrigger>
              <TooltipContent>Attach a dataset (.jsonl, .csv)</TooltipContent>
            </Tooltip>
            <PreferenceMenu />
          </>
        )}
        <Button
          size="icon-sm"
          onClick={() => void send()}
          disabled={!canSend && !busy}
          aria-label={busy && !text ? "Agent is working" : "Send"}
          className="ml-auto size-8 rounded-lg"
        >
          {busy && !text.trim() ? <Square className="size-3 fill-current" /> : <ArrowUp className="size-4" />}
        </Button>
      </div>
    </div>
  );
});

function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  const done = a.uploadId !== undefined;
  return (
    <div className={cn("group relative flex h-12 max-w-64 items-center gap-2.5 overflow-hidden rounded-xl border bg-muted/40 pr-8 pl-2", a.error && "border-destructive/40")}>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground shadow-xs">
        <FileText className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium">{a.file.name}</div>
        <div className={cn("truncate text-xs", a.error ? "text-destructive" : "text-muted-foreground")}>
          {a.error ?? (done && a.profile ? `${a.profile.rows.toLocaleString()} rows · ${String(a.profile.schema).replace("_", "/")}` : `Uploading · ${bytes(a.file.size)}`)}
        </div>
      </div>
      {!done && !a.error && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-border">
          <div className="h-full bg-foreground transition-[width]" style={{ width: `${a.progress * 100}%` }} />
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${a.file.name}`}
        className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function PreferenceMenu() {
  const { account } = useAccount();
  const update = useReducer(reducers.updatePreferences);
  if (!account) return null;
  const current = PREFS.find((p) => p.value === account.preference) ?? PREFS[0];

  async function choose(value: string) {
    if (!account || value === account.preference) return;
    try {
      await update({ preference: value, monthlyCapCents: account.monthlyCapCents, approvalThresholdCents: account.approvalThresholdCents });
    } catch (err) {
      toast.error("Couldn’t update preference", { description: String((err as Error).message ?? err) });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" />}>
        {current.label}
        <ChevronDown className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Optimize compute for</DropdownMenuLabel>
          {PREFS.map((p) => (
            <DropdownMenuItem key={p.value} onClick={() => void choose(p.value)} className="items-start py-2">
              <div className="flex flex-1 flex-col">
                <span>{p.label}</span>
                <span className="text-xs text-muted-foreground">{p.description}</span>
              </div>
              {p.value === account.preference && <Check className="mt-0.5 size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

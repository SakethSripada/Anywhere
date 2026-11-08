"use client";

import { ArrowUp, AtSign, Check, ChevronDown, FileText, Paperclip, Square, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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

export type ComposerHandle = { focus(): void; fill(text: string): void; value(): string };

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
    /** The agent is mid-task: an empty send button becomes Stop. */
    busy?: boolean;
    onStop?: () => void;
    /** What the agent is focused on, shown as a chip. */
    context?: string;
    compact?: boolean;
    allowAttachments?: boolean;
  }
>(function Composer({ onSubmit, placeholder = "Ask Anywhere to do something…", autoFocus, busy, onStop, context, compact, allowAttachments = true }, ref) {
  const api = useApi();
  const [text, setText] = useState("");
  // Latest text for `value()`, so a handle captured earlier still reads current input.
  const textRef = useRef(text);
  useLayoutEffect(() => {
    textRef.current = text;
  }, [text]);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // In-flight uploads, cancelled when their chip is removed or the composer unmounts.
  const uploads = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const inflight = uploads.current;
    return () => {
      for (const ctl of inflight.values()) ctl.abort();
      inflight.clear();
    };
  }, []);

  useImperativeHandle(ref, () => ({
    value: () => textRef.current,
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
      const ctl = new AbortController();
      uploads.current.set(key, ctl);
      uploadDataset(api, file, (progress) => patch({ progress }), ctl.signal)
        .then(({ uploadId, profile }) => !ctl.signal.aborted && patch({ uploadId, profile, progress: 1 }))
        .catch((err) => !ctl.signal.aborted && patch({ error: err instanceof ApiError ? err.message : "Upload failed" }))
        .finally(() => uploads.current.get(key) === ctl && uploads.current.delete(key));
    }
  }

  const stoppable = busy && !!onStop && !text.trim();

  return (
    <div
      className={cn(
        "group/composer flex w-full cursor-text flex-col gap-2 border border-line bg-field shadow-[0_1px_2px_rgba(0,0,0,0.035)] transition-[border-color,box-shadow] duration-150 focus-within:border-line-strong",
        compact ? "rounded-control p-2.5" : "rounded-window p-3",
      )}
      onClick={(e) => e.target === e.currentTarget && area.current?.focus()}
      onDragOver={(e) => allowAttachments && e.preventDefault()}
      onDrop={(e) => {
        if (!allowAttachments) return;
        e.preventDefault();
        attach(e.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.key}
              a={a}
              onRemove={() => {
                uploads.current.get(a.key)?.abort();
                setAttachments((p) => p.filter((x) => x.key !== a.key));
              }}
            />
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
          "block w-full resize-none bg-transparent text-ink outline-none placeholder:text-ink-3",
          compact ? "min-h-5 text-[13px] leading-[1.45]" : "min-h-12 px-0.5 text-[15px] leading-6",
        )}
      />
      <div className="flex items-center gap-1">
        {context && (
          <span className="inline-flex h-5.5 items-center gap-1 rounded-chip bg-card px-1.5 text-[11.5px] text-ink-2 shadow-hairline">
            <AtSign className="size-3 text-ink-3" />
            {context}
          </span>
        )}
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
                render={<Button variant="ghost" size="icon-sm" className="text-ink-3 hover:bg-hover-2 hover:text-ink-2" aria-label="Attach a dataset" onClick={() => fileInput.current?.click()} />}
              >
                <Paperclip />
              </TooltipTrigger>
              <TooltipContent>Attach a dataset (.jsonl, .csv)</TooltipContent>
            </Tooltip>
            <PreferenceMenu />
          </>
        )}
        <span className="flex-1" />
        <span className="hidden pr-1.5 text-[11px] text-ink-3 group-focus-within/composer:inline">{text.trim() ? "↵ send · ⇧↵ newline" : ""}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => (stoppable ? onStop?.() : void send())}
                disabled={!canSend && !stoppable}
                aria-label={stoppable ? "Stop the agent" : "Send"}
                className="flex size-7 shrink-0 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96]"
                style={{ background: canSend || stoppable ? "var(--ink)" : "var(--line-strong)", color: canSend || stoppable ? "var(--background)" : "var(--ink-2)" }}
              />
            }
          >
            {stoppable ? <Square className="size-2.5 fill-current" /> : <ArrowUp className="size-4" strokeWidth={2.4} />}
          </TooltipTrigger>
          <TooltipContent>{stoppable ? "Stop the agent" : "Send"}</TooltipContent>
        </Tooltip>
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
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="text-ink-3 hover:bg-hover-2 hover:text-ink-2" />}>
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

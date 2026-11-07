"use client";

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError, uploadDataset, useApi, type UploadProfile } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAccount } from "@/lib/data";
import { bytes } from "@/lib/format";
import { reducers, useReducer } from "@/lib/stdb";
import { IconArrowUp, IconChevronDown, IconClose, IconFile, IconPaperclip } from "../icons";
import { IconButton } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { MenuContent, MenuGroup, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuRoot, MenuTrigger } from "../ui/menu";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";

type Attachment = {
  key: string;
  file: File;
  progress: number;
  uploadId?: number;
  profile?: UploadProfile;
  error?: string;
};

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
    size?: "hero" | "dock";
  }
>(function Composer({ onSubmit, placeholder = "Describe what you want to do…", autoFocus, size = "dock" }, ref) {
  const api = useApi();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    fill: (t: string) => {
      setText(t);
      requestAnimationFrame(() => {
        const el = area.current;
        if (el) {
          el.focus();
          el.setSelectionRange(t.length, t.length);
        }
      });
    },
  }));

  // Auto-grow up to a comfortable maximum.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const uploading = attachments.some((a) => a.uploadId === undefined && !a.error);
  const canSend = text.trim().length > 0 && !sending && !uploading;

  async function send() {
    if (!canSend) return;
    setSending(true);
    try {
      await onSubmit(
        text.trim(),
        attachments.flatMap((a) => (a.uploadId ? [a.uploadId] : [])),
      );
      setText("");
      setAttachments([]);
    } catch (err) {
      toast.error("Message not sent", err instanceof ApiError ? err.message : undefined);
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

  async function attach(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files).slice(0, 4 - attachments.length)) {
      if (!/\.(jsonl|json|csv)$/i.test(file.name)) {
        toast.error("Unsupported file", "Attach a .jsonl or .csv dataset.");
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
      className={cn(
        "group/composer relative w-full rounded-2xl bg-raised transition-shadow duration-200",
        "shadow-[inset_0_1px_0_0_oklch(1_0_0/0.05),0_0_0_1px_var(--color-line-strong),0_12px_32px_-16px_oklch(0_0_0/0.6)]",
        "focus-within:shadow-[inset_0_1px_0_0_oklch(1_0_0/0.05),0_0_0_1px_oklch(1_0_0/0.2),0_0_0_4px_oklch(1_0_0/0.03),0_12px_32px_-16px_oklch(0_0_0/0.6)]",
      )}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void attach(e.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attachments.map((a) => (
            <AttachmentChip key={a.key} a={a} onRemove={() => setAttachments((prev) => prev.filter((x) => x.key !== a.key))} />
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
        aria-label="Message Anywhere"
        className={cn(
          "block w-full resize-none bg-transparent px-4 text-fg outline-none placeholder:text-fg-faint",
          size === "hero" ? "min-h-[84px] pt-4 text-md" : "min-h-[52px] pt-3.5 text-base",
        )}
      />
      <div className="flex items-center gap-1 px-2 pt-1 pb-2">
        <input
          ref={fileInput}
          type="file"
          accept=".jsonl,.json,.csv"
          multiple
          hidden
          onChange={(e) => {
            void attach(e.target.files);
            e.target.value = "";
          }}
        />
        <Tooltip content="Attach a dataset">
          <IconButton label="Attach a dataset" onClick={() => fileInput.current?.click()}>
            <IconPaperclip />
          </IconButton>
        </Tooltip>
        <PreferenceMenu />
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1 text-2xs text-fg-faint opacity-0 transition-opacity duration-200 group-focus-within/composer:opacity-100 sm:flex">
            <Kbd>⇧</Kbd>
            <Kbd>↵</Kbd>
            <span className="ml-0.5">new line</span>
          </span>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="Send"
            className={cn(
              "grid size-8 place-items-center rounded-full outline-none transition-[background-color,color,transform,box-shadow] duration-150 focus-ring",
              canSend
                ? "bg-fg text-fg-inverse hover:scale-105 active:scale-95"
                : "bg-white/[0.06] text-fg-faint",
            )}
          >
            <IconArrowUp size={16} className={cn(sending && "animate-pulse")} />
          </button>
        </div>
      </div>
    </div>
  );
});

function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  const done = a.uploadId !== undefined;
  return (
    <div
      className={cn(
        "group relative flex h-11 max-w-64 animate-rise items-center gap-2.5 overflow-hidden rounded-lg bg-overlay pr-8 pl-2.5",
        "shadow-[inset_0_0_0_1px_var(--color-line-strong)]",
        a.error && "shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-bad)_45%,transparent)]",
      )}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-white/[0.05] text-fg-subtle">
        <IconFile size={14} />
      </span>
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-fg">{a.file.name}</div>
        <div className={cn("truncate text-2xs", a.error ? "text-bad" : "text-fg-subtle")}>
          {a.error
            ? a.error
            : done && a.profile
              ? `${a.profile.rows.toLocaleString()} rows · ${String(a.profile.schema).replace("_", "/")}`
              : `Uploading · ${bytes(a.file.size)}`}
        </div>
      </div>
      {!done && !a.error && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/[0.05]">
          <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${a.progress * 100}%` }} />
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${a.file.name}`}
        className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-fg-faint opacity-0 transition-[opacity,background-color,color] duration-100 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
      >
        <IconClose size={12} />
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
      await update({
        preference: value,
        monthlyCapCents: account.monthlyCapCents,
        approvalThresholdCents: account.approvalThresholdCents,
      });
    } catch (err) {
      toast.error("Couldn't update preference", String((err as Error).message ?? err));
    }
  }

  return (
    <MenuRoot>
      <MenuTrigger
        className={cn(
          "flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-fg-subtle outline-none",
          "transition-colors duration-100 hover:bg-hover hover:text-fg-muted data-[popup-open]:bg-selected data-[popup-open]:text-fg focus-ring",
        )}
      >
        {current.label}
        <IconChevronDown size={12} className="text-fg-faint" />
      </MenuTrigger>
      <MenuContent side="top" width="w-64">
        <MenuGroup>
          <MenuLabel>Optimize for</MenuLabel>
        </MenuGroup>
        <MenuRadioGroup value={account.preference} onValueChange={(v) => void choose(v as string)}>
          {PREFS.map((p) => (
            <MenuRadioItem key={p.value} value={p.value} description={p.description}>
              {p.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </MenuRoot>
  );
}

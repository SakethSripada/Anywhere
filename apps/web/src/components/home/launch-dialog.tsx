"use client";

import { FileText, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ApiError, uploadDataset, useApi, type UploadProfile } from "@/lib/api";
import { useAccount } from "@/lib/data";
import { bytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Template } from "./templates";

const HOURS = ["1", "2", "4", "8"];
const SIZES = [
  { value: "3", label: "≤ 3B" },
  { value: "8", label: "7–8B" },
  { value: "14", label: "13–14B" },
];

/**
 * Structured launch: pick a few options and get a validated plan straight from
 * the deterministic planner — no language model in the loop.
 */
export function LaunchDialog({ template, onOpenChange }: { template: Template | null; onOpenChange: (open: boolean) => void }) {
  const api = useApi();
  const router = useRouter();
  const { account } = useAccount();
  const [hours, setHours] = useState("2");
  const [app, setApp] = useState<string | undefined>(template?.defaultApp);
  const [pref, setPref] = useState<string>(account?.preference ?? "balanced");
  const [size, setSize] = useState("8");
  const [epochs, setEpochs] = useState("3");
  const [note, setNote] = useState("");
  const [upload, setUpload] = useState<{ file: File; progress: number; id?: number; profile?: UploadProfile; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const t = template;
  const isTune = t?.kind === "fine_tune";
  const ready = !isTune || upload?.id !== undefined;

  function pick(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!/\.(jsonl|json|csv)$/i.test(file.name)) return toast.error("Use a .jsonl or .csv dataset");
    setUpload({ file, progress: 0 });
    uploadDataset(api, file, (progress) => setUpload((u) => (u ? { ...u, progress } : u)))
      .then(({ uploadId, profile }) => setUpload((u) => (u ? { ...u, id: uploadId, profile, progress: 1 } : u)))
      .catch((err) => setUpload((u) => (u ? { ...u, error: err instanceof ApiError ? err.message : "Upload failed" } : u)));
  }

  async function submit() {
    if (!t) return;
    setBusy(true);
    const summary = note.trim() || t.summary(app);
    const body = isTune
      ? { kind: "fine_tune", summary, model_params_billions: Number(size), epochs: Number(epochs), upload_id: upload?.id, preference: pref }
      : { kind: "desktop", summary, application: app ?? t.defaultApp, session_hours: Number(hours), preference: pref };
    try {
      const res = await api.post<{ conversation_id: number; ok: boolean; message?: string }>("/v1/workloads/plan", body);
      onOpenChange(false);
      router.push(`/c/${res.conversation_id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Older control plane: fall back to asking the agent.
        const text = isTune
          ? `${summary}. Base model about ${size}B parameters, ${epochs} epochs, optimise for ${pref}.`
          : `${summary}. I'll use it for about ${hours} hours; optimise for ${pref}.`;
        const res = await api.post<{ conversation_id: number }>("/v1/chat", { text, upload_ids: upload?.id ? [upload.id] : [] });
        onOpenChange(false);
        router.push(`/c/${res.conversation_id}`);
      } else {
        toast.error("Couldn’t create a plan", { description: err instanceof ApiError ? err.message : undefined });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!t} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {t && (
          <>
            <DialogHeader>
              <div className="mb-1 grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
                <t.icon className="size-5" />
              </div>
              <DialogTitle>{t.title}</DialogTitle>
              <DialogDescription>
                Anywhere picks the hardware and shows you the cost before anything is billed.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-5 py-1">
              {t.apps && (
                <Field label="Environment">
                  <ToggleGroup value={[app ?? ""]} onValueChange={(v) => v[0] && setApp(String(v[0]))} variant="outline" className="w-fit">
                    {t.apps.map((a) => (
                      <ToggleGroupItem key={a.value} value={a.value} className="px-3">
                        {a.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
              )}

              {isTune ? (
                <>
                  <Field label="Dataset" hint=".jsonl or .csv — chat messages, prompt/response pairs, or plain text">
                    <input ref={fileInput} type="file" accept=".jsonl,.json,.csv" hidden onChange={(e) => pick(e.target.files)} />
                    {upload ? (
                      <div className={cn("relative flex items-center gap-3 overflow-hidden rounded-lg border px-3 py-2.5", upload.error && "border-destructive/50")}>
                        <FileText className="size-4 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{upload.file.name}</div>
                          <div className={cn("text-xs", upload.error ? "text-destructive" : "text-muted-foreground")}>
                            {upload.error ?? (upload.profile ? `${upload.profile.rows.toLocaleString()} rows · ${String(upload.profile.schema).replace("_", "/")}` : `Uploading · ${bytes(upload.file.size)}`)}
                          </div>
                        </div>
                        <Button variant="ghost" size="icon-xs" aria-label="Remove dataset" onClick={() => setUpload(null)}>
                          <X />
                        </Button>
                        {upload.id === undefined && !upload.error && (
                          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-border">
                            <div className="h-full bg-primary transition-[width]" style={{ width: `${upload.progress * 100}%` }} />
                          </div>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInput.current?.click()}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          pick(e.dataTransfer.files);
                        }}
                        className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground"
                      >
                        <Upload className="size-4" />
                        Drop a file or click to upload
                      </button>
                    )}
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Base model size">
                      <Choice value={size} onChange={setSize} options={SIZES} />
                    </Field>
                    <Field label="Epochs">
                      <Choice value={epochs} onChange={setEpochs} options={["1", "2", "3", "5"].map((v) => ({ value: v, label: v }))} />
                    </Field>
                  </div>
                </>
              ) : (
                <Field label="How long will you work?" hint="An estimate for the cost preview — you can stop or resume any time.">
                  <Choice value={hours} onChange={setHours} options={HOURS.map((h) => ({ value: h, label: `${h} h` }))} />
                </Field>
              )}

              <Field label="Optimise for">
                <Choice
                  value={pref}
                  onChange={setPref}
                  options={[
                    { value: "cheapest", label: "Lowest cost" },
                    { value: "balanced", label: "Balanced" },
                    { value: "fastest", label: "Speed" },
                  ]}
                />
              </Field>

              <Field label="Anything else?" optional>
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={isTune ? "e.g. Make it draft replies in our support tone" : "e.g. A low-poly island scene for a mobile game"}
                  className="min-h-16 resize-none"
                  maxLength={400}
                />
              </Field>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void submit()} disabled={!ready || busy}>
                {busy ? "Planning…" : "Review plan"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, optional, children }: { label: string; hint?: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label className="text-[13px]">
        {label} {optional && <span className="font-normal text-muted-foreground">optional</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Choice({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <ToggleGroup value={[value]} onValueChange={(v) => v[0] && onChange(String(v[0]))} variant="outline" className="w-fit">
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className="px-3 data-[pressed]:bg-accent data-[pressed]:text-accent-foreground">
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

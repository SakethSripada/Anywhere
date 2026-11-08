"use client";

import type RFB from "@novnc/novnc";
import { Loader2, RotateCw, WifiOff } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Phase = "connecting" | "live" | "lost" | "failed";
export type Scale = "fit" | "native";
export type Quality = "high" | "balanced" | "low";

/** Where the remote framebuffer is drawn inside the frame, for overlays like the agent cursor. */
export type ScreenRect = { left: number; top: number; width: number; height: number; fbWidth: number; fbHeight: number };

export type VncHandle = {
  frame: HTMLDivElement | null;
  screenshot(): string | null;
  ctrlAltDel(): void;
  paste(text: string): void;
  focus(): void;
  reconnect(): void;
};

const QUALITY: Record<Quality, { q: number; c: number }> = {
  high: { q: 8, c: 1 },
  balanced: { q: 6, c: 2 },
  low: { q: 3, c: 6 },
};

/**
 * Live desktop over noVNC. The browser never talks to the VM: `streamUrl` returns
 * a control-plane WebSocket URL (a 60-second ticket for the owner, or a watch
 * link's token), and the control plane relays the stream through an SSH tunnel
 * to the instance's loopback-only VNC server.
 */
export const VncScreen = forwardRef<
  VncHandle,
  {
    /** Identifies the stream; a new key reconnects. */
    streamKey: string;
    streamUrl: () => Promise<string>;
    viewOnly: boolean;
    scale?: Scale;
    quality?: Quality;
    overlay?: ReactNode;
    className?: string;
    onPhase?: (phase: Phase) => void;
    onRect?: (rect: ScreenRect | null) => void;
    onRemoteClipboard?: (text: string) => void;
  }
>(function VncScreen({ streamKey, streamUrl, viewOnly, scale = "fit", quality = "balanced", overlay, className, onPhase, onRect, onRemoteClipboard }, ref) {
  const frame = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const opts = useRef({ viewOnly, scale, quality });
  const callbacks = useRef({ onPhase, onRect, onRemoteClipboard });
  const [phase, setPhase] = useState<Phase>("connecting");
  // `generation` re-runs the connect effect; the retry count lives in a ref so
  // resetting it on a successful connect doesn't tear that connection down.
  const [generation, setGeneration] = useState(0);
  const tries = useRef(0);
  const urlRef = useRef(streamUrl);

  useEffect(() => {
    callbacks.current = { onPhase, onRect, onRemoteClipboard };
    urlRef.current = streamUrl;
  });

  useEffect(() => {
    callbacks.current.onPhase?.(phase);
  }, [phase]);

  // Live-apply settings without reconnecting.
  useEffect(() => {
    opts.current = { viewOnly, scale, quality };
    const c = rfb.current;
    if (!c) return;
    c.viewOnly = viewOnly;
    c.scaleViewport = scale === "fit";
    c.clipViewport = scale !== "fit";
    c.dragViewport = false;
    c.qualityLevel = QUALITY[quality].q;
    c.compressionLevel = QUALITY[quality].c;
  }, [viewOnly, scale, quality]);

  const lastRect = useRef<ScreenRect | null | undefined>(undefined);
  const measure = useCallback(() => {
    const canvas = target.current?.querySelector("canvas");
    const box = frame.current?.getBoundingClientRect();
    let next: ScreenRect | null = null;
    if (canvas && box && canvas.width) {
      const r = canvas.getBoundingClientRect();
      next = { left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height, fbWidth: canvas.width, fbHeight: canvas.height };
    }
    // Only report real changes; a fresh object every call re-renders the stage.
    const prev = lastRect.current;
    const same =
      prev === next ||
      (!!prev && !!next && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height && prev.fbWidth === next.fbWidth && prev.fbHeight === next.fbHeight);
    if (same) return;
    lastRect.current = next;
    callbacks.current.onRect?.(next);
  }, []);

  useEffect(() => {
    if (phase !== "live") return;
    // noVNC rescales asynchronously after a resize; re-measure for a moment, then stop.
    let timers: ReturnType<typeof setTimeout>[] = [];
    const settle = () => {
      timers.forEach(clearTimeout);
      timers = [150, 500, 1200].map((d) => setTimeout(measure, d));
    };
    const ro = new ResizeObserver(() => {
      measure();
      settle();
    });
    if (frame.current) ro.observe(frame.current);
    const canvas = target.current?.querySelector("canvas");
    if (canvas) ro.observe(canvas);
    measure();
    settle();
    return () => {
      ro.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [phase, measure, scale]);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const backoff = () => {
      if (cancelled) return;
      const n = tries.current;
      if (n < 6) {
        tries.current = n + 1;
        setPhase("lost");
        retry = setTimeout(() => setGeneration((g) => g + 1), Math.min(1000 * 2 ** n, 10_000));
      } else setPhase("failed");
    };
    (async () => {
      try {
        const [{ default: RFBClass }, url] = await Promise.all([import("@novnc/novnc"), urlRef.current()]);
        if (cancelled || !target.current) return;
        const client = new RFBClass(target.current, url, { wsProtocols: ["binary"], shared: true });
        const o = opts.current;
        client.scaleViewport = o.scale === "fit";
        client.clipViewport = o.scale !== "fit";
        client.resizeSession = false;
        client.background = "transparent";
        client.qualityLevel = QUALITY[o.quality].q;
        client.compressionLevel = QUALITY[o.quality].c;
        client.viewOnly = o.viewOnly;
        client.addEventListener("connect", () => {
          if (cancelled) return;
          setPhase("live");
          tries.current = 0;
        });
        client.addEventListener("disconnect", () => {
          // A late event from a superseded client must not clear the current one.
          if (rfb.current === client) rfb.current = null;
          backoff();
        });
        client.addEventListener("clipboard", (e) => {
          const text = (e as CustomEvent<{ text: string }>).detail?.text;
          if (text) callbacks.current.onRemoteClipboard?.(text);
        });
        rfb.current = client;
      } catch {
        backoff();
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      rfb.current?.disconnect();
      rfb.current = null;
    };
    // `generation` drives reconnects; settings are applied live above.
  }, [streamKey, generation]);

  const reconnect = useCallback(() => {
    setPhase("connecting");
    tries.current = 0;
    setGeneration((g) => g + 1);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      get frame() {
        return frame.current;
      },
      screenshot: () => target.current?.querySelector("canvas")?.toDataURL("image/png") ?? null,
      ctrlAltDel: () => rfb.current?.sendCtrlAltDel(),
      paste: (text) => rfb.current?.clipboardPasteFrom(text),
      focus: () => rfb.current?.focus({ preventScroll: true }),
      reconnect,
    }),
    [reconnect],
  );

  return (
    <div ref={frame} className={cn("relative h-full w-full overflow-hidden canvas-dots", className)}>
      <div ref={target} className={cn("absolute inset-0 [&_canvas]:outline-none!", scale === "native" && "overflow-auto")} />
      {phase !== "live" && (
        <div className="absolute inset-0 grid place-items-center text-neutral-400">
          {phase === "failed" ? (
            <div className="flex flex-col items-center gap-3 text-center text-sm">
              <span className="grid size-10 place-items-center rounded-xl border border-white/10 bg-white/5">
                <WifiOff className="size-4.5" />
              </span>
              <div>
                <div className="font-medium text-neutral-200">The desktop stream isn’t responding</div>
                <div className="mt-0.5 text-[13px] text-neutral-500">The machine is still running. Only the connection dropped.</div>
              </div>
              <Button size="sm" variant="secondary" onClick={reconnect}>
                <RotateCw /> Reconnect
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="relative grid size-12 place-items-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-white/5" />
                <Loader2 className="size-5 animate-spin text-neutral-300" />
              </div>
              <span className="text-[13px]">{phase === "lost" ? "Reconnecting to the desktop…" : "Connecting to the desktop…"}</span>
              <span className="text-[11px] text-neutral-600">encrypted tunnel · noVNC</span>
            </div>
          )}
        </div>
      )}
      {overlay}
    </div>
  );
});

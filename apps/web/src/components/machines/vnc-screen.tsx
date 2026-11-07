"use client";

import type RFB from "@novnc/novnc";
import { Loader2, Maximize, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApi } from "@/lib/api";
import { apiWsUrl } from "@/lib/config";
import { cn } from "@/lib/utils";

type Phase = "connecting" | "live" | "lost" | "failed";

/**
 * Live desktop over noVNC. The browser never talks to the VM: it trades its
 * identity for a 60-second ticket and the control plane relays the stream
 * through an SSH tunnel to the instance's loopback-only VNC server.
 */
export function VncScreen({ workloadId, viewOnly, overlay, className }: { workloadId: bigint; viewOnly: boolean; overlay?: ReactNode; className?: string }) {
  const api = useApi();
  const frame = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const viewOnlyRef = useRef(viewOnly);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    if (rfb.current) rfb.current.viewOnly = viewOnly;
  }, [viewOnly]);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const backoff = () => {
      if (cancelled) return;
      if (attempt < 6) {
        setPhase("lost");
        retry = setTimeout(() => setAttempt((a) => a + 1), Math.min(1000 * 2 ** attempt, 10_000));
      } else setPhase("failed");
    };
    (async () => {
      try {
        const [{ default: RFBClass }, { ticket }] = await Promise.all([
          import("@novnc/novnc"),
          api.post<{ ticket: string }>(`/v1/desktops/${workloadId}/session`),
        ]);
        if (cancelled || !target.current) return;
        const client = new RFBClass(target.current, apiWsUrl(`/v1/desktops/${workloadId}/vnc?ticket=${encodeURIComponent(ticket)}`), {
          wsProtocols: ["binary"],
          shared: true,
        });
        client.scaleViewport = true;
        client.resizeSession = false;
        client.background = "transparent";
        client.qualityLevel = 7;
        client.compressionLevel = 2;
        client.viewOnly = viewOnlyRef.current;
        client.addEventListener("connect", () => !cancelled && setPhase("live"));
        client.addEventListener("disconnect", () => {
          rfb.current = null;
          backoff();
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
  }, [api, workloadId, attempt]);

  const reconnect = () => {
    setPhase("connecting");
    setAttempt((a) => (phase === "failed" ? 0 : a + 1));
  };
  const fullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void frame.current?.requestFullscreen();
  }, []);

  return (
    <div ref={frame} className={cn("group/screen relative h-full w-full overflow-hidden bg-screen", className)}>
      <div ref={target} className="absolute inset-0 [&_canvas]:outline-none!" />
      {phase !== "live" && (
        <div className="absolute inset-0 grid place-items-center bg-screen text-neutral-400">
          {phase === "failed" ? (
            <div className="flex flex-col items-center gap-3 text-sm">
              The desktop stream isn’t responding.
              <Button size="sm" variant="secondary" onClick={reconnect}>
                <RotateCw /> Reconnect
              </Button>
            </div>
          ) : (
            <span className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {phase === "lost" ? "Reconnecting to the desktop" : "Connecting to the desktop"}
            </span>
          )}
        </div>
      )}
      <div className="absolute top-3 right-3 flex gap-1 opacity-0 transition-opacity group-hover/screen:opacity-100 focus-within:opacity-100">
        <Tooltip>
          <TooltipTrigger render={<Button size="icon-sm" variant="secondary" aria-label="Reconnect" onClick={reconnect} />}>
            <RotateCw />
          </TooltipTrigger>
          <TooltipContent>Reconnect</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button size="icon-sm" variant="secondary" aria-label="Full screen" onClick={fullscreen} />}>
            <Maximize />
          </TooltipTrigger>
          <TooltipContent>Full screen</TooltipContent>
        </Tooltip>
      </div>
      {overlay}
    </div>
  );
}

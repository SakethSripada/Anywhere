"use client";

import Script from "next/script";
import { createElement, useEffect, useState } from "react";
import { config } from "@/lib/config";

/**
 * A scene built on an Anywhere GPU, as a 3D model anyone with the link can spin, zoom and
 * (on phones that support it) place in AR. Uses Google's <model-viewer> web component.
 */
export function ModelView({ token }: { token: string }) {
  const [info, setInfo] = useState<{ title: string; poster?: string } | null>(null);
  const [missing, setMissing] = useState(false);
  const src = `${config.apiUrl}/v1/models/${encodeURIComponent(token)}/model.glb`;

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`${config.apiUrl}/v1/models/${encodeURIComponent(token)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((v: { title: string; poster?: string }) => setInfo(v))
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) setMissing(true);
      });
    return () => ctrl.abort();
  }, [token]);

  return (
    <main className="flex h-dvh flex-col bg-[#0b0b0d] text-white">
      <Script type="module" src="https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js" strategy="afterInteractive" />
      <header className="flex shrink-0 items-baseline gap-3 px-5 pt-5 pb-3">
        <span className="text-[15px] font-semibold tracking-[-0.01em]">Anywhere</span>
        <span className="min-w-0 truncate text-[13px] text-white/60">{missing ? "This 3D link doesn’t exist" : (info?.title ?? "Loading…")}</span>
      </header>
      {!missing &&
        createElement("model-viewer", {
          src,
          poster: info?.poster,
          alt: info?.title ?? "3D scene",
          "camera-controls": true,
          "auto-rotate": true,
          "touch-action": "pan-y",
          "shadow-intensity": "1",
          exposure: "1.1",
          "environment-image": "neutral",
          ar: true,
          style: { flex: 1, width: "100%", background: "radial-gradient(circle at 50% 40%, #1d1d24, #0b0b0d)" },
        })}
      <footer className="shrink-0 px-5 py-4 text-center text-[12px] text-white/50">Drag to spin · pinch to zoom · built live on an NVIDIA GPU</footer>
    </main>
  );
}

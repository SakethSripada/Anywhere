import type { Workload } from "@anywhere/stdb";
import { parsePlan } from "@/lib/plan";
import { cn } from "@/lib/utils";

/* Official product marks (via the devicon project), served from /public/logos. */
const LOGOS: Record<string, { src: string; name: string }> = {
  blender: { src: "/logos/blender.svg", name: "Blender" },
  vscode: { src: "/logos/vscode.svg", name: "VS Code" },
  jupyter: { src: "/logos/jupyter.svg", name: "JupyterLab" },
  terminal: { src: "/logos/ubuntu.svg", name: "Ubuntu desktop" },
  linux: { src: "/logos/ubuntu.svg", name: "Ubuntu desktop" },
  pytorch: { src: "/logos/pytorch.svg", name: "PyTorch" },
};

/** Which product a machine runs: its desktop app, or PyTorch for training jobs. */
export function appKey(w: Pick<Workload, "kind" | "planJson">): string {
  if (w.kind !== "desktop") return parsePlan(w.planJson)?.requirements.environment === "blender-render" ? "blender" : "pytorch";
  return parsePlan(w.planJson)?.intent.application ?? "terminal";
}

export function appName(key: string): string {
  return LOGOS[key]?.name ?? "Desktop";
}

export function AppLogo({ app, size = 16, className }: { app: string; size?: number; className?: string }) {
  const logo = LOGOS[app] ?? LOGOS.terminal;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny static SVGs; next/image adds nothing here
    <img src={logo.src} alt={logo.name} width={size} height={size} className={cn("shrink-0 object-contain", className)} draggable={false} />
  );
}

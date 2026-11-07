/** The plan document the control plane stores in `workload.planJson` (planner.Plan + extras). */

export type Offer = {
  type: string;
  provider: string;
  gpu: string;
  vram_gb: number;
  vcpus: number;
  ram_gb: number;
  price_per_hour: number;
  stoppable: boolean;
  label: string;
  price_source?: string;
  price_as_of?: string;
};

export type Estimate = {
  hours_low: number;
  hours_high: number;
  cost_low_cents: number;
  cost_high_cents: number;
  confidence: "low" | "medium" | "high";
  assumptions: string[];
};

export type PlanDoc = {
  title: string;
  intent: {
    kind: "desktop" | "batch";
    summary: string;
    application?: string | null;
    model_params_billions?: number | null;
    epochs?: number | null;
    preference?: string | null;
  };
  requirements: {
    min_vram_gb: number;
    min_ram_gb: number;
    min_vcpus: number;
    needs_stoppable: boolean;
    mode: "interactive" | "batch";
    environment: string;
    method?: string | null;
    rationale: string[];
  };
  selected: { offer: Offer; estimate: Estimate };
  alternatives: { offer: Offer; estimate: Estimate }[];
  outputs: string[];
  warnings: string[];
  policy?: { blockers: string[]; notes: string[] };
  inputs?: { dataset_name: string; dataset_rows: number; train_config?: Record<string, unknown> };
};

export function parsePlan(json: string): PlanDoc | null {
  try {
    const doc = JSON.parse(json) as PlanDoc;
    return doc?.selected?.offer ? doc : null;
  } catch {
    return null;
  }
}

const APP_NAMES: Record<string, string> = {
  blender: "Blender",
  terminal: "Linux desktop",
  vscode: "VS Code",
  jupyter: "Jupyter",
};

/** Plain-language description of how Anywhere will do the work. */
export function approach(plan: PlanDoc): string {
  if (plan.requirements.mode === "interactive") {
    const app = APP_NAMES[plan.intent.application ?? ""] ?? plan.intent.application ?? "a Linux desktop";
    return `A persistent cloud desktop with ${app}, streamed to your browser`;
  }
  const method = plan.requirements.method;
  if (method) return `A background ${method.toUpperCase()} training job that shuts down when it's done`;
  return "A background GPU job that shuts down when it's done";
}

export const CONFIDENCE: Record<Estimate["confidence"], string> = {
  high: "High confidence",
  medium: "Rough estimate",
  low: "Low confidence",
};

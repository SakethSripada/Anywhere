import { Code2, FlaskConical, NotebookPen, Shapes, type LucideIcon } from "lucide-react";

export type Template = {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  tagline: string;
  kind: "desktop" | "fine_tune";
  apps?: { value: string; label: string }[];
  defaultApp?: string;
  summary: (app?: string) => string;
};

export const TEMPLATES: Template[] = [
  {
    id: "blender",
    icon: Shapes,
    title: "Blender studio",
    description: "Model, sculpt and render on a GPU desktop in your browser.",
    tagline: "GPU desktop · Blender",
    kind: "desktop",
    defaultApp: "blender",
    summary: () => "GPU desktop with Blender for 3D work",
  },
  {
    id: "finetune",
    icon: FlaskConical,
    title: "Fine-tune a model",
    description: "LoRA/QLoRA on your dataset. Get an adapter and an eval report.",
    tagline: "Batch job · LoRA / QLoRA",
    kind: "fine_tune",
    summary: () => "Fine-tune a language model on my dataset",
  },
  {
    id: "jupyter",
    icon: NotebookPen,
    title: "JupyterLab",
    description: "Notebooks with CUDA ready for experiments and analysis.",
    tagline: "GPU desktop · Notebooks",
    kind: "desktop",
    defaultApp: "jupyter",
    summary: () => "JupyterLab desktop with a GPU",
  },
  {
    id: "dev",
    icon: Code2,
    title: "Dev workspace",
    description: "VS Code or a plain Linux desktop with a GPU attached.",
    tagline: "GPU desktop · VS Code / Linux",
    kind: "desktop",
    apps: [
      { value: "vscode", label: "VS Code" },
      { value: "terminal", label: "Linux desktop" },
    ],
    defaultApp: "vscode",
    summary: (app) => (app === "terminal" ? "Linux desktop with a GPU" : "VS Code workspace with a GPU"),
  },
];

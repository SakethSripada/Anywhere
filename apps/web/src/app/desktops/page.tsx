import type { Metadata } from "next";
import { DesktopGrid } from "@/components/workloads/workload-list";

export const metadata: Metadata = { title: "Desktops" };

export default function DesktopsPage() {
  return <DesktopGrid />;
}

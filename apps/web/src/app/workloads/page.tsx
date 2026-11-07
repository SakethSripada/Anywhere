import type { Metadata } from "next";
import { WorkloadList } from "@/components/workloads/workload-list";

export const metadata: Metadata = { title: "Workloads" };

export default function WorkloadsPage() {
  return <WorkloadList />;
}

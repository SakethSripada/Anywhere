import type { Metadata } from "next";
import { Suspense, use } from "react";
import { WorkloadDetail } from "@/components/workloads/workload-detail";

export const metadata: Metadata = { title: "Workload" };

export default function WorkloadPage({ params }: PageProps<"/workloads/[id]">) {
  return (
    <Suspense>
      <Workload params={params} />
    </Suspense>
  );
}

function Workload({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <WorkloadDetail key={id} id={id} />;
}

import type { Metadata } from "next";
import { Suspense, use } from "react";
import { MachineView } from "@/components/machines/machine-view";

export const metadata: Metadata = { title: "Machine" };

export default function MachinePage({ params }: PageProps<"/w/[id]">) {
  return (
    <Suspense>
      <Resolved params={params} />
    </Suspense>
  );
}

function Resolved({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <MachineView key={id} id={id} />;
}

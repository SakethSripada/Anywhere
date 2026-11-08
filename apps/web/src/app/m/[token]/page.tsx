import type { Metadata } from "next";
import { Suspense, use } from "react";
import { ModelView } from "@/components/watch/model-view";

export const metadata: Metadata = { title: "3D model", robots: { index: false, follow: false } };

export default function ModelPage({ params }: PageProps<"/m/[token]">) {
  return (
    <Suspense>
      <Resolved params={params} />
    </Suspense>
  );
}

function Resolved({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <ModelView key={token} token={token} />;
}

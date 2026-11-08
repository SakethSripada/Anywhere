import type { Metadata } from "next";
import { Suspense, use } from "react";
import { WatchView } from "@/components/watch/watch-view";

export const metadata: Metadata = { title: "Watching", robots: { index: false, follow: false } };

export default function WatchPage({ params }: PageProps<"/watch/[token]">) {
  return (
    <Suspense>
      <Resolved params={params} />
    </Suspense>
  );
}

function Resolved({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <WatchView key={token} token={token} />;
}

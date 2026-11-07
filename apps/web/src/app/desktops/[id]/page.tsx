import type { Metadata } from "next";
import { Suspense, use } from "react";
import { DesktopView } from "@/components/desktop/desktop-view";

export const metadata: Metadata = { title: "Desktop" };

export default function DesktopPage({ params }: PageProps<"/desktops/[id]">) {
  return (
    <Suspense>
      <Desktop params={params} />
    </Suspense>
  );
}

function Desktop({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <DesktopView key={id} id={id} />;
}

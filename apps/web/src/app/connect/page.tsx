import type { Metadata } from "next";
import { Suspense, use } from "react";
import { ConnectView } from "@/components/app/connect-view";

export const metadata: Metadata = { title: "Connect an app" };

export default function ConnectPage({ searchParams }: PageProps<"/connect">) {
  return (
    <Suspense>
      <Connect searchParams={searchParams} />
    </Suspense>
  );
}

function Connect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { request } = use(searchParams);
  return <ConnectView requestId={typeof request === "string" ? request : null} />;
}

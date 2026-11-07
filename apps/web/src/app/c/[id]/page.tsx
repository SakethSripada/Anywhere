import { Suspense, use } from "react";
import { Workspace } from "@/components/app/workspace";

export default function ConversationPage({ params }: PageProps<"/c/[id]">) {
  return (
    <Suspense>
      <Conversation params={params} />
    </Suspense>
  );
}

function Conversation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Workspace key={id} conversationId={id} />;
}

import { Suspense, use } from "react";
import { Conversation } from "@/components/chat/conversation";

export default function ConversationPage({ params }: PageProps<"/c/[id]">) {
  return (
    <Suspense>
      <Resolved params={params} />
    </Suspense>
  );
}

function Resolved({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Conversation key={id} conversationId={id} />;
}

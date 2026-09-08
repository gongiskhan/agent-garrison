import type { Metadata } from "next";
import { TalkPage } from "@/components/talk/TalkPage";

export const metadata: Metadata = { title: "Conversation - Garrison" };

// /talk/<conversationId> opens one conversation directly - the deep-link shape
// notifications, mesh peer rows and Discuss links carry. A ?thread= query on the
// same URL still wins inside the UI, so the older query contract keeps working.
export default function ConversationPage({ params }: { params: { conversationId: string } }) {
  const thread = decodeURIComponent(params.conversationId ?? "").trim();
  return <TalkPage thread={thread || undefined} />;
}

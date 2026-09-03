import type { Metadata } from "next";
import { TalkPage } from "@/components/talk/TalkPage";

export const metadata: Metadata = { title: "Conversation" };

// The chromeless conversation another node frames (D48). A peer's
// /mesh/talk/<node>/<id> page renders THIS route from the owning node inside an
// iframe, so the window that opened the conversation never leaves its origin.
// AppShell drops its sidebar, app bar and floating controls for every /frame/
// route; the parent's chrome is the one chrome. /frame/talk alone honours the
// same ?new=1 the local page does, for a "+ New" on this node from a peer.
export default function FramedConversationPage({ params }: { params: { conversation?: string[] } }) {
  const thread = decodeURIComponent(params.conversation?.[0] ?? "").trim();
  return <TalkPage thread={thread || undefined} framed />;
}

import type { Metadata } from "next";
import { TalkPage } from "@/components/talk/TalkPage";

export const metadata: Metadata = { title: "Conversations - Garrison" };

// Conversations - the former Web Channel, now a shell route. The UI is
// @garrison/talk; its /api/* routes are served by the shell's catch-all
// (src/app/api/[[...path]]/route.ts), so the same code runs here and inside the
// legacy web-channel-default fitting host.
export default function ConversationsPage() {
  return <TalkPage />;
}

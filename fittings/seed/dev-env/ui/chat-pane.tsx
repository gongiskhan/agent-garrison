// Rich chat view for a dev-env claude session. Mounts the shared
// @garrison/claude-chat component against this session's /sessions/:id/claude/*
// surface (backed by the claude PTY's headless mirror), so the same PTY shown
// in the terminal view is driven here too — switching views never disturbs the
// live session.

import { useMemo } from "react";
import { ClaudeChat, createHttpTransport } from "@garrison/claude-chat";

export function ChatPane({ sessionId, branch }: { sessionId: string; branch?: string }) {
  const transport = useMemo(() => createHttpTransport(`/sessions/${encodeURIComponent(sessionId)}`), [sessionId]);
  // dev-env opts into the full toolbar: model + effort switching, the chat
  // light/dark/system theme (shared with the terminal toggle), and voice
  // (read-aloud + push-to-talk via the same-origin /sessions/:id/voice proxy).
  // web-channel mounts ClaudeChat without `features`, so it is unaffected.
  return (
    <ClaudeChat
      transport={transport}
      title={branch ? `Claude · ${branch}` : "Claude"}
      features={{ model: true, effort: true, theme: true, voice: true }}
    />
  );
}

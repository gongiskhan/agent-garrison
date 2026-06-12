// Rich chat view for a dev-env claude session. Mounts the shared
// @garrison/claude-chat component against this session's /sessions/:id/claude/*
// surface (backed by the claude PTY's headless mirror), so the same PTY shown
// in the terminal view is driven here too — switching views never disturbs the
// live session.

import { useMemo } from "react";
import { ClaudeChat, createHttpTransport } from "@garrison/claude-chat";

export function ChatPane({ sessionId, branch }: { sessionId: string; branch?: string }) {
  const transport = useMemo(() => createHttpTransport(`/sessions/${encodeURIComponent(sessionId)}`), [sessionId]);
  return <ClaudeChat transport={transport} title={branch ? `Claude · ${branch}` : "Claude"} />;
}

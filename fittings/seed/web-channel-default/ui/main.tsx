// Web Channel UI — rich Claude Code chat. Mounts the shared @garrison/claude-chat
// component against the gateway's /claude/* surface (proxied as /api/claude/*).
//
// This replaced the bubble-list + voice UI (preserved as legacy-voice.tsx for a
// future voice re-integration via ClaudeChat's composerAdornment slot).

import { createRoot } from "react-dom/client";
import { ClaudeChat, createHttpTransport } from "@garrison/claude-chat";
// claude-chat.css is concatenated into web-channel.css by ui/build.mjs.

const transport = createHttpTransport("/api");

function App() {
  return <ClaudeChat transport={transport} title="Operative" />;
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);

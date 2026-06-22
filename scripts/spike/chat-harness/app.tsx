import { createRoot } from "react-dom/client";
import { ClaudeChat } from "../../../packages/claude-chat/src/index";
import type { ChatTransport } from "../../../packages/claude-chat/src/index";
import "../../../packages/claude-chat/src/claude-chat.css";

// Static render harness: a stub transport so the rich chat renders its toolbar,
// status line, transcript, and voice controls without a live Claude PTY. Used
// only to screenshot the dev-env chat enhancements (model/effort/theme/voice).
const stub: ChatTransport = {
  base: "",
  connect(onEvent) {
    setTimeout(() => {
      onEvent({ type: "connection", state: "open" });
      onEvent({
        type: "hello",
        mode: "default",
        busy: false,
        assistant: "",
        screen: [],
        status: { rows: [], mode: "default", contextPct: 42, model: "claude-opus-4-8", busy: false }
      });
      onEvent({ type: "status", rows: [], mode: "default", contextPct: 42, model: "claude-opus-4-8" });
      onEvent({
        type: "assistant",
        text:
          "Here is a short plan:\n\n1. Wire the toolbar — **model** and **effort** switchers\n2. Add the voice proxy routes (`/voice/tts`, `/voice/stt`)\n3. Share the light / dark / system theme with the terminal\n\nReady when you are."
      });
    }, 80);
    return () => {};
  },
  async sendMessage() {},
  async sendCommand() {},
  async sendKey() {},
  async setMode(mode) {
    return { mode, reached: true };
  },
  async interrupt() {},
  async fetchCommands() {
    return [
      { name: "model", description: "Switch the active model", source: "builtin" },
      { name: "compact", description: "Compact the context", source: "builtin" }
    ];
  }
};

createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <ClaudeChat
      transport={stub}
      title="Claude · demo"
      features={{ model: true, effort: true, theme: true, voice: true }}
    />
  </div>
);

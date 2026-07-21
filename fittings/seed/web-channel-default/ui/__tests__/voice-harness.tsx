// Test-only harness for the fake-media Playwright run (voice-capture.pw.ts).
// Mounts the REAL VoiceConversation component with stubbed chat plumbing so the
// browser exercises the true capture path (getUserMedia → AudioWorklet → WS) and
// transcript rendering against a mock relay served from the same origin. NOT part
// of the production bundle (build.mjs only bundles main.tsx).

import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { VoiceConversation } from "../voice-conversation";

function absWs(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${path}`;
}

function Harness() {
  const scenario = new URLSearchParams(window.location.search).get("scenario") || "interim-final";
  const [lastReply, setLastReply] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Absolute WS urls carrying the scenario so the mock relay knows how to behave.
  const streamUrl = absWs(`/api/voice/stream?sample_rate=16000&utterance_end_ms=1500&scenario=${scenario}`);
  const ttsUrl = absWs(`/api/voice/tts-stream?sample_rate=24000&scenario=${scenario}`);

  const send = useCallback((text: string) => {
    (window as any).__sent = (window as any).__sent || [];
    (window as any).__sent.push(text);
    setBusy(true);
    // Simulate the gateway settling a reply shortly after the send, so the
    // component's reply-correlation → read-aloud path runs against the TTS mock.
    window.setTimeout(() => {
      setBusy(false);
      setLastReply({ id: "r" + Date.now(), text: "This is the spoken reply." });
    }, 120);
  }, []);

  // position:relative mimics the .cc-composer container the panel anchors to.
  return (
    <div id="composer" style={{ position: "relative", padding: 40 }}>
      <VoiceConversation
        send={send}
        busy={busy}
        lastReply={lastReply}
        streamUrl={streamUrl}
        ttsUrl={ttsUrl}
        assumeAvailable
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);

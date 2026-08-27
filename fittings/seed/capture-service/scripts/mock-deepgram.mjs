// A standalone mock of Deepgram's live endpoint for sandboxed E2E runs
// (point the service at it with GARRISON_CAPTURESERVICE_DG_URL). It speaks
// just enough of the verified protocol (docs/api-notes.md): accepts binary
// audio, emits an interim then a final Results after a frame threshold, and
// flushes one last final on CloseStream.
//
//   node scripts/mock-deepgram.mjs [--port 0] [--text "Final sentence."]
//        [--after 40] [--status-file /path.json]
//
// The status file (when given) records {port, url} so a driver can discover
// the ephemeral port.

import { writeFileSync } from "node:fs";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const port = Number(flag("port", "0"));
const finalText = flag("text", "Zeca, cria uma tarefa de teste chamada olá companion.");
const afterFrames = Number(flag("after", "40"));
const statusFile = flag("status-file", null);

function results(text, isFinal, start = 0, duration = 2) {
  return JSON.stringify({
    type: "Results",
    start,
    duration,
    is_final: isFinal,
    channel: {
      alternatives: [
        {
          transcript: text,
          confidence: 0.97,
          words: text
            .split(/\s+/)
            .map((w, i) => ({ word: w, start: start + i * 0.25, end: start + i * 0.25 + 0.2, speaker: 0 }))
        }
      ]
    }
  });
}

const wss = new WebSocketServer({ port, host: "127.0.0.1" });
wss.on("listening", () => {
  const boundPort = wss.address().port;
  const url = `ws://127.0.0.1:${boundPort}`;
  if (statusFile) writeFileSync(statusFile, JSON.stringify({ port: boundPort, url }));
  console.log(`[mock-deepgram] listening on ${url} (final after ${afterFrames} frames)`);
});

wss.on("connection", (ws) => {
  let frames = 0;
  let sent = false;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      frames += 1;
      if (frames >= Math.floor(afterFrames / 2) && !sent && frames < afterFrames) {
        ws.send(results(finalText.split(" ").slice(0, 3).join(" "), false, 0, 1));
      }
      if (frames >= afterFrames && !sent) {
        sent = true;
        ws.send(results(finalText, true, 0, 3));
      }
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "CloseStream") {
        if (!sent) ws.send(results(finalText, true, 0, 3));
        ws.close(1000);
      }
    } catch {}
  });
});

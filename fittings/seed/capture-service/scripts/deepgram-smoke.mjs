// Real-key Deepgram smoke — the ONE live external this fitting touches before
// TestFlight, and only when the key is present (spec §8: fixtures over live).
//
//   DEEPGRAM_API_KEY=... node scripts/deepgram-smoke.mjs [fixture-name]
//
// Streams a committed Opus fixture to the real live endpoint through the SAME
// TranscriptionLane the server uses, prints the returned transcript, and exits
// non-zero if nothing came back. Without the key it prints SKIP and exits 0 so
// automation can run it unconditionally.
//
// Coverage limits: proves the key, the URL parameters, the raw-Opus encoding
// choice, and the Results parsing against the live API. It does not prove the
// phone's encoder (device smoke) or the wake/triage pipes (fixture E2E).

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "../lib/config.mjs";
import { TranscriptionLane } from "../lib/deepgram-live.mjs";

const key = process.env.DEEPGRAM_API_KEY?.trim();
if (!key) {
  console.log("SKIP: DEEPGRAM_API_KEY not set - smoke not run");
  process.exit(0);
}

const fixture = process.argv[2] ?? "pt-command";
const file = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", `audio-${fixture}.jsonl`);
const packets = readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .map((p) => Buffer.from(p.bytes, "base64"));

const cfg = { ...loadConfig(), transcribeEnabled: true };
cfg.secrets = { ...cfg.secrets, deepgramApiKey: key };
const counts = {};
const counters = {
  bump: (k, by = 1) => (counts[k] = (counts[k] ?? 0) + by),
  set: () => {},
  observe: () => {}
};

const lane = new TranscriptionLane({ cfg, counters });
const sessionId = "SMOKESESSION0001";
lane.openSession(sessionId);

// Pace at ~4x realtime: fast enough to finish quickly, slow enough that the
// live endpoint's jitter buffers behave like a session rather than a file.
for (const bytes of packets) {
  lane.feed(sessionId, bytes);
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const segments = await lane.end(sessionId);

if (!segments || segments.length === 0) {
  console.error(`NOTHING ARRIVED: streamed ${packets.length} packets, got no final segments`);
  console.error(`counters: ${JSON.stringify(counts)}`);
  process.exit(1);
}
console.log(`fixture ${fixture}: ${packets.length} packets -> ${segments.length} final segment(s)`);
for (const s of segments) {
  console.log(`  [${s.start.toFixed(2)}-${s.end.toFixed(2)}] speaker=${s.speaker ?? "?"} ${s.text}`);
}
console.log(`counters: ${JSON.stringify(counts)}`);

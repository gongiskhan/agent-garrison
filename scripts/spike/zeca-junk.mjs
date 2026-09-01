import { drive } from "./zeca-drive.mjs";
// Both filed durable memory notes today with a spoken "I saved it as a note",
// and one of them answered a Portuguese household in English.
for (const [label, segs] of [
  ["the wake word said twice, nothing else", [{ text: "Zeca." , gapMs: 200}, { text: "Zeca.", start: 2 }]],
  ["a bare interjection", [{ text: "Zeca.", gapMs: 200 }, { text: "Boa.", start: 2 }]]
]) {
  const r = await drive({ label, segments: segs, classifierReply: { intent: "unknown" } });
  const ex = r.exchanges[0];
  console.log(`\n${label}`);
  console.log("  said aloud :", r.spoken.join(" | ") || "(NOTHING)");
  console.log("  intent     :", ex?.intent ?? "(no exchange)", "| lang:", ex?.lang ?? "-");
}
process.exit(0);

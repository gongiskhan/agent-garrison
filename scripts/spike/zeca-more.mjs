import { drive } from "./zeca-drive.mjs";

// The flows not yet driven: the clarifying-question answer window, the
// progress heartbeat on a slow turn, and an English command end to end.
const SCENARIOS = [
  {
    label: "F. Zeca asks back, user answers WITHOUT the wake word",
    segments: [
      { text: "Zeca.", gapMs: 200 },
      { text: "Sugere qualquer coisa para jantar.", start: 2, gapMs: 1400 },
      // The answer, spoken with no wake word, after the question was spoken.
      { text: "Para o jantar de hoje.", start: 6 }
    ],
    classifierReply: { intent: "delegate", request: "Sugere jantar", ack: "Deixa-me ver." },
    operativeReply: "Queres algo rápido ou com tempo?"
  },
  {
    label: "G. English command - the whole chain should flip",
    segments: [{ text: "Zeca, remind me to call the plumber tomorrow." }],
    classifierReply: { intent: "create_task", title: "Call the plumber", description: "plumber" }
  },
  {
    label: "H. two wake hits in a row (deduped pulse, one capture each)",
    segments: [
      { text: "Zeca, cria uma tarefa para comprar pão.", gapMs: 900 },
      { text: "Zeca, cria uma tarefa para regar as plantas.", start: 5 }
    ],
    classifierReply: { intent: "create_task", title: "Comprar pão", description: "pão" }
  }
];

for (const s of SCENARIOS) {
  const r = await drive(s);
  console.log(`\n${"=".repeat(72)}\n${r.label}`);
  console.log("  cues        :", r.feedback.filter((f) => f.speak).map((f) => f.speak).join(" | ") || "(none)");
  console.log("  said aloud  :", r.spoken.length ? r.spoken.join(" | ") : "(NOTHING)");
  console.log("  exchanges   :", r.exchanges.map((e) => `${e.intent}:${JSON.stringify(e.command).slice(0, 46)}`).join("  ") || "(none)");
  console.log("  cards       :", r.cards.map((c) => c.title).join(" | ") || "(none)");
  const c = r.counters;
  const notable = Object.fromEntries(
    Object.entries(c).filter(([k]) => /followup|progress|unheard|empty|deduped|hits$/.test(k))
  );
  console.log("  counters    :", JSON.stringify(notable));
}
process.exit(0);

import { drive } from "./zeca-drive.mjs";

const SCENARIOS = [
  {
    label: "A. command in the SAME segment as the wake word",
    segments: [{ text: "Zeca, cria uma tarefa para comprar pão amanhã." }],
    classifierReply: { intent: "create_task", title: "Comprar pão", description: "pão" }
  },
  {
    label: "B. wake word alone, command follows (the real pendant shape)",
    segments: [{ text: "Zeca." , gapMs: 200 }, { text: "Cria uma tarefa para comprar pão amanhã.", start: 2 }],
    classifierReply: { intent: "create_task", title: "Comprar pão", description: "pão" }
  },
  {
    label: "C. cue echo fused onto the front of the command",
    segments: [{ text: "Zeca.", gapMs: 200 }, { text: "Sim. Olha achas que o Porta 7 é bom?", start: 2 }],
    classifierReply: { intent: "delegate", request: "É bom o Porta 7?", ack: "Deixa-me ver." }
  },
  {
    label: "D. ONLY the cue echo lands in the window (the reported silence)",
    segments: [{ text: "Zeca.", gapMs: 200 }, { text: "Sim.", start: 2 }],
    classifierReply: { intent: "unknown" }
  },
  {
    label: "E. nothing at all after the wake word",
    segments: [{ text: "Zeca.", gapMs: 200 }],
    classifierReply: { intent: "unknown" }
  }
];

for (const s of SCENARIOS) {
  const r = await drive(s);
  const ex = r.exchanges[0];
  console.log(`\n${"=".repeat(72)}\n${r.label}`);
  console.log("  cues spoken :", r.feedback.filter((f) => f.speak).map((f) => f.speak).join(" | ") || "(none)");
  console.log("  said aloud  :", r.spoken.length ? r.spoken.join(" | ") : "(NOTHING - user hears silence)");
  console.log("  command     :", JSON.stringify(ex?.command ?? null));
  console.log("  intent      :", ex?.intent ?? "(no exchange)", "| delivery:", ex?.delivery ?? "-");
  const c = r.counters;
  const notable = Object.fromEntries(Object.entries(c).filter(([k]) => /empty|unrecoverable|cue_echo_stripped|discard/.test(k)));
  if (Object.keys(notable).length) console.log("  counters    :", JSON.stringify(notable));
}
process.exit(0);

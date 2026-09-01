import { drive } from "./zeca-drive.mjs";
const r = await drive({
  label: "smoke",
  segments: [{ text: "Zeca, cria uma tarefa para comprar pão amanhã." }],
  classifierReply: { intent: "create_task", title: "Comprar pão", description: "pão" }
});
console.log("SPOKEN:", r.spoken);
console.log("CUES:", r.feedback.filter((f) => f.speak).map((f) => f.speak));
console.log("EXCHANGE:", JSON.stringify(r.exchanges[0] ?? null).slice(0, 200));
process.exit(0);

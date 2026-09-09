// A paused conversation owns its question. Choices are ordinary messages, never
// executable actions; the ledger coordinate prevents answering an obsolete ask.
export function validConversationQuestion(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && typeof value.question === "string" && value.question.trim().length > 0 && value.question.length <= 1000
    && Array.isArray(value.options) && value.options.length <= 4
    && value.options.every((option) => option && typeof option.label === "string"
      && option.label.trim().length > 0 && option.label.length <= 160
      && (option.description === undefined || (typeof option.description === "string" && option.description.length <= 400)))
    && new Set(value.options.map((option) => option.label.trim())).size === value.options.length;
}

export function pendingConversationQuestion(store) {
  if (store.currentStretch()) return null;
  const records = store.tail(200, { kinds: ["handoff", "stretch-started", "stretch-ended", "user-message", "approval-requested"] });
  const last = records.at(-1);
  if (!last || last.kind === "user-message" || last.kind === "stretch-started") return null;
  if (last.kind === "approval-requested") return null; // Existing plan approval has its own controls.
  const handoff = [...records].reverse().find((record) => record.kind === "handoff");
  if (!handoff || handoff.payload?.nextSteps?.next !== "needs-input") return null;
  if (records.some((record) => record.index > handoff.index && ["user-message", "stretch-started", "approval-requested"].includes(record.kind))) return null;
  const payload = handoff.payload;
  let question = payload.question;
  if (!validConversationQuestion(question)) {
    const needs = payload.blocker?.needs;
    const what = payload.blocker?.what;
    const text = [what, needs, payload.nextSteps?.why, ...(payload.nextSteps?.items || [])].filter((value) => typeof value === "string").join("\n");
    const options = /\bvault\b/i.test(text) && /\b(keys?|credentials?|tokens?|secrets?)\b/i.test(text)
      ? [{ label: "I have added the keys to the vault" }] : [];
    question = { question: String(needs || what || payload.nextSteps?.why || "What would you like to do next?").slice(0, 1000), options };
  }
  return {
    id: `handoff-${handoff.seq}`,
    question: question.question.trim(),
    options: question.options.map(({ label, description }) => ({ label: label.trim(), ...(description ? { description } : {}) })),
  };
}

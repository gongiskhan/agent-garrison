// Kanban Loop engine (V1a) — the transition function.
//
// A manual list is a plain column. An AGENT list has a named skill + execute-prompt
// + router-prompt: on entry the engine sends the combined prompt through the
// orchestrator front door (a runFn injected by the caller = preRoute / gateway
// /chat), then the router output must EXACTLY name one of the card's valid next
// lists (brief §3: no fuzzy matching, no guessing) or the card parks in
// needs-attention. §9 decisions applied: effort/model are the router's job (NOT set
// per list); the router's continuations are suppressed (the list boundary is the
// gate); there is no Infer column (low-confidence inference → needs-attention). §10:
// each agent-list carries an explicit {taskType, tier} fed to preRoute. Goal-mode
// prepends /goal + the card's acceptance (the engine adds the prefix; execute-prompts
// stay clean). A per-card iteration-cap breach parks the card in needs-attention.
import { saveCard, saveCardCAS, appendCardLog } from "./board.mjs";

const AGENT_KIND = "agent";

export function getList(board, listId) {
  return (board.lists || []).find((l) => l.id === listId) || null;
}

export function validNextFor(board, listId) {
  const list = getList(board, listId);
  return Array.isArray(list?.validNext) ? list.validNext : [];
}

// §10: an agent-list carries an explicit {taskType, tier} so the kanban builds a
// classification for preRoute without inventing a phase→classification mapper.
export function classificationFor(list) {
  return { taskType: list?.taskType || "other", tier: list?.tier || "T1-standard" };
}

// Parse the router's chosen next list. Takes the last non-empty line (the
// router-prompt convention is to end with the verdict) and EXACT-matches it against
// the valid next list ids. No match → null (→ needs-attention).
export function parseNextList(routerOutput, validNext) {
  const text =
    typeof routerOutput === "string" ? routerOutput : routerOutput?.reply ?? routerOutput?.text ?? "";
  const lines = String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const verdict = lines.length ? lines[lines.length - 1] : "";
  return validNext.includes(verdict) ? verdict : null;
}

// Combined execute + router prompt. goal-mode prepends /goal + acceptance; the valid
// next-list ids are injected so the router output can exact-match.
export function buildCardPrompt({ list, card, validNext }) {
  const parts = [];
  if (card.goalMode && list.kind === AGENT_KIND) {
    const acceptance = card.acceptance || card.description || "(lift acceptance from FLOW_PLAN.md)";
    parts.push(`/goal ${acceptance}`, "");
  }
  if (list.executePrompt) parts.push(list.executePrompt, "");
  parts.push(
    `When done, decide the next list. Reply with the chosen list id on its own FINAL line — EXACTLY one of: ${validNext.join(", ")}.`
  );
  if (list.routerPrompt) parts.push("", list.routerPrompt);
  return parts.join("\n");
}

// Run ONE transition for a card on an agent list. runFn dispatches the prompt
// through the orchestrator (preRoute) and returns { reply }. Returns the updated
// card + an outcome ({status: moved|needs-attention|skipped, ...}).
export async function processCard({ root, board, card, runFn, cap = 10, now = () => new Date().toISOString() }) {
  const list = getList(board, card.list);
  if (!list || list.kind !== AGENT_KIND) {
    return { card, outcome: { status: "skipped", reason: "not-an-agent-list" } };
  }
  // Every write is a compare-and-swap against the rev we read, so a concurrent tick or
  // a manual edit cannot be silently overwritten (lost update).
  const baseRev = card.rev ?? 0;
  if ((card.iterations || 0) >= cap) {
    const res = await saveCardCAS(root, { ...card, status: "needs-attention" }, baseRev, now());
    if (!res.ok) return { card: res.card, outcome: { status: "skipped", reason: "conflict" } };
    return { card: res.card, outcome: { status: "needs-attention", reason: "iteration-cap" } };
  }

  const validNext = validNextFor(board, card.list);
  const iteration = (card.iterations || 0) + 1;
  // Acquire the card: CAS the running-status write. A second concurrent tick fails the
  // CAS here and skips, so a card is never processed twice.
  const acq = await saveCardCAS(root, { ...card, status: "running", iterations: iteration }, baseRev, now());
  if (!acq.ok) return { card: acq.card, outcome: { status: "skipped", reason: "conflict" } };
  const runningCard = acq.card;
  const runRev = runningCard.rev;

  const prompt = buildCardPrompt({ list, card: runningCard, validNext });
  const classification = classificationFor(list);
  let out;
  try {
    out = await runFn({ prompt, card: runningCard, list, classification, suppressContinuations: true });
  } catch (err) {
    await appendCardLog(root, card.id, iteration, `# iteration ${iteration}\nrun failed: ${err?.message || err}\n`);
    const res = await saveCardCAS(root, { ...runningCard, status: "needs-attention" }, runRev, now());
    return { card: res.card ?? runningCard, outcome: { status: "needs-attention", reason: "run-failed", error: String(err?.message || err) } };
  }

  const reply = out?.reply ?? out?.text ?? String(out ?? "");
  await appendCardLog(root, card.id, iteration, `# iteration ${iteration}\n${reply}\n`);

  const next = parseNextList(reply, validNext);
  const target = next
    ? { ...runningCard, list: next, status: "ok" }
    : { ...runningCard, status: "needs-attention" };
  const res = await saveCardCAS(root, target, runRev, now());
  if (!res.ok) return { card: res.card, outcome: { status: "needs-attention", reason: "conflict-during-run" } };
  if (!next) return { card: res.card, outcome: { status: "needs-attention", reason: "no-exact-match", validNext } };
  return { card: res.card, outcome: { status: "moved", from: card.list, to: next } };
}

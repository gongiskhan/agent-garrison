// Kanban Loop engine (V1b) — the transition function.
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
// stay clean) — but the convergence GUARD is the per-card iteration cap, not the goal
// hook (FINDING 5 / Decision 7: the goal-stop sentinel never fires on the shared
// board operative). A per-card iteration-cap breach parks the card in needs-attention.
//
// V1b adds: per-card runId minted on the FIRST agent-list entry (FINDING 4) and the
// run directory threaded into EVERY execute-prompt as literal text (FINDING 4/10 — the
// gateway `skill` field is inert, so the run dir must be IN the prompt); the three
// triggers (immediate | manual | scheduler-beat) so tick() only processes immediate
// agent lists; and Test batching (FINDING 7) — one session per project on the test
// list's own scheduler beat.
import { saveCard, saveCardCAS, appendCardLog } from "./board.mjs";
import { ulid } from "./ulid.mjs";

const AGENT_KIND = "agent";

// Project-relative run-directory root the autothing skills already write under.
const RUN_DIR_BASE = "docs/autothing/runs";

export function getList(board, listId) {
  return (board.lists || []).find((l) => l.id === listId) || null;
}

export function validNextFor(board, listId) {
  const list = getList(board, listId);
  return Array.isArray(list?.validNext) ? list.validNext : [];
}

// A list's trigger decides WHO advances a card off it: `immediate` agent lists fire on
// entry via tick(); `scheduler-beat` lists fire only on their own beat (Test); `manual`
// lists (and interactive lists) are advanced by hand. Default to immediate for any
// agent list that omits a trigger (the V1a lists carried none), manual otherwise.
export function triggerFor(list) {
  if (list?.trigger) return list.trigger;
  return list?.kind === AGENT_KIND ? "immediate" : "manual";
}

// An interactive list (e.g. Discuss) is never auto-dispatched: the board opens the
// web chat and the human advances it manually.
export function isInteractive(list) {
  return Boolean(list?.interactive);
}

// Mint a runId + runDir for a card iff it does not have one yet. Called when a card
// first enters an agent list (Start → plan). runDir is project-relative so the same
// pointer is valid from any working dir the skill resolves against (FINDING 4/10).
export function mintRunFields(card, now = Date.now) {
  if (card.runId && card.runDir) return null; // already minted — idempotent
  const runId = ulid(typeof now === "function" ? now() : now);
  return { runId, runDir: `${RUN_DIR_BASE}/${runId}` };
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

// Combined execute + router prompt. goal-mode prepends /goal + acceptance; the card's
// runDir is threaded in as literal text (the gateway `skill` field is inert, so the
// run dir must be IN the prompt for the autothing skill to write per-run — FINDING
// 4/10); the valid next-list ids are injected so the router output can exact-match.
export function buildCardPrompt({ list, card, validNext }) {
  const parts = [];
  if (card.goalMode && list.kind === AGENT_KIND) {
    const acceptance = card.acceptance || card.description || "(lift acceptance from FLOW_PLAN.md)";
    parts.push(`/goal ${acceptance}`, "");
  }
  // Thread the per-run pointers so the autothing skill writes its plan/gate files
  // under this card's run dir and references this card's slice — the skill cannot get
  // these from the inert gateway fields, so they go in the prompt body.
  if (card.runDir) {
    parts.push(`Run directory (write all per-run artifacts here): ${card.runDir}`);
    if (card.sliceId) parts.push(`Slice id: ${card.sliceId}`);
    parts.push("");
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
  // An interactive list (Discuss — kind "agent-interactive") is never auto-dispatched:
  // the board opens the web chat and the human advances manually. Checked before the
  // agent-kind guard so it reports `interactive`, not `not-an-agent-list`.
  if (isInteractive(list)) {
    return { card, outcome: { status: "skipped", reason: "interactive" } };
  }
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
  // Mint runId + runDir on the card's FIRST agent-list entry, and fold the mint into
  // the SAME acquire write so it is persisted CAS-safely (no extra write, no race).
  const minted = mintRunFields(card, () => Date.parse(now()) || Date.now());
  // Acquire the card: CAS the running-status write (+ run fields if just minted). A
  // second concurrent tick fails the CAS here and skips, so a card is never processed
  // twice and the runId is never minted twice.
  const acq = await saveCardCAS(
    root,
    { ...card, ...(minted || {}), status: "running", iterations: iteration },
    baseRev,
    now()
  );
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

// ── Backlog on-entry inference (FINDING 3) ───────────────────────────────────
//
// A card dropped in Backlog infers its title eagerly, but applies the inferred
// project ONLY at ≥70% confidence; below that it parks in needs-attention (no Infer
// column — §9). This is the POLICY half (pure): the caller does the actual inference
// (an LLM call) and hands the result in; the engine decides what lands on the card and
// whether it parks. Default threshold 0.7 (override via the caller).
export const PROJECT_CONFIDENCE_THRESHOLD = 0.7;

export function resolveBacklogInference(card, inference, threshold = PROJECT_CONFIDENCE_THRESHOLD) {
  const title = inference?.title?.trim() || card.title || "(untitled)";
  const confident = typeof inference?.projectConfidence === "number" && inference.projectConfidence >= threshold;
  if (confident && inference?.project) {
    return { card: { ...card, title, project: inference.project }, park: false };
  }
  // Low confidence (or no project): keep the eager title, leave project null, park.
  return { card: { ...card, title, project: null, status: "needs-attention" }, park: true, reason: "low-confidence-project" };
}

// ── Test batching (FINDING 7) ────────────────────────────────────────────────
//
// The Test list runs on its own scheduler beat, not the global heartbeat, and tests
// a whole PROJECT in one session against one test plan. So the unit of work is the
// project, not the card: gather the project's waiting cards on the list, hand the
// batch one prompt, and turn the ONE reply into a per-card verdict.

// Group a list's eligible cards by project. A null/empty project groups under the
// literal "(no-project)" bucket so an unclassified card is still batched (with itself).
export function groupCardsByProject(cards, listId) {
  const byProject = {};
  for (const c of cards) {
    if (c.list !== listId) continue;
    if (c.status === "running" || c.status === "needs-attention") continue;
    const key = c.project || "(no-project)";
    (byProject[key] ??= []).push(c);
  }
  return byProject;
}

// Parse the per-card verdict from a batch reply. The batch session is asked to emit
// one line per card: `<cardId> <next-list-id>`. We exact-match the chosen list id
// against THAT card's validNext (a card whose line is missing or whose verdict is not
// a valid next list gets null → the caller loops it to implement / parks it). No fuzzy
// matching, same discipline as parseNextList.
export function parseBatchVerdicts(reply, cards, board) {
  const text = typeof reply === "string" ? reply : reply?.reply ?? reply?.text ?? "";
  const verdicts = {};
  // Build a cardId → chosen-token map from the reply lines.
  const chosen = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // `<cardId><sep><token>` — separator is whitespace, ':' or '->'.
    const m = line.match(/^([0-9A-HJKMNP-TV-Z]{26})\s*(?:[:>-]+)?\s*(\S+)\s*$/);
    if (!m) continue;
    chosen[m[1]] = m[2];
  }
  for (const c of cards) {
    const validNext = validNextFor(board, c.list);
    const token = chosen[c.id];
    verdicts[c.id] = token && validNext.includes(token) ? token : null;
  }
  return verdicts;
}

// Run ONE batched session per project for a list (Test). batchRunFn is handed the
// project's cards + the combined batch prompt and returns ONE reply naming a verdict
// per card. Each card is then moved per its own verdict (CAS-safe, runId minted if it
// is the card's first agent-list entry): a valid verdict moves it forward; a missing /
// non-matching verdict, or an iteration-cap breach, loops it to `implement` (the fail
// edge) or parks it in needs-attention if implement is not a valid next.
export async function processBatch({ root, board, listId, cards, batchRunFn, cap = 10, now = () => new Date().toISOString() }) {
  const list = getList(board, listId);
  if (!list || list.kind !== AGENT_KIND) {
    return { outcomes: [], reason: "not-an-agent-list" };
  }
  const groups = groupCardsByProject(cards, listId);
  const outcomes = [];
  for (const [project, projectCards] of Object.entries(groups)) {
    if (projectCards.length === 0) continue;
    // Acquire every card in the group (CAS the running write + mint run fields). A card
    // that fails the CAS (concurrent tick / manual edit) drops out of the batch. A card
    // already at the cap parks without running.
    const acquired = [];
    for (const card of projectCards) {
      const baseRev = card.rev ?? 0;
      if ((card.iterations || 0) >= cap) {
        const res = await saveCardCAS(root, { ...card, status: "needs-attention" }, baseRev, now());
        outcomes.push({ id: card.id, status: "needs-attention", reason: "iteration-cap", project });
        continue;
      }
      const minted = mintRunFields(card, () => Date.parse(now()) || Date.now());
      const iteration = (card.iterations || 0) + 1;
      const acq = await saveCardCAS(root, { ...card, ...(minted || {}), status: "running", iterations: iteration }, baseRev, now());
      if (!acq.ok) { outcomes.push({ id: card.id, status: "skipped", reason: "conflict", project }); continue; }
      acquired.push({ original: card, running: acq.card, iteration });
    }
    if (acquired.length === 0) continue;

    const runningCards = acquired.map((a) => a.running);
    const classification = classificationFor(list);
    let out;
    try {
      out = await batchRunFn({ project, cards: runningCards, list, classification, suppressContinuations: true });
    } catch (err) {
      // The whole batch session failed — park every acquired card.
      for (const a of acquired) {
        const res = await saveCardCAS(root, { ...a.running, status: "needs-attention" }, a.running.rev, now());
        await appendCardLog(root, a.original.id, a.iteration, `# iteration ${a.iteration} (batch:${project})\nbatch run failed: ${err?.message || err}\n`);
        outcomes.push({ id: a.original.id, status: "needs-attention", reason: "run-failed", error: String(err?.message || err), project });
      }
      continue;
    }

    const reply = out?.reply ?? out?.text ?? String(out ?? "");
    const verdicts = parseBatchVerdicts(reply, runningCards, board);
    for (const a of acquired) {
      const next = verdicts[a.original.id];
      await appendCardLog(root, a.original.id, a.iteration, `# iteration ${a.iteration} (batch:${project})\nverdict: ${next ?? "(none)"}\n${reply}\n`);
      const target = next
        ? { ...a.running, list: next, status: "ok" }
        : { ...a.running, status: "needs-attention" };
      const res = await saveCardCAS(root, target, a.running.rev, now());
      if (!res.ok) { outcomes.push({ id: a.original.id, status: "needs-attention", reason: "conflict-during-run", project }); continue; }
      if (!next) { outcomes.push({ id: a.original.id, status: "needs-attention", reason: "no-exact-match", project }); continue; }
      outcomes.push({ id: a.original.id, status: "moved", from: listId, to: next, project });
    }
  }
  return { outcomes };
}

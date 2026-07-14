// THE run engine (GARRISON-UNIFY-V1 S4, D9/D13/D15) — the transition function,
// packaged as a LIBRARY callable both by the board's tick dispatcher and
// in-process by a session (the garrison doorway). A run is a card.
//
// A manual list is a plain column. An AGENT list maps to a PHASE NAME and
// nothing else (D15): its skill, model, effort, and runtime all resolve from
// the compiled Orchestrator policy (~/.garrison/orchestrator/policy.json). On
// entry the engine sends the combined prompt through the orchestrator front
// door (a runFn injected by the caller = preRoute / gateway /chat) with an
// EXPLICIT {taskType: <phase>, tier: <card tier>} classification (the phase IS
// the task type, D1), then the router output must EXACTLY name one of the
// card's valid next lists (no fuzzy matching) or the card parks in
// needs-attention. Phase progression is a list transition AND requires the
// phase's durable gate evidence in the runDir (D9) — a transition without its
// gate-status entry parks. The card's work kind + per-card phase toggles form
// its RAIL (D17): an OFF phase is skipped with an explicit "off" event
// (recorded and rendered off, never a silent pass). Goal-mode prepends /goal +
// the card's acceptance; the convergence GUARD is the per-card iteration cap.
//
// Per-card runId minted on the FIRST agent-list entry; runDir threaded into
// every execute-prompt as literal text; triggers (immediate | manual |
// scheduler-beat) so tick() only processes immediate agent lists; Test
// batching preserved as list mechanics (batched + its own beat).
import path from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { saveCard, saveCardCAS, appendCardLog, writeCardLog, loadAllCards, loadCard, updateCardCAS } from "./board.mjs";
import { ulid } from "./ulid.mjs";
import {
  coordinationConfig,
  coordinationAvailability,
  applyPlanCompletionCoordination,
  applyBlockerWrite,
  stabilityFields,
  removeCardIntents,
  repoPathForProject,
  readTouchSet,
  liveSameProjectCards,
  acquireLeases,
  renewLeases,
  releaseLeases,
  reregisterTouchSetIfGrown,
  claimCovers
} from "./coordination.mjs";
import { commitFence, attributeBreakage } from "./fences.mjs";
import { sendCoordMail } from "./coord-mail.mjs";

// Gate phases whose fail edge (verdict === "implement") triggers breakage
// attribution (Q6): a loop-back to implement from one of these, with other live
// same-project cards present, asks "who broke me?" before looping.
const GATE_PHASES = new Set(["review", "adversarial-review", "test", "adversarial-test", "validate"]);
import {
  loadPolicy,
  policyLoadState,
  phaseForList,
  skillForPhase,
  classificationForPhase,
  railForCard,
  phaseOnForCard,
  hasPhaseGateEvidence,
  gateEvidenceNextList
} from "./policy.mjs";

// Re-export phaseForList through the engine facade. scripts/kanban.mjs (the
// `node scripts/kanban.mjs --setup` CLI entrypoint) imports the whole board-helper
// surface from engine.mjs; phaseForList is defined in policy.mjs and engine only
// imported it for internal use, so without this re-export that top-level import
// throws "does not provide an export named 'phaseForList'" and setup exits 1. No
// vitest exercises kanban.mjs's module load, so only a live `up` surfaces it.
export { phaseForList };
// D15 (S4a): a card's next list comes from ITS resolved (duty, level) sequence,
// not a hardcoded column order. validNextForCard returns the card's own valid
// next-list ids (forward step + implement fail-edge for a gate); it returns null
// for a legacy card with no duty/level/sequence, and the caller falls back to the
// board's static validNext — so nothing changes for cards that don't carry a duty.
import { loadResolvedModel, validNextForCard, nextListForCard, contextHoldFor } from "./resolved-model.mjs";

// EMPTY-OUTPUT GRACE WINDOW (D19, assumption 2). An empty phase reply is often a
// PREMATURE `done` event: the gateway's reply stream closed while the operative
// was STILL writing its gate-status.json (observed: the gate landed ~2.5 min
// AFTER the empty done, parking a genuinely-succeeding run). So on an empty reply
// we do NOT park immediately — we poll the phase's gate file over a bounded grace
// window and, if it lands and names a next step, advance per the gate. Bounded
// (default 6 checks × 30s ≈ 3 min) and configurable via env; the sleep is
// injectable so tests drive the race deterministically without real waits.
const EMPTY_GATE_GRACE_CHECKS = Math.max(0, Number(process.env.GARRISON_EMPTY_GATE_GRACE_CHECKS) || 6);
const EMPTY_GATE_GRACE_INTERVAL_MS = Math.max(0, Number(process.env.GARRISON_EMPTY_GATE_GRACE_INTERVAL_MS) || 30000);
const defaultGraceSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve the grace config from a per-call override (tests) over the env defaults.
export function resolveEmptyGrace(opts = {}) {
  return {
    checks: Number.isFinite(opts.checks) ? Math.max(0, opts.checks) : EMPTY_GATE_GRACE_CHECKS,
    intervalMs: Number.isFinite(opts.intervalMs) ? Math.max(0, opts.intervalMs) : EMPTY_GATE_GRACE_INTERVAL_MS,
    sleep: typeof opts.sleep === "function" ? opts.sleep : defaultGraceSleep
  };
}

// Poll the phase's durable gate evidence over the grace window. Returns
// { next, waited, checks, intervalMs } — `next` is the gate-named next list id
// (one of validNext) or null after the window is exhausted.
export async function pollForGateEvidence({ cwd, runDir, phase, validNext, checks, intervalMs, sleep }) {
  for (let i = 0; i < checks; i++) {
    await sleep(intervalMs);
    const next = gateEvidenceNextList(cwd, runDir, phase, validNext);
    if (next) return { next, waited: i + 1, checks, intervalMs };
  }
  return { next: null, waited: checks, checks, intervalMs };
}

// Last ~15 lines of a card's phase iteration log (cards/<id>/log-<n>.md) — the
// log-tail evidence attached to an empty-output failure so the parked card
// carries proof of WHAT the operative produced (nothing but the header, for a
// genuinely empty run) instead of an unfalsifiable claim. Read-only, best-effort.
export function readLogTail(root, cardId, iteration, maxLines = 15) {
  try {
    const file = path.join(root, "cards", String(cardId), `log-${iteration}.md`);
    if (!existsSync(file)) return "";
    const lines = readFileSync(file, "utf8").replace(/\s+$/, "").split("\n");
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

// The empty-output FAILURE CONTRACT copy (D19): it must (a) NEVER claim success
// (no "completed"/"done"/"success" phrasing), (b) carry a log-tail evidence
// excerpt when available, and (c) tell the operator the retry re-enters the SAME
// phase with prior context (runDir + iteration history) preserved, not reset.
export function buildEmptyFailureReason({ listTitle, phase = null, grace = null, logTail = "" }) {
  const parts = [`The ${listTitle} run returned no output — the operative produced nothing verifiable.`];
  if (grace && grace.waited > 0) {
    const secs = Math.round((grace.waited * (grace.intervalMs || 0)) / 1000);
    parts.push(
      `Garrison then waited ${secs}s (${grace.waited} check${grace.waited === 1 ? "" : "s"}) for ${phase ? `the ${phase} phase's ` : "the "}durable gate evidence to land, and none arrived.`
    );
  }
  parts.push(`There is no plan, no result, and no next step to advance on — an empty reply is a FAILURE, not a pass.`);
  if (logTail && logTail.trim()) {
    parts.push(`Last lines of the iteration log:\n---\n${logTail.trim()}\n---`);
  }
  parts.push(
    `The retry re-enters the ${phase || "same"} phase with your prior work preserved (the run directory and iteration history are kept, not reset). Move it back to retry, or add a description/project if the task was underspecified.`
  );
  return parts.join("\n\n");
}

// Does this card's run dir actually contain tangible evidence? A list flagged
// `requiresEvidence` (Walkthrough) must not advance on the operative's word alone — the
// "ALWAYS write evidence" instruction is self-attested, so we VERIFY it on disk:
// <cwd>/<runDir>/evidence/ must hold at least one regular file (a screenshot or
// evidence.md). Read-only + best-effort: any error → treated as no evidence.
export function hasEvidence(cwd, runDir) {
  if (!runDir || typeof runDir !== "string") return false;
  try {
    const dir = path.resolve(cwd || process.cwd(), runDir, "evidence");
    if (!existsSync(dir)) return false;
    return readdirSync(dir, { withFileTypes: true }).some((d) => d.isFile());
  } catch {
    return false;
  }
}

// Read the Discuss brief a card links (card.briefPath), so the discussion's RESULT
// becomes context for the downstream phases (plan/implement/…). The brief path is set
// by the server (recordBrief / the Move-out-of-Discuss auto-link) and is project-
// relative; we confine the read to the project root (cwd) defensively, require a
// regular readable file, and cap the size so a huge brief can't blow up the prompt.
// Best-effort: any miss returns null and the prompt simply omits the section.
export function readBriefContext(cwd, briefPath, max = 6000) {
  if (!briefPath || typeof briefPath !== "string") return null;
  try {
    const base = path.resolve(cwd || process.cwd());
    const abs = path.resolve(base, briefPath);
    if (abs !== base && !abs.startsWith(base + path.sep)) return null; // confine to cwd
    if (!existsSync(abs)) return null;
    const text = readFileSync(abs, "utf8").trim();
    if (!text) return null;
    return text.length > max ? text.slice(0, max).trimEnd() + "\n\n…(brief truncated)" : text;
  } catch {
    return null;
  }
}

// Read the CARD-OWNED Discuss brief (<root>/cards/<id>/brief.md) — the deterministic
// location James is told (an absolute path) to write to during Discuss. Best-effort +
// size-capped: a miss returns null and the prompt simply omits the brief section.
export function readCardBrief(root, cardId, max = 6000) {
  if (!root || !cardId || typeof cardId !== "string") return null;
  try {
    const abs = path.join(root, "cards", cardId, "brief.md");
    if (!existsSync(abs)) return null;
    const text = readFileSync(abs, "utf8").trim();
    if (!text) return null;
    return text.length > max ? text.slice(0, max).trimEnd() + "\n\n…(brief truncated)" : text;
  } catch {
    return null;
  }
}

// WS2 (D7): a continuation card's starting-context block, read FRESH at dispatch
// from the predecessor's handoff.json (like readCardBrief). Inlines the completion
// summary + decisions + files + a manifest of fetchable evidence refs + the chain,
// and instructs the operative to pull deeper artifacts via fetch_evidence. Returns
// null (prompt omits the block) when there is no continuation or no handoff yet.
export function buildContinuationContext(root, card) {
  if (!root || !card || typeof card.continues !== "string" || !card.continues) return null;
  let packet;
  try {
    const p = path.join(root, "cards", card.continues, "handoff.json");
    if (!existsSync(p)) return null;
    packet = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  if (!packet || typeof packet !== "object") return null;
  const lines = [`## Continuing from ${packet.cardId || card.continues}${packet.title ? ` - ${packet.title}` : ""}`, ""];
  // Cap the inline summary: the lastReply fallback path is uncapped upstream, and
  // the successor's fresh context must stay fresh (pull deeper detail on demand).
  if (packet.completionSummary) lines.push("Predecessor completion summary:", String(packet.completionSummary).slice(0, 2000), "");
  if (Array.isArray(packet.keyDecisions) && packet.keyDecisions.length) {
    lines.push("Key decisions carried forward:");
    for (const d of packet.keyDecisions.slice(0, 20)) lines.push(`- ${d}`);
    lines.push("");
  }
  if (Array.isArray(packet.filesTouched) && packet.filesTouched.length) {
    lines.push("Files the predecessor touched:");
    for (const f of packet.filesTouched.slice(0, 40)) lines.push(`- ${f}`);
    lines.push("");
  }
  if (Array.isArray(packet.evidenceManifest) && packet.evidenceManifest.length) {
    lines.push(`Predecessor evidence you can pull on demand via the garrison-control tool fetch_evidence("${card.continues}", <ref>):`);
    for (const e of packet.evidenceManifest.slice(0, 40)) lines.push(`- ${e.ref}: ${e.oneLiner}`);
    lines.push("");
  }
  if (Array.isArray(packet.chainIndex) && packet.chainIndex.length) {
    lines.push("Predecessor chain (oldest first):");
    for (const c of packet.chainIndex.slice(-20)) lines.push(`- ${c.cardId}${c.title ? ` (${c.title})` : ""}: ${c.oneLiner || ""}`);
    lines.push("");
  }
  lines.push(
    `Deeper artifacts are pull, not push: fetch them from predecessor ${card.continues} with ` +
      `fetch_evidence("${card.continues}", "<ref>") using the refs above — do not assume anything not listed here.`
  );
  return lines.join("\n");
}

const AGENT_KIND = "agent";

// The evidence home (GARRISON-UNIFY-V1 S6, D19): run directories live OUTSIDE
// the project repo, under ~/.garrison/runs/<project>/<runId>/ — the repo keeps
// only work products and committed re-runnable tests. runDir is now an
// ABSOLUTE path (path.resolve(cwd, runDir) is a no-op for absolute paths, so
// every existing consumer keeps working).
import os from "node:os";
const RUNS_HOME = () =>
  process.env.GARRISON_RUNS_DIR ||
  path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "runs");

// A path-safe project label for the runs home: the project's basename, with
// anything traversal-ish collapsed. Null project → "(no-project)".
export function runProjectLabel(project) {
  if (!project || typeof project !== "string") return "no-project";
  const base = path.basename(project.trim());
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+/, "");
  return safe || "no-project";
}

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
// first enters an agent list (Start → plan). runDir is ABSOLUTE under the
// evidence home (~/.garrison/runs/<project>/<runId>/, D19) so nothing
// run-scoped is ever written inside the project repo.
export function mintRunFields(card, now = Date.now) {
  if (card.runId && card.runDir) return null; // already minted — idempotent
  const runId = ulid(typeof now === "function" ? now() : now);
  return { runId, runDir: path.join(RUNS_HOME(), runProjectLabel(card.project), runId) };
}

// D15: per-list taskType/tier/skill/mode config is DEAD. Resolution comes from
// the compiled policy: the list's PHASE is the task type (D1) and the tier
// rides on the card — see classificationForPhase in ./policy.mjs. This shim
// remains only for external callers/tests that want the old projection; it now
// derives from the phase, never from per-list pins.
export function classificationFor(list) {
  return { taskType: phaseForList(list) || "other", tier: "T1-standard" };
}

// Rail fast-forward (D17): starting AT `listId`, return the first list whose
// phase is ON for this card, walking the pipeline via each list's first
// forward validNext edge. OFF phases collect into `skipped` so the caller can
// record them (rendered off, never silent). Terminal safety: stops at any
// non-agent list, an unknown list, or after 20 hops.
export function effectiveListForCard(board, rail, listId, card, model = null) {
  const skipped = [];
  let current = listId;
  for (let hops = 0; hops < 20; hops++) {
    const list = getList(board, current);
    if (!list) return { listId: current, skipped };
    if (list.kind !== AGENT_KIND || isInteractive(list)) return { listId: current, skipped };
    const phase = phaseForList(list);
    if (phaseOnForCard(rail, phase)) return { listId: current, skipped };
    skipped.push(phase);
    // D15 (S4a): the forward step for a card carrying a resolved (duty, level)
    // sequence follows ITS sequence (nextListForCard — the next leaf after this
    // phase, or "done" at the sequence end), NEVER the board's static column
    // order. Only a LEGACY card (no sequence, or a phase off its sequence →
    // nextListForCard null) uses the board's forward validNext edge (the first
    // that is not the implement loop-back or needs-attention).
    const forward = nextListForCard(card, phase, model) ??
      (list.validNext || []).find((n) => n !== "implement" && n !== ATTENTION_LIST) ??
      (list.validNext || [])[0];
    if (!forward) return { listId: current, skipped };
    current = forward;
  }
  return { listId: current, skipped };
}

export const ATTENTION_LIST = "needs-attention";

// ── execution timeline (FINDING: visibility) ─────────────────────────────────
//
// A card carries a capped, append-only `events` array — a human-readable timeline
// of WHAT HAPPENED to it (dispatched, replied, routed, parked, deferred, failed,
// inferred). This is the spine of "what is happening with the executions": every
// transition the engine makes records a timestamped event with a plain-language
// message (and optional `detail`, e.g. the operative's actual reply), so the UI can
// show a real activity feed instead of a silent colored dot + a cryptic park line.
export const MAX_EVENTS = 60;

// Append an event to a card's timeline, returning the NEW capped events array
// (never mutates the input — the card is rewritten CAS-safely by the caller). Keep
// the most recent MAX_EVENTS so a long-lived card's history stays bounded.
export function withEvent(card, event, max = MAX_EVENTS) {
  const events = Array.isArray(card?.events) ? card.events.slice() : [];
  events.push(event);
  return events.length > max ? events.slice(events.length - max) : events;
}

// A short, single-snippet projection of the operative's reply for the card front +
// the park event detail (the full reply lives in the iteration log; this is the
// "what it actually said" the user sees without digging). Collapses whitespace runs
// so a multi-line reply reads on one card line; the detail keeps newlines.
export function replySnippet(reply, max = 280) {
  const text = String(reply ?? "").trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
}

// Fold the gateway's per-turn route metadata (from the `done` SSE event, surfaced by
// gateway-client.routeFromDone) into the compact stamp we persist on a `routed` event —
// { targetId, runtime, provider, model, tier, phase } — plus a human SUFFIX
// ("· claude-code/opus (T2-deep)") appended to the event message. `phase` is the
// engine's own phase name (always known) so the card-front chip can read "plan @ opus"
// even when the gateway's own taskType echo is null. Returns { route: null, suffix: "" }
// when NO routing metadata flowed (souls mode / a non-routed turn) — a run must NEVER
// fail, and an event must never grow noise, for want of attribution that isn't there.
export function routeStamp(route, phase = null) {
  if (!route || typeof route !== "object") return { route: null, suffix: "" };
  const targetId = route.targetId ?? null;
  const runtime = route.runtime ?? null;
  const provider = route.provider ?? null;
  const model = route.model ?? null;
  const tier = route.tier ?? null;
  const effort = route.effort ?? null;
  if (targetId == null && runtime == null && provider == null && model == null && tier == null && effort == null) {
    return { route: null, suffix: "" };
  }
  const stamp = { targetId, runtime, provider, model, tier, effort, phase: phase ?? null };
  // "runtime/model" (runtime preferred, provider as fallback), then "(tier · effort)".
  const idPart = [runtime || provider, model].filter(Boolean).join("/");
  let suffix = "";
  if (idPart) suffix = ` · ${idPart}`;
  const paren = [tier, effort].filter(Boolean).join(" · ");
  if (paren) suffix += suffix ? ` (${paren})` : ` · (${paren})`;
  return { route: stamp, suffix };
}

// Park a card in the needs-attention COLUMN (a real list move, not just a status
// flag) so stuck work LEAVES the pipeline and shows up where the user looks for it —
// carrying WHY it parked (attentionReason) and WHERE it came from (parkedFrom) so the
// board can show the reason + send it back. Moving a card OUT of needs-attention
// (board PATCH) clears these + resets the iteration count for a clean retry.
export function parkFields(card, fromList, reason) {
  return {
    list: ATTENTION_LIST,
    status: "needs-attention",
    parkedFrom: fromList ?? card.parkedFrom ?? null,
    attentionReason: reason
  };
}

// Parse the router's chosen next list. Takes the last non-empty line (the
// router-prompt convention is to end with the verdict) and EXACT-matches it against
// the valid next list ids. No match → null (→ needs-attention).
export function parseNextList(routerOutput, validNext) {
  const text =
    typeof routerOutput === "string" ? routerOutput : routerOutput?.reply ?? routerOutput?.text ?? "";
  // The operative's verdict (a bare next-list id at the end of its reply) gets HIDDEN by
  // gateway STATUS BADGES the gateway appends AFTER it — "[route: cc-sonnet-med | … ]",
  // "[orchestrator-active]". Those land on their own line SOMETIMES, but the xterm
  // screen-reader also reflows long replies, so the badges + the verdict frequently end
  // up FLOWED onto one line: "… Gate green. [route: …] [orchestrator-active] implement".
  // Strip every "[…]" badge span first, then look for the verdict — still EXACT-matching
  // against validNext (no fuzzy/substring guessing): (1) a clean whole-line match from the
  // bottom, then (2) the LAST bare token of the cleaned reply (the "end with the token"
  // convention), trailing punctuation trimmed. (2) is what rescues a verdict flowed onto a
  // prose/badge line — the exact case where a CORRECT verdict was being parked.
  const cleaned = String(text).replace(/\[[^\]\n]*\]/g, " ");
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (validNext.includes(lines[i])) return lines[i];
  }
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/^[^A-Za-z0-9-]+|[^A-Za-z0-9-]+$/g, ""))
    .filter(Boolean);
  const last = tokens.length ? tokens[tokens.length - 1] : "";
  return validNext.includes(last) ? last : null;
}

// Combined execute + router prompt. goal-mode prepends /goal + acceptance; the card's
// runDir is threaded in as literal text (the gateway `skill` field is inert, so the
// run dir must be IN the prompt for the garrison skill to write per-run); the valid
// next-list ids are injected so the router output can exact-match. D15: the per-list
// mode line is GONE (mode is the gateway's job); the executing skill is resolved from
// the compiled policy and named explicitly (the phase-skill binding, D3).
export function buildCardPrompt({ list, card, validNext, discussionContext = null, continuationContext = null, skill = null, phase = null, coordinationEnabled = false }) {
  const parts = [];
  if (card.goalMode && list.kind === AGENT_KIND) {
    const acceptance = card.acceptance || card.description || "(lift acceptance from FLOW_PLAN.md)";
    parts.push(`/goal ${acceptance}`, "");
  }
  // THE work item itself. Without this the operative is told to "plan/implement this
  // card" but is never told WHAT the card is — it has no title, no description, no
  // project, so it produces nothing and the card parks for "no valid next list" (the
  // exact failure the user hit). Always include the title; the project (or an explicit
  // "infer it" note when absent); and the description when present. This is the task.
  parts.push(`# Work item: ${card.title || "(untitled)"}`);
  parts.push(
    card.project
      ? `Project: ${card.project}`
      : `Project: (none assigned — infer the target project/repository from the description below, or work in the current repository)`
  );
  if (card.description && card.description.trim()) {
    parts.push("", card.description.trim());
  }
  // The Discuss step's RESULT (the brief James wrote) — the agreed direction the
  // downstream phases must build from. Injected verbatim so plan/implement/review have
  // the decisions/approach/open-questions/acceptance the discussion settled on.
  if (discussionContext && String(discussionContext).trim()) {
    parts.push(
      "",
      "## Discussion (decided in the Discuss step — this is the agreed direction; build from it)",
      "",
      String(discussionContext).trim()
    );
  }
  // WS2 (D7): a continuation card's starting context — the predecessor's completion
  // summary, decisions, files, and a manifest of fetchable evidence refs (pull, not
  // push). Pre-formatted by buildContinuationContext.
  if (continuationContext && String(continuationContext).trim()) {
    parts.push("", String(continuationContext).trim());
  }
  parts.push("");
  // Thread the per-run pointers so the phase skill writes its plan/gate files
  // under this card's run dir and references this card's slice — the skill cannot get
  // these from the inert gateway fields, so they go in the prompt body.
  if (card.runDir) {
    parts.push(`Run directory (write all per-run artifacts here): ${card.runDir}`);
    if (card.sliceId) parts.push(`Slice id: ${card.sliceId}`);
    parts.push("");
  }
  // The durable-gate CONTRACT, spelled out (D9). Operatives that skip the phase
  // skill tend to hand-write a gate record in a shape the engine does not accept
  // (observed: {"plan": …} at top level) and the card parks despite real work.
  // State the exact accepted shapes so even a direct write can satisfy the gate.
  if (phase && card.runDir && list.kind === AGENT_KIND) {
    parts.push(
      `Durable gate record (REQUIRED to advance, D9): before choosing the next list, write ` +
        `${path.join(card.runDir, `gate-status.${phase}.json`)} — JSON like ` +
        `{"status":"passed|failed","next_phase":"<one of: ${validNext.join(", ")}>","notes":"…"} — ` +
        `or add the same object under the "gates" key as {"gates":{"${phase}":{…}}} in ` +
        `${path.join(card.runDir, "gate-status.json")}. A top-level {"${phase}":{…}} shape is NOT accepted. ` +
        `A verdict without this record parks the card.`,
      ""
    );
  }
  // Retry-with-reason: a recovered card re-runs the SAME phase with the SAME prompt,
  // so without feedback it repeats the exact failure that parked it. Surface the most
  // recent park from this phase so the retry can fix the specific miss.
  const lastPark = Array.isArray(card.events)
    ? [...card.events].reverse().find((e) => e && e.kind === "parked" && typeof e.message === "string" && e.message.startsWith(`Parked from ${list.title || list.id}`))
    : null;
  if (lastPark) {
    parts.push(`A previous attempt at this phase parked: ${lastPark.message}. Address that specifically this time.`, "");
  }
  // D3/D15: name the policy-bound skill for this phase so the operative executes
  // the phase through it (the binding is configuration — swapping it in the
  // composer changes this line with zero code changes). The skill itself
  // re-reads the compiled policy for its model/effort (the bindable contract).
  if (phase && skill) {
    parts.push(
      `Execute the ${phase} phase of this run using the \`${skill}\` skill (the compiled ` +
        `Orchestrator policy binds it for this phase). The skill reads ` +
        `~/.garrison/orchestrator/policy.json for its execution parameters and MUST write ` +
        `this phase's gate-status entry under the run directory before you choose the next list.`,
      // D13 guard: this dispatch IS an engine-owned Kanban card already. Without
      // this line, "implement/add X" wording auto-triggers the full `garrison`
      // skill in the operative, which registers a SECOND card for the same work
      // (observed live: duplicate cards racing each other through the pipeline).
      `This dispatch is already an engine-owned Kanban card — do NOT invoke the \`garrison\` ` +
        `skill and do NOT register or create any new card for this work; run only the ` +
        `\`${skill}\` phase skill above.`,
      ""
    );
  }
  // Coordination (GARRISON-FLOW-V2 Q1): multiple runs may share this project and
  // branch. The PLAN phase must predict a touch-set so the engine can order
  // overlapping runs — it is required evidence to advance past Plan. The file is
  // re-read on each fence, so keep it honest and update it first if the work
  // needs to grow beyond the prediction.
  if (coordinationEnabled && phase === "plan" && card.runDir) {
    parts.push(
      `COORDINATION: other autonomous runs may be working this same project and branch at the ` +
        `same time. As part of planning you MUST write a touch-set prediction to ` +
        `${path.join(card.runDir, "touch-set.json")} — a JSON object of the form ` +
        `{"version":1,"cardId":"${card.id}","runId":"${card.runId || ""}","project":${JSON.stringify(card.project || null)},` +
        `"predictedAt":"<ISO>","files":["repo/relative/path.ts"],"dirs":["src/area/"],"surfaces":["config-key or table"],` +
        `"exclusive":["files that must not be touched concurrently"],"notes":"free text"} listing the repo-relative ` +
        `files and directory prefixes this run will modify. Be honest and complete; the engine uses it to detect ` +
        `overlap and order runs, and Plan cannot advance without a valid touch-set.json.`,
      ""
    );
  }
  if (list.executePrompt) parts.push(list.executePrompt, "");
  parts.push(
    // Strict exact-match routing is by design (no fuzzy matching), so the operative
    // MUST emit the verdict token — and crucially must still CHOOSE a next list when
    // the work turns out already-done/clean, instead of explaining "nothing to do"
    // (which parks an effectively-finished card). Spell both out.
    `When done, you MUST choose the next list. Even if the work was already complete, ` +
      `clean, or there was nothing left to do, still pick the appropriate FORWARD list — ` +
      `do not explain instead of choosing. Your reply MUST end with the chosen list id on ` +
      `its OWN FINAL LINE, as a bare token (no prose on that line), EXACTLY one of: ${validNext.join(", ")}.`
  );
  if (list.routerPrompt) parts.push("", list.routerPrompt);
  return parts.join("\n");
}

// S1b: the focus context the compact controller renders into its template at a
// duty boundary. Best-effort off the card; empty fields collapse to the generic
// template variant (the renderer drops empty-placeholder lines). Never throws.
export function focusContextForCard(card, phase) {
  if (!card || typeof card !== "object") return {};
  const fences = Array.isArray(card.fences)
    ? card.fences.filter((f) => f && f.sha).map((f) => String(f.sha).slice(0, 10))
    : [];
  return {
    card_id: card.id ?? "",
    card_title: card.title ?? "",
    duty: card.duty ?? phase ?? "",
    level: card.level != null ? String(card.level) : "",
    decisions: card.briefPath ? `see ${card.briefPath}` : "",
    open_items: "",
    files_touched: fences.length ? fences.join(", ") : card.runDir ? String(card.runDir) : "",
    steering: ""
  };
}

// Best-effort read of the phase's durable gate record summary/notes (WS2). Tries
// the three accepted shapes: <runDir>/gate-status.<phase>.json (sidecar), the
// run-level gate-status.json gates{<phase>}, and slices/<sliceId>/gate-status.json.
// Returns the first non-empty summary|notes string, or null. Never throws.
export function readGateSummary(cwd, runDir, phase, sliceId = null) {
  if (!runDir || !phase) return null;
  const abs = (rel) => path.resolve(cwd || process.cwd(), runDir, rel);
  const readJson = (p) => {
    try {
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const pick = (rec) => {
    if (!rec || typeof rec !== "object") return null;
    const s = typeof rec.summary === "string" && rec.summary.trim() ? rec.summary.trim() : null;
    const n = typeof rec.notes === "string" && rec.notes.trim() ? rec.notes.trim() : null;
    return s || n || null;
  };
  const sidecar = readJson(abs(`gate-status.${phase}.json`));
  if (pick(sidecar)) return pick(sidecar);
  const runLevel = readJson(abs("gate-status.json"));
  if (runLevel?.gates && typeof runLevel.gates === "object" && pick(runLevel.gates[phase])) return pick(runLevel.gates[phase]);
  if (sliceId && /^[A-Za-z0-9._-]{1,128}$/.test(sliceId)) {
    const sliceRec = readJson(abs(path.join("slices", sliceId, "gate-status.json")));
    if (sliceRec?.gates && typeof sliceRec.gates === "object" && pick(sliceRec.gates[phase])) return pick(sliceRec.gates[phase]);
    if (pick(sliceRec)) return pick(sliceRec);
  }
  return null;
}

// WS2 duty summary standard (D6): at every genuine advance the ENGINE writes a
// durable per-duty record it owns (the operative self-attests the gate record; this
// is the engine's own rollup) under <runDir>/duty-summary.<phase>.json. runDir may be
// null for a card that never minted run fields — skip silently. Best-effort; never
// throws, never affects the advance.
export function writeDutySummary(cwd, { card, phase, listFrom, listTo, summary, logRef, gateSummary, context, now }) {
  try {
    if (!card?.runDir || !phase) return null;
    const dir = path.resolve(cwd || process.cwd(), card.runDir);
    const record = {
      cardId: card.id,
      phase,
      level: card.level ?? null,
      at: typeof now === "function" ? now() : new Date().toISOString(),
      listFrom: listFrom ?? null,
      listTo: listTo ?? null,
      summary: typeof summary === "string" ? summary.slice(0, 1200) : null,
      logRef: logRef ?? null,
      gateSummary: gateSummary ?? null,
      context: context ?? null
    };
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `duty-summary.${phase}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
    // rename is atomic on the same fs; fall back to the direct write if it races.
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
    }
    return record;
  } catch {
    return null;
  }
}

// Append a session id to the card's sessionIds uniquely (WS2 — the E4 dead field).
// The gateway's done frame carries the operative session id; appending it makes the
// session:<i> transcript ref resolvable. Pure; returns the next array.
export function appendSessionId(sessionIds, sessionId) {
  const list = Array.isArray(sessionIds) ? sessionIds.slice() : [];
  if (typeof sessionId === "string" && sessionId && !list.includes(sessionId)) list.push(sessionId);
  return list;
}

// Fire the gateway's duty-boundary compact check (S1b) after a card advances a
// duty. Best-effort: onDutyBoundary is fire-and-forget-with-timeout and a failure
// must never affect the advance. No-op when the caller wired no boundary fn (tests,
// souls mode) or the card did not move.
async function fireDutyBoundary(onDutyBoundary, card, phase, outcome) {
  if (typeof onDutyBoundary !== "function" || outcome?.status !== "moved") return;
  try {
    await onDutyBoundary({
      cardId: card.id,
      dutyKey: `${card.id}:${outcome.to}`,
      focusContext: focusContextForCard(card, phase)
    });
  } catch {
    /* boundary compaction is advisory — never fail the advance */
  }
}

// Run ONE transition for a card on an agent list. runFn dispatches the prompt
// through the orchestrator (preRoute) and returns { reply }. Returns the updated
// card + an outcome ({status: moved|needs-attention|skipped, ...}).
export async function processCard({ root, board, card, runFn, cap = 10, now = () => new Date().toISOString(), cwd = process.cwd(), emptyGrace = {}, model = undefined, onDutyBoundary = undefined }) {
  const grace = resolveEmptyGrace(emptyGrace);
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
  // Coordination waiting guard (GARRISON-FLOW-V2 Q4): a card deferred behind an
  // overlapping run SITS on its list with a waitingOn descriptor — it must not be
  // dispatched until reevaluateWaiting releases it (or a human Start override
  // clears the wait). Belt-and-suspenders here in addition to the tick/dispatch
  // skips, so no path re-dispatches a waiting card.
  if (card.waitingOn) {
    return { card, outcome: { status: "waiting", reason: "waiting-on", waitingOn: card.waitingOn } };
  }
  // A human label for the list, used in every event/park message so the timeline reads
  // "Plan", not "plan".
  const listTitle = list.title || card.list;
  // Every write is a compare-and-swap against the rev we read, so a concurrent tick or
  // a manual edit cannot be silently overwritten (lost update).
  const baseRev = card.rev ?? 0;
  if ((card.iterations || 0) >= cap) {
    const capReason = `Hit the iteration cap on ${listTitle} (${cap} runs without choosing a valid next step). Parked so it stops looping — move it back to retry, or open it to see why it kept failing.`;
    const res = await saveCardCAS(
      root,
      {
        ...card,
        ...parkFields(card, card.list, capReason),
        lastDispatchError: null,
        events: withEvent(card, { at: now(), kind: "parked", message: `Parked from ${listTitle}: iteration cap (${cap})`, detail: capReason })
      },
      baseRev,
      now()
    );
    if (!res.ok) return { card: res.card, outcome: { status: "skipped", reason: "conflict" } };
    return { card: res.card, outcome: { status: "needs-attention", reason: "iteration-cap" } };
  }

  const iteration = (card.iterations || 0) + 1;
  // D15: resolve everything from the compiled policy up front — the list's
  // phase is the task type, the executing skill is the phase's binding.
  const policy = loadPolicy();
  const phase = phaseForList(list);
  // D15 (S4a): a card carrying a resolved (duty, level) sequence advances along
  // ITS sequence, not the board's static column edges. validNextForCard returns
  // the card's own [forward, fail?] set; null → legacy card → the board's
  // validNext. `model` is injected by tests; otherwise read from the board root
  // (absent in a sandbox → null → legacy behaviour, so existing tests are inert).
  const resolvedModel = model !== undefined ? model : loadResolvedModel(root);
  const validNext = validNextForCard(card, phase, resolvedModel) ?? validNextFor(board, card.list);
  const skill = skillForPhase(policy, phase, card.workKind || policy?.defaultWorkKind);
  // Coordination is ACTIVE when the compiled policy explicitly carries a
  // `coordination` section (turned on by the composer — S6 — for production; a
  // policy that predates it, and the deliberate policy-less pure-transition mode,
  // never coordinate, exactly like the D9 gate-evidence checks), it is enabled
  // (DEFAULT_COORDINATION fills every sub-key so a present-but-partial section
  // still works), AND its substrate is usable. When enabled-but-unavailable the
  // serialize gate (kanban.mjs) restricts to one live card per project instead, so
  // the plan-completion overlap path is simply skipped here (no concurrent overlap
  // to order).
  const coordCfg = coordinationConfig(policy);
  const coordActive = Boolean(policy && policy.coordination) && coordCfg.enabled && coordinationAvailability().ok;
  // D17 rail fast-forward ON ENTRY: a card sitting on a list whose phase its
  // rail turns OFF advances without dispatching, each skipped phase recorded
  // as an explicit "off" event (rendered off, never a silent pass).
  const rail = railForCard(policy, card);
  if (rail && !phaseOnForCard(rail, phase)) {
    const { listId: fwd, skipped } = effectiveListForCard(board, rail, card.list, card, resolvedModel);
    const offEvents = skipped.map((ph) => ({
      at: now(),
      kind: "phase-off",
      message: `Phase ${ph} is OFF for this card (${rail.workKind || "work kind"}) — recorded off, not run`
    }));
    let events = card.events ? card.events.slice() : [];
    for (const ev of offEvents) events = withEvent({ events }, ev);
    const res = await saveCardCAS(
      root,
      { ...card, list: fwd, events },
      baseRev,
      now()
    );
    if (!res.ok) return { card: res.card, outcome: { status: "skipped", reason: "conflict" } };
    return { card: res.card, outcome: { status: "moved", from: card.list, to: fwd, phasesOff: skipped } };
  }
  // Exclusive-lease gate (D6): before dispatching IMPLEMENT for a card whose
  // touch-set declares `exclusive` paths, take the local leases. Held by another
  // live card -> the card WAITS (until:"lease", re-dispatches in place on release)
  // WITHOUT consuming an iteration or dispatching. Checked before the acquire so a
  // blocked card never burns a run.
  if (coordActive && phase === "implement" && card.runDir) {
    const ts = readTouchSet(card.runDir);
    const excl = [...(ts?.exclusive || [])];
    // D6: union in the policy's always-exclusive list for every path this
    // card's claims COVER - a lockfile under a claimed dir is exclusive even
    // when the prediction forgot to mark it.
    for (const p of coordCfg.exclusiveLeases || []) {
      if (!excl.includes(p) && ts && claimCovers(ts, p)) excl.push(p);
    }
    if (excl.length) {
      const repoPath = repoPathForProject(card.project, board);
      if (repoPath) {
        const lease = acquireLeases({ repoPath, card, paths: excl, ttlMinutes: coordCfg.leaseTtlMinutes, now });
        if (!lease.ok) {
          // Resolve the holder's title so the UI shows a name, not a bare id tail.
          let holderTitle = null;
          if (lease.heldBy) { try { holderTitle = (await loadCard(root, lease.heldBy))?.title || null; } catch { /* best-effort */ } }
          const reason = `exclusive lease held by ${holderTitle ? `${holderTitle} (${String(lease.heldBy).slice(-6)})` : lease.heldBy || "another run"} on ${excl.join(", ")}`;
          const waitingOn = {
            cardId: lease.heldBy || null,
            cardTitle: holderTitle,
            grade: "lease",
            reason,
            until: "lease",
            thenTo: card.list,
            rerun: true,
            since: now()
          };
          const res = await saveCardCAS(root, {
            ...card,
            waitingOn,
            events: withEvent(card, { at: now(), kind: "coordination", message: `Waiting on exclusive lease before Implement: ${excl.join(", ")}`, detail: reason })
          }, baseRev, now());
          if (!res.ok) return { card: res.card, outcome: { status: "skipped", reason: "conflict" } };
          return { card: res.card, outcome: { status: "waiting", reason: "lease", waitingOn } };
        }
      }
    }
  }
  // Mint runId + runDir on the card's FIRST agent-list entry, and fold the mint into
  // OUTPOST AFFINITY (D27): a card naming an outpost runs its phase sessions
  // there; a NAMED-BUT-OFFLINE outpost parks the card in needs-attention with
  // that reason (never silently runs locally against the card's affinity).
  // The resolution seam lives in ./outpost-dispatch.mjs (single-outpost only).
  if (card.outpost) {
    try {
      const { resolveOutpostDispatch } = await import("./outpost-dispatch.mjs");
      const daemon = process.env.GARRISON_OUTPOST_URL || "http://127.0.0.1:3702";
      let outposts = [];
      try {
        const r = await fetch(`${daemon}/outposts`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) outposts = (await r.json()).outposts || [];
      } catch { /* daemon down → treated as offline below */ }
      const disp = resolveOutpostDispatch(card, outposts);
      if (!disp.ok) {
        const reason = `Outpost affinity "${card.outpost}" is not dispatchable: ${disp.reason || "offline"}. Parked until the outpost is back (or clear the affinity from needs-attention).`;
        const res = await saveCardCAS(root, {
          ...card,
          ...parkFields(card, card.list, reason),
          events: withEvent(card, { at: now(), kind: "parked", message: `Parked from ${listTitle}: outpost ${card.outpost} offline`, detail: reason })
        }, baseRev, now());
        if (!res.ok) return { card: res.card, outcome: { status: "skipped", reason: "conflict" } };
        return { card: res.card, outcome: { status: "needs-attention", reason: "outpost-offline" } };
      }
    } catch {
      // The seam is absent (outposts not built/installed) — an affinity card
      // cannot honor its affinity; park honestly rather than run locally.
      const reason = `Outpost affinity "${card.outpost}" cannot be resolved (outpost dispatch unavailable). Parked.`;
      const res = await saveCardCAS(root, {
        ...card,
        ...parkFields(card, card.list, reason),
        events: withEvent(card, { at: now(), kind: "parked", message: `Parked from ${listTitle}: outpost dispatch unavailable`, detail: reason })
      }, baseRev, now());
      if (!res.ok) return { card: res.card, outcome: { status: "skipped", reason: "conflict" } };
      return { card: res.card, outcome: { status: "needs-attention", reason: "outpost-unavailable" } };
    }
  }
  // the SAME acquire write so it is persisted CAS-safely (no extra write, no race).
  const minted = mintRunFields(card, () => Date.parse(now()) || Date.now());
  // Acquire the card: CAS the running-status write (+ run fields if just minted). A
  // second concurrent tick fails the CAS here and skips, so a card is never processed
  // twice and the runId is never minted twice.
  const dispatchAt = now();
  const dispatchEvent = {
    at: dispatchAt,
    kind: "dispatch",
    message: `Dispatched to the operative on ${listTitle}${skill ? ` (${skill})` : ""} — run ${iteration}`,
    detail: card.project ? null : "No project assigned — the operative is asked to infer it from the description."
  };
  const acq = await saveCardCAS(
    root,
    {
      ...card,
      ...(minted || {}),
      status: "running",
      iterations: iteration,
      // When this run STARTED, so the UI can show a live "running 1:23" elapsed timer
      // (cleared/replaced on the terminal write below).
      runningSince: dispatchAt,
      events: withEvent(card, dispatchEvent)
    },
    baseRev,
    now()
  );
  if (!acq.ok) return { card: acq.card, outcome: { status: "skipped", reason: "conflict" } };
  const runningCard = acq.card;
  const runRev = runningCard.rev;

  // Fold the Discuss brief (if any) into the prompt so every downstream phase builds
  // from the agreed direction the discussion settled on.
  const discussionContext = readCardBrief(root, runningCard.id);
  const continuationContext = buildContinuationContext(root, runningCard);
  const prompt = buildCardPrompt({ list, card: runningCard, validNext, discussionContext, continuationContext, skill, phase, coordinationEnabled: coordActive });
  // Explicit policy-derived classification (phase = taskType, card tier). A
  // missing/unreadable policy degrades to classifier routing (null) — never
  // blocks a card.
  const classification = classificationForPhase(policy, phase, runningCard);
  // Live log: write the iteration header immediately (Watch shows the run STARTED,
  // not a blank pane), then overwrite the log with the operative's growing reply as
  // chunks stream in — so Watch shows progress instead of nothing-until-the-result.
  await writeCardLog(root, card.id, iteration, `# iteration ${iteration}\n\n_dispatching to the operative…_\n`);
  const onChunk = (full) => {
    void writeCardLog(root, card.id, iteration, `# iteration ${iteration}\n${full}\n`).catch(() => {});
  };
  // S1b dispatch hints: whether THIS duty holds off compaction (read off the
  // resolved model's holds[phase]) and a dutyKey identifying the card+phase, so the
  // gateway's turn-boundary check honors the hold and stamps the compact log.
  const contextHold = contextHoldFor(resolvedModel, phase);
  const dutyKey = `${card.id}:${phase}`;
  let out;
  try {
    out = await runFn({ prompt, card: runningCard, list, classification, skill, suppressContinuations: true, onChunk, contextHold, dutyKey });
    // Stale-echo guard: a reply whose [route: X] token names a DIFFERENT target
    // than the one the gateway resolved for THIS turn is the previous turn's
    // screen content (the PTY model-switch extraction wedge), not a verdict on
    // this phase. Treat it like transport — revert the acquire and retry —
    // instead of letting a ghost reply park the card for missing gate evidence.
    const echoToken = /\[route:\s*([^\s|\]]+)/.exec(String(out?.reply || ""))?.[1] ?? null;
    if (echoToken && out?.route?.targetId && echoToken !== out.route.targetId) {
      const e = new Error(
        `stale reply echo: the reply carries [route: ${echoToken}] but this turn resolved to ${out.route.targetId} — previous turn's screen content, retrying`
      );
      e.transport = true;
      throw e;
    }
  } catch (err) {
    // A TRANSPORT failure (gateway unreachable / restarting — err.transport from the
    // gateway client) is NOT the card's fault: REVERT the acquire (back to the prior
    // status, iteration un-consumed) so the run retries on the next tick/Start once the
    // gateway is back — never strand the card in needs-attention. Any other failure (a
    // real error from a booted gateway) is a genuine run failure and parks.
    if (err?.transport) {
      await appendCardLog(root, card.id, iteration, `# iteration ${iteration}\ngateway unavailable (deferred, will retry): ${err?.message || err}\n`);
      // Persist a one-line reason on the card so the UI can render "gateway
      // unavailable — retry" instead of looking ok. lastDispatchError is a
      // plain JSON field (file-per-card storage tolerates extra keys); cleared
      // on the next successful run.
      const reverted = {
        ...runningCard,
        status: card.status ?? "ok",
        iterations: card.iterations || 0,
        runningSince: null,
        lastDispatchError: {
          at: now(),
          reason: "gateway-unavailable",
          listId: card.list,
          message: String(err?.message || err)
        },
        events: withEvent(runningCard, {
          at: now(),
          kind: "deferred",
          message: `Gateway unavailable on ${listTitle} — left in place, will retry`,
          detail: String(err?.message || err)
        })
      };
      const res = await saveCardCAS(root, reverted, runRev, now());
      return { card: res.card ?? runningCard, outcome: { status: "deferred", reason: "gateway-unavailable", error: String(err?.message || err) } };
    }
    await appendCardLog(root, card.id, iteration, `# iteration ${iteration}\nrun failed: ${err?.message || err}\n`);
    const failReason = `The ${listTitle} run errored: ${String(err?.message || err)}. Parked so you can see the failure — open the log for details, then move it back to retry.`;
    const res = await saveCardCAS(root, {
      ...runningCard,
      ...parkFields(runningCard, card.list, failReason),
      runningSince: null,
      lastReply: replySnippet(String(err?.message || err)),
      lastDispatchError: {
        at: now(),
        reason: "run-failed",
        listId: card.list,
        message: String(err?.message || err)
      },
      events: withEvent(runningCard, {
        at: now(),
        kind: "failed",
        message: `Run errored on ${listTitle}`,
        detail: String(err?.message || err)
      })
    }, runRev, now());
    return { card: res.card ?? runningCard, outcome: { status: "needs-attention", reason: "run-failed", error: String(err?.message || err) } };
  }

  const reply = out?.reply ?? out?.text ?? String(out ?? "");
  // Per-turn routing attribution (the gateway's `done` event surfaces which
  // runtime/model/tier actually served THIS phase turn; null in souls mode / a
  // non-routed turn). Fall the tier back to the card's own tier so the stamp reflects
  // the routed tier even when the gateway omits its echo. Never load-bearing — a
  // missing route just means no attribution stamp on the routed event.
  const routeMeta = out?.route
    ? { ...out.route, tier: out.route.tier ?? runningCard.tier ?? null }
    : null;
  // Per-turn context telemetry (S1a / D5b): { contextPct, peakContextPct,
  // compactions } off the gateway `done` frame, null when none flowed. Stamped onto
  // the routed event so per-duty context lands on the card timeline. Never load-bearing.
  const contextMeta = out?.context && typeof out.context === "object" ? out.context : null;
  // WS2: record the operative session id (the E4 dead field) so transcript refs
  // resolve. Mutating runningCard.sessionIds propagates to every target below (each
  // built via ...runningCard); uniquely appended so a re-run never double-stamps.
  runningCard.sessionIds = appendSessionId(runningCard.sessionIds, out?.sessionId);
  // Final clean log (overwrites any partial live-streamed content with the
  // authoritative reply the operative returned).
  await writeCardLog(root, card.id, iteration, `# iteration ${iteration}\n${reply}\n`);

  const replyText = String(reply ?? "").trim();
  let snippet = replySnippet(replyText);
  let next = parseNextList(reply, validNext);
  // VERDICT NUDGE (robustness backstop). A heavy skill (walkthrough, validate) often ends
  // its turn NARRATING the action ("Writing the durable gate record now.") or returns
  // empty — so the verdict token never lands and a CORRECT run parks. Rather than
  // whack-a-mole the prompt of every gate, give the operative ONE focused follow-up that
  // asks for nothing but the token, in the same session (so it answers from the work it
  // just did). This is bounded (a single retry, not a loop — it doesn't consume an
  // iteration), only fires when the first reply had no valid verdict, and still parks
  // honestly if the nudge also fails to produce one.
  let nudged = false;
  // A policy pipeline phase (and only it) writes a durable gate-status.json, so
  // only it can be rescued by — or needs to WAIT for — gate evidence on an empty
  // reply. Computed here (reused for the D9 enforcement below) so the grace window
  // never fires for a non-gated phase.
  const pipelinePhase = policy && Array.isArray(policy.phases) && policy.phases.includes(phase);
  let emptyGraceResult = null; // set when an empty reply opened the grace window
  // DURABLE VERDICT first (D9 backstop, 2026-07-11): before spending an LLM
  // nudge turn, read the verdict from the phase's own gate record — the phase
  // skill writes next_phase there, and it survives reply-capture loss (the
  // observed case: a Workflow completion banner as the operative's final line).
  if (!next) {
    let durable = gateEvidenceNextList(cwd, runningCard.runDir, phase, validNext);
    // RACE FIX (D19, assumption 2): an EMPTY reply is frequently a PREMATURE
    // `done` event — the reply stream closed while the operative was still
    // writing its gate-status.json. Rather than park at once, poll the gate file
    // over the bounded grace window; if it lands and names a next step, advance
    // per the gate exactly as a non-empty durable verdict would.
    if (!durable && !replyText && runningCard.runDir && pipelinePhase) {
      emptyGraceResult = await pollForGateEvidence({ cwd, runDir: runningCard.runDir, phase, validNext, ...grace });
      if (emptyGraceResult.next) {
        durable = emptyGraceResult.next;
        await appendCardLog(root, card.id, iteration, `\n_(empty reply — gate evidence landed after ${emptyGraceResult.waited} grace check(s): ${durable})_\n`);
      }
    }
    if (durable) {
      next = durable;
      nudged = true; // same accounting as the nudge: a rescued verdict, not a first-line one
      if (!snippet) snippet = `verdict from durable gate evidence: ${durable}`;
      await appendCardLog(root, card.id, iteration, `\n_(verdict from durable gate evidence: ${durable})_\n`);
    }
  }
  if (!next) {
    try {
      const nudgePrompt =
        `Your previous reply did not end with the required next-step token, so the workflow can't advance. ` +
        `Based ONLY on the work you just completed, reply with NOTHING but EXACTLY one of these list ids — a single bare word, no punctuation, no explanation: ${validNext.join(", ")}.`;
      const nout = await runFn({ prompt: nudgePrompt, card: runningCard, list, classification, skill, suppressContinuations: true });
      const nudgeReply = nout?.reply ?? nout?.text ?? String(nout ?? "");
      const nnext = parseNextList(nudgeReply, validNext);
      if (nnext) {
        next = nnext;
        nudged = true;
        if (!snippet) snippet = replySnippet(nudgeReply);
        await appendCardLog(root, card.id, iteration, `\n_(follow-up verdict: ${nnext})_\n`);
      }
    } catch {
      // Nudge failed (gateway hiccup) — fall through and park with the ORIGINAL reply.
    }
  }
  // EVIDENCE GATE (walkthrough artifacts). A list flagged `requiresEvidence` must leave
  // tangible proof on disk before it can advance — the operative's "I wrote the
  // evidence" verdict is self-attested, so we VERIFY <runDir>/evidence/ actually has a
  // file. If the run routed forward but produced nothing, we REFUSE the advance.
  let evidenceMissing = false;
  if (next && list.requiresEvidence && !hasEvidence(cwd, runningCard.runDir)) {
    next = null;
    evidenceMissing = true;
  }
  // DURABLE GATE EVIDENCE (D9). Phase progression requires the phase's
  // gate-status entry in the runDir IN ADDITION to the router verdict — a
  // transition without it parks in needs-attention. A FAILED entry is evidence
  // too (the implement loop-back still transitions with proof the gate ran).
  // Only enforced when the phase is a policy pipeline phase and a runDir exists.
  let gateEvidenceMissing = false;
  // Fail SAFE on a CORRUPT policy (rev2-s567 S5#1): a real run (has a runDir) whose
  // policy file exists but can't be parsed must NOT silently lose D9 and fast-forward
  // ungated — a null `policy` would make pipelinePhase falsy and skip the check
  // entirely. An ABSENT policy is the deliberate policy-less mode and is unaffected.
  if (next && !policy && runningCard.runDir && policyLoadState() === "corrupt") {
    next = null;
    gateEvidenceMissing = true;
  }
  if (next && pipelinePhase && runningCard.runDir && !hasPhaseGateEvidence(cwd, runningCard.runDir, phase)) {
    next = null;
    gateEvidenceMissing = true;
  }
  // Distinguish the outcomes a finished run can have, so the card carries a diagnostic
  // the user can act on instead of one opaque "no valid next list" line:
  //   • moved            — the router named a valid next list (possibly via nudge); advance.
  //   • evidence missing  — a requiresEvidence list routed forward but left NO evidence.
  //   • empty reply       — the operative returned NOTHING (and the nudge didn't rescue it).
  //   • no match          — the operative replied but never named a valid next id.
  const expected = validNext.join(", ");
  let target;
  let outcome;
  // Cross-card coordination writes (blocking-list + events on OTHER cards) and
  // mail are applied AFTER this card's own CAS save succeeds, so a save conflict
  // doesn't leave orphaned blocker/mail state.
  let blockerWrites = [];
  let terminalIntentRemoval = null;
  let mails = []; // [{ toCardId, subject, body }] sent via coord-mail after save
  let coordAllCards = null;
  let coordRepoPath = null;
  if (next) {
    // D17 rail fast-forward AFTER the verdict: if the named next list's phase
    // is OFF for this card's rail, skip forward to the first ON phase,
    // recording each skipped phase as an explicit off event.
    let effectiveNext = next;
    let offEvents = [];
    if (rail) {
      const fwd = effectiveListForCard(board, rail, next, runningCard, resolvedModel);
      if (fwd.listId !== next) {
        effectiveNext = fwd.listId;
        offEvents = fwd.skipped.map((ph) => ({
          at: now(),
          kind: "phase-off",
          message: `Phase ${ph} is OFF for this card (${rail.workKind || "work kind"}) — recorded off, not run`
        }));
      }
    }
    // Stability point (Q3): fold the first-clean-review marker into THIS same CAS
    // write (predicate lives in coordination.stabilityFields; null off the review
    // seam or when already recorded).
    const stab = stabilityFields(runningCard, phase, effectiveNext, now);
    // Coordination context, loaded ONCE per advance when active: the live
    // same-project peers (overlap/attribution candidates), the resolved repo path
    // (fences/attribution/leases), and this card's touch-set.
    if (coordActive) {
      coordAllCards = await loadAllCards(root);
      coordRepoPath = repoPathForProject(runningCard.project, board);
    }
    const liveCards = coordActive ? liveSameProjectCards(coordAllCards, runningCard, board) : [];
    const myTouchSet = coordActive ? readTouchSet(runningCard.runDir) : null;

    // (a) Plan-completion coordination (Q2/Q4): register the touch-set and either
    // advance, defer behind an overlapping earlier run (wait), or park. Plan is
    // never batched, so this is the per-card seam.
    let coord = null;
    if (coordActive && phase === "plan") {
      coord = applyPlanCompletionCoordination({ board, card: runningCard, allCards: coordAllCards, policy, nextList: effectiveNext, now });
    }
    // (b) Breakage attribution (Q6): a gate fail edge (-> implement) with other
    // live cards present asks "who broke me?" BEFORE looping back. Only a clean
    // FOREIGN verdict converts the loop-back into an interference wait.
    let interference = null;
    if (coordActive && !coord && effectiveNext === "implement" && GATE_PHASES.has(phase) && liveCards.length) {
      const attr = attributeBreakage({ repoPath: coordRepoPath, victimCard: runningCard, victimTouchSet: myTouchSet, liveCards });
      if (attr.verdict === "foreign" && attr.offenderCardId) {
        const offender = liveCards.find((c) => c.id === attr.offenderCardId);
        if (offender) {
          const offenderFenceSha = Array.isArray(offender.fences) && offender.fences.length ? offender.fences[offender.fences.length - 1].sha : null;
          const reason = `broken by card ${offender.id} (${offender.title || "untitled"}) - commits ${attr.commits.map((s) => s.slice(0, 10)).join(", ")} touching ${attr.overlapFiles.join(", ")}`;
          const refunded = Math.max(0, (runningCard.iterations || 0) - 1);
          interference = {
            waitingOn: { cardId: offender.id, cardTitle: offender.title || null, grade: "interference", reason, until: "fence", offenderFenceSha, rerun: true, thenTo: card.list, since: now() },
            refunded,
            selfEvent: { at: now(), kind: "interference", message: `Interference: ${listTitle} failed due to card ${offender.title || "untitled"} (${String(offender.id).slice(-6)})'s commits - waiting for its fix (iteration refunded to ${refunded})`, detail: reason },
            blockerWrites: [{ cardId: offender.id, addBlocking: runningCard.id, event: { at: now(), kind: "interference", message: `Your commits broke card ${runningCard.id} (${runningCard.title || "untitled"}) at ${phase}`, detail: `${attr.overlapFiles.join(", ")} - it is waiting for your next fence (fix).` } }],
            mails: [{ toCardId: offender.id, subject: `Interference: you broke ${runningCard.id} at ${phase}`, body: reason }]
          };
        }
      }
    }
    if (coord) blockerWrites = coord.blockerWrites || [];
    if (coord?.mails?.length) mails = mails.concat(coord.mails);

    if (coord && coord.kind === "park") {
      target = {
        ...runningCard,
        ...parkFields(runningCard, card.list, coord.reason),
        runningSince: null,
        lastReply: snippet,
        lastDispatchError: null,
        planCompletedAt: coord.planCompletedAt,
        events: withEvent(runningCard, {
          at: now(),
          kind: "parked",
          message: `Parked from ${listTitle}: no valid touch-set for coordination`,
          detail: coord.reason
        })
      };
      outcome = { status: "needs-attention", reason: "no-touch-set", validNext };
    } else if (coord && coord.kind === "wait") {
      // The card SITS in Plan (gate evidence already written); the deferred move
      // to thenTo happens on release. No "routed" event — it did not route.
      let events = runningCard.events ? runningCard.events.slice() : [];
      for (const ev of coord.selfEvents || []) events = withEvent({ events }, ev);
      target = {
        ...runningCard,
        status: "ok",
        runningSince: null,
        lastReply: snippet,
        lastDispatchError: null,
        planCompletedAt: coord.planCompletedAt,
        waitingOn: coord.waitingOn,
        events
      };
      outcome = { status: "waiting", from: card.list, waitingOn: coord.waitingOn };
    } else if (interference) {
      // Foreign breakage (D5): the victim does NOT loop to implement. It sits on
      // its gate list waiting for the offender's fix fence; the consumed iteration
      // is refunded (foreign breakage must not eat the victim's cap).
      blockerWrites = interference.blockerWrites;
      mails = mails.concat(interference.mails);
      target = {
        ...runningCard,
        status: "ok",
        runningSince: null,
        iterations: interference.refunded,
        lastReply: snippet,
        lastDispatchError: null,
        waitingOn: interference.waitingOn,
        events: withEvent(runningCard, interference.selfEvent)
      };
      outcome = { status: "waiting", from: card.list, reason: "interference", waitingOn: interference.waitingOn };
    } else {
      // Genuine advance. Commit a fence (Q5) BEFORE the CAS save so its sha folds
      // into this same write; maintain exclusive leases (renew while implementing,
      // release on advancing past implement or to terminal).
      let fences = Array.isArray(runningCard.fences) ? runningCard.fences.slice() : [];
      let fenceEvents = [];
      const landed = getList(board, effectiveNext);
      const landedTerminal = Boolean(landed?.terminal || effectiveNext === "done");
      if (coordActive && coordCfg.fences?.enabled && runningCard.runDir) {
        const otherClaims = liveCards.map((c) => readTouchSet(c.runDir)).filter(Boolean);
        const f = commitFence({ repoPath: coordRepoPath, card: runningCard, phase, touchSet: myTouchSet || { files: [], dirs: [] }, otherClaims, now });
        if (f.record) fences.push(f.record);
        fenceEvents = f.events || [];
        const excl = myTouchSet?.exclusive || [];
        if (coordRepoPath && excl.length) {
          if ((phase === "implement" && effectiveNext !== "implement") || landedTerminal) releaseLeases({ repoPath: coordRepoPath, cardId: runningCard.id });
          else if (phase === "implement") renewLeases({ repoPath: coordRepoPath, card: runningCard, paths: excl, ttlMinutes: coordCfg.leaseTtlMinutes, now });
        }
      }
      // Touch-set growth (Q5): if the operative widened its touch-set during
      // implement, re-register the intent so the outward ledger reflects it.
      if (coordActive && phase === "implement" && myTouchSet && coordRepoPath) {
        const grown = reregisterTouchSetIfGrown({ repoPath: coordRepoPath, card: runningCard, touchSet: myTouchSet, now });
        if (grown.grown) fenceEvents = fenceEvents.concat([{ at: now(), kind: "coordination", message: `Touch-set grew during ${phase} - re-registered (added ${grown.added.join(", ")})` }]);
      }
      // Per-phase runtime/model attribution: stamp the route object + append a
      // "· claude-code/opus (T2-deep)" suffix to the human message when the gateway
      // reported a route for this turn (inert in souls mode).
      const { route: routeObj, suffix: routeSuffix } = routeStamp(routeMeta, phase);
      let events = withEvent(runningCard, {
        at: now(),
        kind: "routed",
        message: `${listTitle} → ${getList(board, effectiveNext)?.title || effectiveNext}${nudged ? " (verdict via follow-up)" : ""}${routeSuffix}`,
        detail: snippet || null,
        ...(routeObj ? { route: routeObj } : {}),
        ...(contextMeta ? { context: contextMeta } : {})
      });
      for (const ev of offEvents) events = withEvent({ events }, ev);
      if (stab) events = withEvent({ events }, stab.event);
      for (const ev of coord?.selfEvents || []) events = withEvent({ events }, ev);
      for (const ev of fenceEvents) events = withEvent({ events }, ev);
      target = {
        ...runningCard,
        list: effectiveNext,
        status: "ok",
        runningSince: null,
        lastReply: snippet,
        lastDispatchError: null,
        ...(stab ? { stabilityAt: stab.stabilityAt } : {}),
        ...(coord ? { planCompletedAt: coord.planCompletedAt } : {}),
        ...(coordActive ? { fences } : {}),
        events
      };
      outcome = { status: "moved", from: card.list, to: effectiveNext, nudged };
      // Terminal cleanup (Q1): a card reaching a terminal list drops its ledger
      // intents + leases so external sessions stop seeing its claims. After save.
      if (coordActive && landedTerminal) {
        terminalIntentRemoval = { repoPath: coordRepoPath, cardId: runningCard.id };
      }
    }
  } else if (gateEvidenceMissing) {
    const geReason = `${listTitle} chose a next step but left NO durable gate evidence for the ${phase} phase under ${runningCard.runDir} (no gates entry in a gate-status.json). Phase progression requires the durable gate record in addition to the verdict (D9) — parked rather than advancing on the operative's word alone. Re-run so the phase skill writes its gate-status entry.`;
    target = {
      ...runningCard,
      ...parkFields(runningCard, card.list, geReason),
      runningSince: null,
      lastReply: snippet,
      lastDispatchError: null,
      events: withEvent(runningCard, {
        at: now(),
        kind: "parked",
        message: `Parked from ${listTitle}: no durable gate evidence for ${phase}`,
        detail: geReason
      })
    };
    outcome = { status: "needs-attention", reason: "no-gate-evidence", validNext };
  } else if (evidenceMissing) {
    const evReason = `${listTitle} reported success but left NO evidence under ${runningCard.runDir}/evidence/ — no screenshot or evidence.md was actually produced, so there is no proof the change works. Parked rather than advancing on the operative's word alone. Move it back to re-run and produce the evidence.`;
    target = {
      ...runningCard,
      ...parkFields(runningCard, card.list, evReason),
      runningSince: null,
      lastReply: snippet,
      lastDispatchError: null,
      events: withEvent(runningCard, {
        at: now(),
        kind: "parked",
        message: `Parked from ${listTitle}: no evidence produced`,
        detail: evReason + (replyText ? `\n\nOperative replied:\n${replyText}` : "")
      })
    };
    outcome = { status: "needs-attention", reason: "no-evidence", validNext };
  } else if (!replyText) {
    // EMPTY OUTPUT = FAILURE (D19). The grace window above already gave a genuinely
    // -succeeding run time to land its gate evidence; reaching here means none did.
    // Park with the failure contract: never claims success, carries a log-tail
    // evidence excerpt, and marks the card for a context-keeping retry.
    const logTail = readLogTail(root, card.id, iteration);
    const emptyReason = buildEmptyFailureReason({ listTitle, phase, grace: emptyGraceResult, logTail });
    target = {
      ...runningCard,
      ...parkFields(runningCard, card.list, emptyReason),
      runningSince: null,
      lastReply: "",
      lastDispatchError: null,
      // D19: signal a context-keeping retry — when this card is un-parked, the
      // server's recovery handler (server.mjs handlePatchCard) reads this flag,
      // preserves the phase runDir + its iteration logs across the un-park, and
      // clears the flag. The iteration counter still resets (re-cap avoidance);
      // context lives in the preserved runDir.
      retryKeepsContext: true,
      events: withEvent(runningCard, {
        at: now(),
        kind: "parked",
        message: `Parked from ${listTitle}: the operative returned no output (empty is a failure, not a pass)`,
        detail: emptyReason
      })
    };
    outcome = { status: "needs-attention", reason: "empty-reply", validNext };
  } else {
    const noMatchReason = `${listTitle} ran but didn't choose a next step (it needed to end with one of: ${expected}). The operative said: “${snippet}” — open the log for the full reply, then move it back to retry.`;
    target = {
      ...runningCard,
      ...parkFields(runningCard, card.list, noMatchReason),
      runningSince: null,
      lastReply: snippet,
      lastDispatchError: null,
      events: withEvent(runningCard, {
        at: now(),
        kind: "parked",
        message: `Parked from ${listTitle}: no valid next step chosen`,
        detail: `Expected one of: ${expected}\n\nOperative replied:\n${replyText}`
      })
    };
    outcome = { status: "needs-attention", reason: "no-exact-match", validNext };
  }
  const res = await saveCardCAS(root, target, runRev, now());
  if (!res.ok) return { card: res.card, outcome: { status: "needs-attention", reason: "conflict-during-run" } };
  // WS2 duty summary (D6): on a genuine advance the engine writes its own per-duty
  // rollup under the run dir (best-effort; skips when runDir is null).
  if (outcome?.status === "moved") {
    writeDutySummary(cwd, {
      card: res.card ?? runningCard,
      phase,
      listFrom: card.list,
      listTo: outcome.to,
      summary: replyText,
      logRef: `log:${iteration}`,
      gateSummary: readGateSummary(cwd, runningCard.runDir, phase, runningCard.sliceId),
      context: contextMeta,
      now
    });
  }
  // S1b duty boundary: the duty just completed and advanced — ask the gateway to
  // compact if needed (holds discharge here). After the CAS so the advance is
  // committed; best-effort so it never affects the outcome.
  await fireDutyBoundary(onDutyBoundary, res.card ?? runningCard, phase, outcome);
  // Cross-card coordination side-writes, only after our own save committed.
  for (const bw of blockerWrites) {
    await applyBlockerWrite(root, bw, now);
  }
  if (terminalIntentRemoval) {
    try { removeCardIntents(terminalIntentRemoval); } catch { /* ledger cleanup best-effort */ }
    if (terminalIntentRemoval.repoPath) { try { releaseLeases(terminalIntentRemoval); } catch { /* best-effort */ } }
  }
  // Mail (Q9) after save, so a mail event write can't conflict with our own CAS.
  if (coordActive && mails.length && coordAllCards) {
    const byId = new Map(coordAllCards.map((c) => [c.id, c]));
    for (const m of mails) {
      const toCard = byId.get(m.toCardId);
      if (toCard) await sendCoordMail({ root, fromCard: res.card, toCard, subject: m.subject, body: m.body, repoPath: coordRepoPath, now });
    }
  }
  return { card: res.card, outcome };
}

// Run a card through CONSECUTIVE immediate agent lists in one go — the "automated
// flow". After each successful transition, if the card landed on another immediate
// agent list (not interactive, not scheduler-beat, not manual/terminal) it dispatches
// again, so a card flows Plan → Implement → Review → … automatically without waiting
// for a Start press or the next scheduler tick. Stops when it lands on a manual /
// interactive / scheduler-beat list, parks, or hits a safety guard. onChunk is passed
// through to each turn's live log. The chain is fire-and-forget from the caller.
// A card acquired as status:"running" whose dispatch died WITH this process
// (server restart / crash mid-processChain) has nobody left to finish or revert
// it — it would sit "running" forever: timer counting up, Run button hidden,
// Watch tailing a log that will never grow. Swept at board-server boot: clear
// the running state, KEEP the consumed iteration (a dispatch really happened),
// and mark a retryable dispatch error so the UI offers Retry.
export async function recoverInterruptedRuns(root, now = () => new Date().toISOString()) {
  const cards = await loadAllCards(root);
  const recovered = [];
  for (const card of cards) {
    if (card.status !== "running") continue;
    const res = await updateCardCAS(root, card.id, (c) => {
      if (c.status !== "running") return null; // raced: someone else already cleared it
      return {
        ...c,
        status: "ok",
        runningSince: null,
        lastDispatchError: {
          at: now(),
          reason: "interrupted",
          listId: c.list,
          message: "The board server restarted while this run was in flight; the dispatch was lost. Run again to retry."
        },
        events: withEvent(c, {
          at: now(),
          kind: "recovered",
          message: "Run interrupted by a board restart — cleared the stale running state (Run to retry)"
        })
      };
    });
    if (res) recovered.push(card.id);
  }
  return recovered;
}

export async function processChain({ root, board, card, runFn, cap = 10, now = () => new Date().toISOString(), cwd = process.cwd(), onDutyBoundary = undefined }) {
  let current = card;
  let lastOutcome = { status: "skipped", reason: "noop" };
  for (let hops = 0; hops < 50; hops++) {
    // onDutyBoundary is threaded into each hop's processCard, which fires it on a
    // genuine advance — so every processChain hop already covers the duty boundary
    // (no separate between-hop call needed; the controller's cooldown would skip a
    // duplicate anyway).
    const { card: c, outcome } = await processCard({ root, board, card: current, runFn, cap, now, cwd, onDutyBoundary });
    current = c;
    lastOutcome = outcome;
    if (outcome.status !== "moved") break; // parked, skipped, deferred, conflict → stop
    const landed = getList(board, current.list);
    if (!landed || landed.kind !== AGENT_KIND) break; // manual / terminal column → stop
    if (isInteractive(landed)) break; // interactive (Discuss) → human takes over
    if (triggerFor(landed) !== "immediate") break; // scheduler-beat (Test) → its own beat
    // else: another immediate agent list → keep running the flow.
  }
  return { card: current, outcome: lastOutcome };
}

// ── In-process run driving (D13 — the garrison doorway) ────────────────────
//
// The engine is a LIBRARY: a session that is itself doing the work (the thin
// garrison doorway) advances its card through phases WITHOUT the board's tick
// dispatching a gateway turn. The session does a phase's work, writes the
// phase's gate-status entry under the card's runDir, then calls
// advanceCardPhase — which enforces the SAME contract as the dispatched path:
// the verdict must be a valid next list, the phase's durable gate evidence
// must exist (D9), and the card's rail fast-forwards over OFF phases (D17).
// The board stays the window on the run whether it started from chat, the
// board, or the skill.
export async function advanceCardPhase({ root, board, card, verdict, now = () => new Date().toISOString(), cwd = process.cwd(), onDutyBoundary = undefined }) {
  const list = getList(board, card.list);
  if (!list || list.kind !== AGENT_KIND) {
    return { card, outcome: { status: "skipped", reason: "not-an-agent-list" } };
  }
  const listTitle = list.title || card.list;
  const policy = loadPolicy();
  const phase = phaseForList(list);
  // D15 (S4a): the in-session driver validates the verdict against the CARD's
  // resolved sequence (forward step + gate fail-edge), falling back to the
  // board's static validNext for a legacy card with no duty/level/sequence.
  const resolvedModel = loadResolvedModel(root);
  const validNext = validNextForCard(card, phase, resolvedModel) ?? validNextFor(board, card.list);
  if (!validNext.includes(verdict)) {
    return { card, outcome: { status: "rejected", reason: "invalid-verdict", validNext } };
  }
  const coordCfg = coordinationConfig(policy);
  const coordActive = Boolean(policy && policy.coordination) && coordCfg.enabled && coordinationAvailability().ok;
  // Fail SAFE on a CORRUPT policy (rev2-s567 S5#1): a real run whose policy can't
  // be parsed must park, not advance ungated (a null policy skips the D9 check).
  // ABSENT policy stays the deliberate policy-less mode.
  if (card.runDir && !policy && policyLoadState() === "corrupt") {
    const cpReason = `In-session advance from ${listTitle} refused: the compiled policy at ~/.garrison/orchestrator/policy.json exists but is unreadable — cannot verify the phase-gate contract. Recompile it (edit + save in the composer) before advancing.`;
    const res = await saveCardCAS(root, {
      ...card,
      ...parkFields(card, card.list, cpReason),
      events: withEvent(card, { at: now(), kind: "parked", message: `Parked from ${listTitle}: policy unreadable`, detail: cpReason })
    }, card.rev ?? 0, now());
    if (!res.ok) return { card: res.card ?? card, outcome: { status: "skipped", reason: "conflict" } };
    return { card: res.card, outcome: { status: "needs-attention", reason: "policy-corrupt" } };
  }
  const pipelinePhase = policy && Array.isArray(policy.phases) && policy.phases.includes(phase);
  if (pipelinePhase && card.runDir && !hasPhaseGateEvidence(cwd, card.runDir, phase)) {
    const geReason = `In-session advance from ${listTitle} refused: no durable gate evidence for the ${phase} phase under ${card.runDir}. Write the phase's gate-status entry first (the bindable-skill contract).`;
    const res = await saveCardCAS(root, {
      ...card,
      ...parkFields(card, card.list, geReason),
      events: withEvent(card, { at: now(), kind: "parked", message: `Parked from ${listTitle}: no durable gate evidence for ${phase}`, detail: geReason })
    }, card.rev ?? 0, now());
    if (!res.ok) return { card: res.card ?? card, outcome: { status: "skipped", reason: "conflict" } };
    return { card: res.card, outcome: { status: "needs-attention", reason: "no-gate-evidence" } };
  }
  // requiresEvidence (walkthrough bundle) — the SAME check the dispatched path
  // enforces (rev-s4 finding #2: this path used to skip it).
  if (list.requiresEvidence && !hasEvidence(cwd, card.runDir)) {
    const evReason = `In-session advance from ${listTitle} refused: no tangible evidence under ${card.runDir}/evidence/ (a screenshot or evidence.md). Produce the evidence bundle first.`;
    const res = await saveCardCAS(root, {
      ...card,
      ...parkFields(card, card.list, evReason),
      events: withEvent(card, { at: now(), kind: "parked", message: `Parked from ${listTitle}: no evidence produced (in-session)`, detail: evReason })
    }, card.rev ?? 0, now());
    if (!res.ok) return { card: res.card ?? card, outcome: { status: "skipped", reason: "conflict" } };
    return { card: res.card, outcome: { status: "needs-attention", reason: "no-evidence" } };
  }
  const rail = railForCard(policy, card);
  let effectiveNext = verdict;
  let offEvents = [];
  if (rail) {
    const fwd = effectiveListForCard(board, rail, verdict, card, resolvedModel);
    if (fwd.listId !== verdict) {
      effectiveNext = fwd.listId;
      offEvents = fwd.skipped.map((ph) => ({
        at: now(),
        kind: "phase-off",
        message: `Phase ${ph} is OFF for this card (${rail.workKind || "work kind"}) — recorded off, not run`
      }));
    }
  }
  // Stability + coordination — the SAME contract as the dispatched path
  // (processCard): plan-completion ordering, breakage attribution on the gate fail
  // edge, and commit fences on a genuine advance, so an in-session run coordinates
  // identically to a gateway-dispatched one.
  const stab = stabilityFields(card, phase, effectiveNext, now);
  let coordAllCards = null;
  let coordRepoPath = null;
  if (coordActive) {
    coordAllCards = await loadAllCards(root);
    coordRepoPath = repoPathForProject(card.project, board);
  }
  const liveCards = coordActive ? liveSameProjectCards(coordAllCards, card, board) : [];
  const myTouchSet = coordActive ? readTouchSet(card.runDir) : null;

  let coord = null;
  if (coordActive && phase === "plan") {
    coord = applyPlanCompletionCoordination({ board, card, allCards: coordAllCards, policy, nextList: effectiveNext, now });
  }
  let interference = null;
  if (coordActive && !coord && effectiveNext === "implement" && GATE_PHASES.has(phase) && liveCards.length) {
    const attr = attributeBreakage({ repoPath: coordRepoPath, victimCard: card, victimTouchSet: myTouchSet, liveCards });
    if (attr.verdict === "foreign" && attr.offenderCardId) {
      const offender = liveCards.find((c) => c.id === attr.offenderCardId);
      if (offender) {
        const offenderFenceSha = Array.isArray(offender.fences) && offender.fences.length ? offender.fences[offender.fences.length - 1].sha : null;
        const reason = `broken by card ${offender.id} (${offender.title || "untitled"}) - commits ${attr.commits.map((s) => s.slice(0, 10)).join(", ")} touching ${attr.overlapFiles.join(", ")}`;
        const refunded = Math.max(0, (card.iterations || 0) - 1);
        interference = {
          waitingOn: { cardId: offender.id, cardTitle: offender.title || null, grade: "interference", reason, until: "fence", offenderFenceSha, rerun: true, thenTo: card.list, since: now() },
          refunded,
          selfEvent: { at: now(), kind: "interference", message: `Interference: ${listTitle} failed due to card ${offender.title || "untitled"} (${String(offender.id).slice(-6)})'s commits - waiting for its fix (in-session)`, detail: reason },
          blockerWrites: [{ cardId: offender.id, addBlocking: card.id, event: { at: now(), kind: "interference", message: `Your commits broke card ${card.id} (${card.title || "untitled"}) at ${phase}`, detail: `${attr.overlapFiles.join(", ")} - it is waiting for your next fence (fix).` } }],
          mails: [{ toCardId: offender.id, subject: `Interference: you broke ${card.id} at ${phase}`, body: reason }]
        };
      }
    }
  }
  let blockerWrites = coord?.blockerWrites || [];
  let mails = coord?.mails ? coord.mails.slice() : [];

  let target;
  let outcome;
  let terminalIntentRemoval = null;
  if (coord && coord.kind === "park") {
    target = {
      ...card,
      ...parkFields(card, card.list, coord.reason),
      runningSince: null,
      planCompletedAt: coord.planCompletedAt,
      events: withEvent(card, {
        at: now(),
        kind: "parked",
        message: `Parked from ${listTitle}: no valid touch-set for coordination (in-session)`,
        detail: coord.reason
      })
    };
    outcome = { status: "needs-attention", reason: "no-touch-set" };
  } else if (coord && coord.kind === "wait") {
    let events = card.events ? card.events.slice() : [];
    for (const ev of coord.selfEvents || []) events = withEvent({ events }, ev);
    target = {
      ...card,
      status: "ok",
      runningSince: null,
      planCompletedAt: coord.planCompletedAt,
      waitingOn: coord.waitingOn,
      events
    };
    outcome = { status: "waiting", from: card.list, waitingOn: coord.waitingOn };
  } else if (interference) {
    blockerWrites = interference.blockerWrites;
    mails = mails.concat(interference.mails);
    target = {
      ...card,
      status: "ok",
      runningSince: null,
      iterations: interference.refunded,
      waitingOn: interference.waitingOn,
      events: withEvent(card, interference.selfEvent)
    };
    outcome = { status: "waiting", from: card.list, reason: "interference", waitingOn: interference.waitingOn };
  } else {
    let fences = Array.isArray(card.fences) ? card.fences.slice() : [];
    let fenceEvents = [];
    const landed = getList(board, effectiveNext);
    const landedTerminal = Boolean(landed?.terminal || effectiveNext === "done");
    if (coordActive && coordCfg.fences?.enabled && card.runDir) {
      const otherClaims = liveCards.map((c) => readTouchSet(c.runDir)).filter(Boolean);
      const f = commitFence({ repoPath: coordRepoPath, card, phase, touchSet: myTouchSet || { files: [], dirs: [] }, otherClaims, now });
      if (f.record) fences.push(f.record);
      fenceEvents = f.events || [];
      const excl = myTouchSet?.exclusive || [];
      if (coordRepoPath && excl.length) {
        if ((phase === "implement" && effectiveNext !== "implement") || landedTerminal) releaseLeases({ repoPath: coordRepoPath, cardId: card.id });
        else if (phase === "implement") renewLeases({ repoPath: coordRepoPath, card, paths: excl, ttlMinutes: coordCfg.leaseTtlMinutes, now });
      }
    }
    if (coordActive && phase === "implement" && myTouchSet && coordRepoPath) {
      const grown = reregisterTouchSetIfGrown({ repoPath: coordRepoPath, card, touchSet: myTouchSet, now });
      if (grown.grown) fenceEvents = fenceEvents.concat([{ at: now(), kind: "coordination", message: `Touch-set grew during ${phase} - re-registered (added ${grown.added.join(", ")})` }]);
    }
    let events = withEvent(card, {
      at: now(),
      kind: "routed",
      message: `${listTitle} → ${getList(board, effectiveNext)?.title || effectiveNext} (in-session)`,
    });
    for (const ev of offEvents) events = withEvent({ events }, ev);
    if (stab) events = withEvent({ events }, stab.event);
    for (const ev of coord?.selfEvents || []) events = withEvent({ events }, ev);
    for (const ev of fenceEvents) events = withEvent({ events }, ev);
    target = {
      ...card,
      list: effectiveNext,
      status: "ok",
      runningSince: null,
      ...(stab ? { stabilityAt: stab.stabilityAt } : {}),
      ...(coord ? { planCompletedAt: coord.planCompletedAt } : {}),
      ...(coordActive ? { fences } : {}),
      events
    };
    outcome = { status: "moved", from: card.list, to: effectiveNext };
    if (coordActive && landedTerminal) {
      terminalIntentRemoval = { repoPath: coordRepoPath, cardId: card.id };
    }
  }
  const res = await saveCardCAS(root, target, card.rev ?? 0, now());
  if (!res.ok) return { card: res.card, outcome: { status: "skipped", reason: "conflict" } };
  // WS2 duty summary parity: the in-session driver has no fresh reply/context, so the
  // summary falls back to the card's lastReply and the log ref to its last iteration.
  if (outcome?.status === "moved") {
    writeDutySummary(cwd, {
      card: res.card ?? card,
      phase,
      listFrom: card.list,
      listTo: outcome.to,
      summary: typeof card.lastReply === "string" ? card.lastReply : null,
      logRef: card.iterations ? `log:${card.iterations}` : null,
      gateSummary: readGateSummary(cwd, card.runDir, phase, card.sliceId),
      context: null,
      now
    });
  }
  // S1b duty boundary parity with the dispatched path — after the CAS commit.
  await fireDutyBoundary(onDutyBoundary, res.card ?? card, phase, outcome);
  for (const bw of blockerWrites) {
    await applyBlockerWrite(root, bw, now);
  }
  if (terminalIntentRemoval) {
    try { removeCardIntents(terminalIntentRemoval); } catch { /* best-effort */ }
    if (terminalIntentRemoval.repoPath) { try { releaseLeases(terminalIntentRemoval); } catch { /* best-effort */ } }
  }
  if (coordActive && mails.length && coordAllCards) {
    const byId = new Map(coordAllCards.map((c) => [c.id, c]));
    for (const m of mails) {
      const toCard = byId.get(m.toCardId);
      if (toCard) await sendCoordMail({ root, fromCard: res.card, toCard, subject: m.subject, body: m.body, repoPath: coordRepoPath, now });
    }
  }
  return { card: res.card, outcome };
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
    if (c.waitingOn) continue; // deferred behind an overlapping run (coordination)
    const key = c.project || "(no-project)";
    (byProject[key] ??= []).push(c);
  }
  return byProject;
}

// Escape a string for use as a literal inside a RegExp.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The FIRST of `validNext`'s ids to appear (as a whole word) in `text`, or null. Whole
// word = bounded by a non-[A-Za-z0-9-] char or the string edge, so "test" does NOT match
// inside "adversarial-test" (hyphen is part of the token). Used to read a card's verdict
// out of the text right AFTER its id, tolerating prose/badges/separators between.
function firstValidNextIn(text, validNext) {
  let best = null;
  let bestPos = Infinity;
  for (const vn of validNext) {
    const m = text.match(new RegExp(`(?:^|[^A-Za-z0-9-])${escapeRegExp(vn)}(?:[^A-Za-z0-9-]|$)`));
    if (m && m.index < bestPos) { bestPos = m.index; best = vn; }
  }
  return best;
}

// Parse the per-card verdict from a batch reply. The batch session is asked to emit, per
// card, `<cardId> <next-list-id>`. EXACT-match the chosen id against THAT card's validNext
// (a card with no/invalid verdict gets null → the caller loops it to implement / parks it).
// Robust to the SAME reflow problem as parseNextList: the verdict "<cardId> adversarial-test"
// routinely arrives flowed onto a line with prose + gateway badges
// ("… Gate green. [route: …] [orchestrator-active] <cardId> adversarial-test"), so we can't
// require it on its own line. Strip badge spans, then for each card find its id (LAST
// occurrence — the verdict comes after the work) and take the first valid-next token that
// follows it. Still exact-match, no guessing.
export function parseBatchVerdicts(reply, cards, board, model = null) {
  const text = typeof reply === "string" ? reply : reply?.reply ?? reply?.text ?? "";
  const cleaned = String(text).replace(/\[[^\]\n]*\]/g, " ");
  const verdicts = {};
  for (const c of cards) {
    // D15 (S4a): match each card's verdict against ITS resolved (duty, level)
    // sequence (validNextForCard — the forward step + gate fail-edge), NOT the
    // board's column order. A legacy card (no sequence) falls back to the board's
    // static validNext, so nothing changes for a card that carries no duty.
    const phase = phaseForList(getList(board, c.list));
    const validNext = validNextForCard(c, phase, model) ?? validNextFor(board, c.list);
    verdicts[c.id] = null;
    const idx = cleaned.lastIndexOf(c.id);
    if (idx === -1) continue;
    // Look only at the text after this card's id, so a verdict token belonging to ANOTHER
    // card (earlier in the reply) can't be mis-attributed to this one.
    verdicts[c.id] = firstValidNextIn(cleaned.slice(idx + c.id.length), validNext);
  }
  return verdicts;
}

// Run ONE batched session per project for a list (Test). batchRunFn is handed the
// project's cards + the combined batch prompt and returns ONE reply naming a verdict
// per card. Each card is then moved per its own verdict (CAS-safe, runId minted if it
// is the card's first agent-list entry): a valid verdict moves it forward; a missing /
// non-matching verdict, or an iteration-cap breach, loops it to `implement` (the fail
// edge) or parks it in needs-attention if implement is not a valid next.
export async function processBatch({ root, board, listId, cards, batchRunFn, cap = 10, now = () => new Date().toISOString(), cwd = process.cwd(), emptyGrace = {}, model = undefined }) {
  const grace = resolveEmptyGrace(emptyGrace);
  const list = getList(board, listId);
  if (!list || list.kind !== AGENT_KIND) {
    return { outcomes: [], reason: "not-an-agent-list" };
  }
  const listTitle = list.title || listId;
  // D15 (S4a): each card advances along ITS resolved (duty, level) sequence, not
  // the board's static column order. Read the resolved model once (injectable by
  // tests; absent → null → legacy board-order behaviour) and derive valid-next
  // PER CARD below. The board-level validNext stays the legacy fallback + the
  // union base for the generic nudge/park hints.
  const resolvedModel = model !== undefined ? model : loadResolvedModel(root);
  const validNext = validNextFor(board, listId);
  const groups = groupCardsByProject(cards, listId);
  const outcomes = [];
  // Coordination context for the batch (D7 red-path): attribution + fences run
  // per-card. Loaded once; liveCards/repoPath resolved per card below.
  const batchPolicy = loadPolicy();
  const batchCoordCfg = coordinationConfig(batchPolicy);
  const batchCoordActive = Boolean(batchPolicy && batchPolicy.coordination) && batchCoordCfg.enabled && coordinationAvailability().ok;
  const batchAllCards = batchCoordActive ? await loadAllCards(root) : null;
  for (const [project, projectCards] of Object.entries(groups)) {
    if (projectCards.length === 0) continue;
    // Acquire every card in the group (CAS the running write + mint run fields). A card
    // that fails the CAS (concurrent tick / manual edit) drops out of the batch. A card
    // already at the cap parks without running. Each write carries the SAME honest
    // reason + timeline events as the per-card path (processCard), so a card parked by
    // the batch path is just as legible — it MOVES to the needs-attention column with a
    // readable reason, not just a status flag stranded on the Test list.
    const acquired = [];
    for (const card of projectCards) {
      const baseRev = card.rev ?? 0;
      if ((card.iterations || 0) >= cap) {
        const capReason = `Hit the iteration cap on ${listTitle} (${cap} runs without converging). Parked so it stops looping — move it back to retry.`;
        const res = await saveCardCAS(root, {
          ...card,
          ...parkFields(card, listId, capReason),
          events: withEvent(card, { at: now(), kind: "parked", message: `Parked from ${listTitle}: iteration cap (${cap})`, detail: capReason })
        }, baseRev, now());
        outcomes.push({ id: card.id, status: "needs-attention", reason: "iteration-cap", project });
        continue;
      }
      const minted = mintRunFields(card, () => Date.parse(now()) || Date.now());
      const iteration = (card.iterations || 0) + 1;
      const acq = await saveCardCAS(root, {
        ...card,
        ...(minted || {}),
        status: "running",
        iterations: iteration,
        runningSince: now(),
        events: withEvent(card, { at: now(), kind: "dispatch", message: `Dispatched to the operative on ${listTitle} (batched: ${project}) — run ${iteration}`, detail: null })
      }, baseRev, now());
      if (!acq.ok) { outcomes.push({ id: card.id, status: "skipped", reason: "conflict", project }); continue; }
      acquired.push({ original: card, running: acq.card, iteration });
    }
    if (acquired.length === 0) continue;

    const runningCards = acquired.map((a) => a.running);
    // D15: same policy-derived classification as processCard — the batched
    // Test beat resolves its skill/model/effort from the compiled policy like
    // every other phase. Tier: the group's first card's tier (a batch shares
    // one session; per-card tier divergence is not worth a session each).
    const policy = loadPolicy();
    const phase = phaseForList(list);
    // The generic hint tokens for the nudge prompt: the UNION of every card's own
    // valid-next (its resolved sequence, D15) plus the board's static validNext, so
    // a sequence-ended card's real option (e.g. `done`) is never omitted from the
    // hint the operative is given.
    const batchValidNextUnion = [...new Set([
      ...validNext,
      ...runningCards.flatMap((c) => validNextForCard(c, phase, resolvedModel) ?? [])
    ])];
    const classification = classificationForPhase(policy, phase, runningCards[0]);
    const skill = skillForPhase(policy, phase, runningCards[0]?.workKind || policy?.defaultWorkKind);
    let out;
    try {
      out = await batchRunFn({ project, cards: runningCards, list, classification, skill, suppressContinuations: true });
    } catch (err) {
      if (err?.transport) {
        // A TRANSPORT failure (gateway down/restarting, stream dropped) is not
        // the cards' fault — REVERT every acquire (status + iteration restored)
        // so the batch retries on the next beat/Run, exactly like processCard's
        // per-card defer. Parking here stranded a whole project group whenever
        // the gateway hiccupped.
        for (const a of acquired) {
          const res = await saveCardCAS(root, {
            ...a.running,
            status: a.original.status ?? "ok",
            iterations: a.original.iterations || 0,
            runningSince: null,
            lastDispatchError: {
              at: now(),
              reason: "gateway-unavailable",
              listId,
              message: String(err?.message || err)
            },
            events: withEvent(a.running, {
              at: now(),
              kind: "deferred",
              message: `Gateway unavailable on ${listTitle} (batched) — left in place, will retry`,
              detail: String(err?.message || err)
            })
          }, a.running.rev, now());
          await appendCardLog(root, a.original.id, a.iteration, `# iteration ${a.iteration} (batch:${project})\ngateway unavailable (deferred, will retry): ${err?.message || err}\n`);
          outcomes.push({ id: a.original.id, status: "deferred", reason: "gateway-unavailable", error: String(err?.message || err), project });
        }
        continue;
      }
      // A real (non-transport) batch failure — park every acquired card with the reason.
      for (const a of acquired) {
        const failReason = `The ${listTitle} batch run for ${project} errored: ${String(err?.message || err)}. Parked — open the log, then move it back to retry.`;
        const res = await saveCardCAS(root, {
          ...a.running,
          ...parkFields(a.running, listId, failReason),
          runningSince: null,
          lastReply: replySnippet(String(err?.message || err)),
          events: withEvent(a.running, { at: now(), kind: "failed", message: `Batch run errored on ${listTitle}`, detail: String(err?.message || err) })
        }, a.running.rev, now());
        await appendCardLog(root, a.original.id, a.iteration, `# iteration ${a.iteration} (batch:${project})\nbatch run failed: ${err?.message || err}\n`);
        outcomes.push({ id: a.original.id, status: "needs-attention", reason: "run-failed", error: String(err?.message || err), project });
      }
      continue;
    }

    let reply = out?.reply ?? out?.text ?? String(out ?? "");
    let verdicts = parseBatchVerdicts(reply, runningCards, board, resolvedModel);
    // VERDICT NUDGE (same backstop as processCard). A batch turn that did the
    // work but ended narrating — or returned an empty screen-scrape — leaves
    // ZERO verdict lines and would park the whole group. One bounded follow-up
    // asks for nothing but the verdict lines, in the same session.
    if (!Object.values(verdicts).some(Boolean)) {
      try {
        const nudgePrompt =
          `Your previous reply did not include the required per-card verdict lines, so the workflow can't advance. ` +
          `Based ONLY on the batched test work you just completed, reply with NOTHING but one verdict line per card, ` +
          `each EXACTLY in the form \`<cardId> <next-list>\` where <next-list> is one of: ${batchValidNextUnion.join(", ")}. The cards: ` +
          runningCards.map((c) => c.id).join(", ") + ".";
        const nout = await batchRunFn({ project, cards: runningCards, list, classification, skill, suppressContinuations: true, nudge: nudgePrompt });
        const nudgeReply = nout?.reply ?? nout?.text ?? String(nout ?? "");
        const nudged = parseBatchVerdicts(nudgeReply, runningCards, board, resolvedModel);
        if (Object.values(nudged).some(Boolean)) {
          verdicts = nudged;
          if (!reply.trim()) reply = nudgeReply;
        }
      } catch {
        // Nudge failed — fall through and handle with the original (empty) verdicts.
      }
    }
    const snippet = replySnippet(reply);
    for (const a of acquired) {
      let next = verdicts[a.original.id];
      // D15 (S4a): this card's OWN valid-next (its resolved sequence) — the gate
      // poll must accept the card's real next step (e.g. `done` at a sequence end),
      // not the board's column order; a legacy card falls back to the board's set.
      const cardValidNext = validNextForCard(a.running, phase, resolvedModel) ?? validNext;
      const cardExpected = cardValidNext.join(", ");
      await appendCardLog(root, a.original.id, a.iteration, `# iteration ${a.iteration} (batch:${project})\nverdict: ${next ?? "(none)"}\n${reply}\n`);
      const pipelinePhase = policy && Array.isArray(policy.phases) && policy.phases.includes(phase);
      // RACE FIX (D19, assumption 2) — mirror of processCard. An EMPTY batch reply
      // may be a premature `done`; before parking THIS card for "no output", poll
      // its gate file over the grace window. A landed gate that names a next step
      // advances it exactly as a verdict line would.
      let batchGrace = null;
      if (!next && !reply.trim() && a.running.runDir && pipelinePhase) {
        batchGrace = await pollForGateEvidence({ cwd, runDir: a.running.runDir, phase, validNext: cardValidNext, ...grace });
        if (batchGrace.next) {
          next = batchGrace.next;
          await appendCardLog(root, a.original.id, a.iteration, `\n_(empty batch reply — gate evidence landed after ${batchGrace.waited} grace check(s): ${next})_\n`);
        }
      }
      // DURABLE GATE EVIDENCE (D9) — the batch path enforces the SAME check as
      // processCard: a verdict without the phase's gate-status entry in the
      // card's runDir parks (rev-s4 finding #1: this path used to bypass it).
      let gateEvidenceMissing = false;
      if (next && pipelinePhase && a.running.runDir && !hasPhaseGateEvidence(cwd, a.running.runDir, phase)) {
        next = null;
        gateEvidenceMissing = true;
      }
      let target;
      let batchBlockerWrites = [];
      let batchMails = [];
      let batchInterferenceWait = false;
      if (next) {
        // D17 rail fast-forward — same as processCard's post-verdict handling
        // (rev-s4 finding #3: the batch path used to skip it).
        const rail = railForCard(policy, a.running);
        let effectiveNext = next;
        let offEvents = [];
        if (rail) {
          const fwd = effectiveListForCard(board, rail, next, a.running, resolvedModel);
          if (fwd.listId !== next) {
            effectiveNext = fwd.listId;
            offEvents = fwd.skipped.map((ph) => ({
              at: now(),
              kind: "phase-off",
              message: `Phase ${ph} is OFF for this card (${rail.workKind || "work kind"}) — recorded off, not run`
            }));
          }
        }
        // Coordination context for THIS card.
        const liveCards = batchCoordActive ? liveSameProjectCards(batchAllCards, a.running, board) : [];
        const repoPath = batchCoordActive ? repoPathForProject(a.running.project, board) : null;
        const myTouchSet = batchCoordActive ? readTouchSet(a.running.runDir) : null;
        // (D7) Attribution BEFORE the loop-back: a Test fail edge (-> implement)
        // with other live cards asks "who broke me?" first; a clean FOREIGN verdict
        // makes the card WAIT for the offender's fix instead of looping.
        let interference = null;
        if (batchCoordActive && effectiveNext === "implement" && GATE_PHASES.has(phase) && liveCards.length) {
          const attr = attributeBreakage({ repoPath, victimCard: a.running, victimTouchSet: myTouchSet, liveCards });
          if (attr.verdict === "foreign" && attr.offenderCardId) {
            const offender = liveCards.find((c) => c.id === attr.offenderCardId);
            if (offender) {
              const offenderFenceSha = Array.isArray(offender.fences) && offender.fences.length ? offender.fences[offender.fences.length - 1].sha : null;
              const reason = `broken by card ${offender.id} (${offender.title || "untitled"}) - commits ${attr.commits.map((s) => s.slice(0, 10)).join(", ")} touching ${attr.overlapFiles.join(", ")}`;
              const refunded = Math.max(0, (a.running.iterations || 0) - 1);
              interference = {
                waitingOn: { cardId: offender.id, cardTitle: offender.title || null, grade: "interference", reason, until: "fence", offenderFenceSha, rerun: true, thenTo: a.running.list, since: now() },
                refunded,
                selfEvent: { at: now(), kind: "interference", message: `Interference (batch): ${listTitle} failed due to card ${offender.title || "untitled"} (${String(offender.id).slice(-6)})'s commits - waiting for its fix (iteration refunded to ${refunded})`, detail: reason },
                blockerWrites: [{ cardId: offender.id, addBlocking: a.running.id, event: { at: now(), kind: "interference", message: `Your commits broke card ${a.running.id} (${a.running.title || "untitled"}) at ${phase}`, detail: `${attr.overlapFiles.join(", ")} - it is waiting for your next fence (fix).` } }],
                mails: [{ toCardId: offender.id, subject: `Interference: you broke ${a.running.id} at ${phase}`, body: reason }]
              };
            }
          }
        }
        if (interference) {
          batchInterferenceWait = true;
          batchBlockerWrites = interference.blockerWrites;
          batchMails = interference.mails;
          target = {
            ...a.running,
            status: "ok",
            runningSince: null,
            iterations: interference.refunded,
            lastReply: snippet,
            lastDispatchError: null,
            waitingOn: interference.waitingOn,
            events: withEvent(a.running, interference.selfEvent)
          };
        } else {
          // Per-phase attribution at the batch seam too — one route served the whole
          // batched session, so every card in the group carries the same stamp; the
          // tier falls back to each card's own tier when the gateway omits its echo.
          const { route: routeObj, suffix: routeSuffix } = routeStamp(
            out?.route ? { ...out.route, tier: out.route.tier ?? a.running.tier ?? null } : null,
            phase
          );
          let events = withEvent(a.running, { at: now(), kind: "routed", message: `${listTitle} → ${getList(board, effectiveNext)?.title || effectiveNext}${routeSuffix}`, detail: snippet || null, ...(routeObj ? { route: routeObj } : {}) });
          for (const ev of offEvents) events = withEvent({ events }, ev);
          // Stability point (Q3) at the batch seam too — parity across all three seams.
          const stab = stabilityFields(a.running, phase, effectiveNext, now);
          if (stab) events = withEvent({ events }, stab.event);
          // Commit fence (Q5) on the advance.
          let fences = Array.isArray(a.running.fences) ? a.running.fences.slice() : [];
          if (batchCoordActive && batchCoordCfg.fences?.enabled && a.running.runDir) {
            const otherClaims = liveCards.map((c) => readTouchSet(c.runDir)).filter(Boolean);
            const f = commitFence({ repoPath, card: a.running, phase, touchSet: myTouchSet || { files: [], dirs: [] }, otherClaims, now });
            if (f.record) fences.push(f.record);
            for (const ev of f.events || []) events = withEvent({ events }, ev);
          }
          target = {
            ...a.running,
            list: effectiveNext,
            status: "ok",
            runningSince: null,
            lastReply: snippet,
            lastDispatchError: null,
            ...(stab ? { stabilityAt: stab.stabilityAt } : {}),
            ...(batchCoordActive ? { fences } : {}),
            events
          };
        }
      } else if (gateEvidenceMissing) {
        const geReason = `${listTitle} (batched for ${project}) chose a next step but left NO durable gate evidence for the ${phase} phase under ${a.running.runDir}. Phase progression requires the durable gate record in addition to the verdict (D9) — parked rather than advancing on the operative's word alone.`;
        target = {
          ...a.running,
          ...parkFields(a.running, listId, geReason),
          runningSince: null,
          lastReply: snippet,
          events: withEvent(a.running, { at: now(), kind: "parked", message: `Parked from ${listTitle}: no durable gate evidence for ${phase}`, detail: geReason })
        };
      } else if (!reply.trim()) {
        // EMPTY OUTPUT = FAILURE (D19) — the whole batched turn produced nothing and
        // the grace window found no gate. Park with the SAME failure contract as the
        // per-card path: never claims success, carries a log-tail excerpt, marks the
        // card for a context-keeping retry.
        const logTail = readLogTail(root, a.original.id, a.iteration);
        const emptyReason = buildEmptyFailureReason({ listTitle: `${listTitle} (batched for ${project})`, phase, grace: batchGrace, logTail });
        target = {
          ...a.running,
          ...parkFields(a.running, listId, emptyReason),
          runningSince: null,
          lastReply: "",
          retryKeepsContext: true,
          events: withEvent(a.running, { at: now(), kind: "parked", message: `Parked from ${listTitle}: the operative returned no output (empty is a failure, not a pass)`, detail: emptyReason })
        };
      } else {
        // No verdict line for THIS card in the batch reply — say so plainly (the batch
        // session must emit `<cardId> <next-list>` per card; it didn't for this one).
        const noMatchReason = `${listTitle} ran (batched for ${project}) but returned no valid verdict for this card — it needed a line "${a.original.id} <one of: ${cardExpected}>". The operative said: “${snippet}” — open the log for the full reply, then move it back to retry.`;
        target = {
          ...a.running,
          ...parkFields(a.running, listId, noMatchReason),
          runningSince: null,
          lastReply: snippet,
          events: withEvent(a.running, { at: now(), kind: "parked", message: `Parked from ${listTitle}: no valid verdict in the batch reply`, detail: `Expected: ${a.original.id} <${cardExpected}>\n\nBatch reply:\n${reply}` })
        };
      }
      const res = await saveCardCAS(root, target, a.running.rev, now());
      if (!res.ok) { outcomes.push({ id: a.original.id, status: "needs-attention", reason: "conflict-during-run", project }); continue; }
      // Cross-card side-writes + mail, after this card's own save committed.
      for (const bw of batchBlockerWrites) await applyBlockerWrite(root, bw, now);
      if (batchCoordActive && batchMails.length && batchAllCards) {
        const byId = new Map(batchAllCards.map((c) => [c.id, c]));
        for (const m of batchMails) {
          const toCard = byId.get(m.toCardId);
          if (toCard) await sendCoordMail({ root, fromCard: res.card, toCard, subject: m.subject, body: m.body, repoPath: repoPathForProject(a.running.project, board), now });
        }
      }
      if (gateEvidenceMissing) { outcomes.push({ id: a.original.id, status: "needs-attention", reason: "no-gate-evidence", project }); continue; }
      if (batchInterferenceWait) { outcomes.push({ id: a.original.id, status: "waiting", reason: "interference", project }); continue; }
      if (!next) { outcomes.push({ id: a.original.id, status: "needs-attention", reason: reply.trim() ? "no-exact-match" : "empty-reply", project }); continue; }
      outcomes.push({ id: a.original.id, status: "moved", from: listId, to: target.list, project });
    }
  }
  return { outcomes };
}

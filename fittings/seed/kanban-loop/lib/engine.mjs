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
// gate-status entry parks. The card's flow + per-card phase toggles form
// its RAIL (D17): an OFF phase is skipped with an explicit "off" event
// (recorded and rendered off, never a silent pass). Goal-mode injects an explicit
// acceptance block; the convergence GUARD is the per-card iteration cap.
//
// Per-card runId minted on the FIRST agent-list entry; runDir threaded into
// every execute-prompt as literal text; triggers (immediate | manual |
// scheduler-beat) so tick() only processes immediate agent lists; Test
// batching preserved as list mechanics (batched + its own beat).
import path from "node:path";
import { hostname } from "node:os";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { saveCardCAS, loadAllCards, loadCard, createCard, updateCardCAS, withFileLock, isPidAlive, scheduleHolds } from "./board.mjs";
import { ulid } from "./ulid.mjs";
import { isPersonalCard } from "./personal-workspace.mjs";
import { projectNameForRouting } from "./gateway-client.mjs";


import { isDispatchClaimLive, isDispatchClaimExpired } from "./dispatch-lease.mjs";
import { routeOriginEvent, dutySummaryMessage, routeNeedsInput, routeBrief, routeAutonomyActed, deliverScheduleReminder } from "./notify-origin.mjs";
import {
  normaliseCardSchedule,
  nextCronOccurrence,
  latestCronOccurrence,
  occurrenceKey as scheduleOccurrenceKey,
  zonedMinute
} from "./schedules.mjs";
import { readSteeringMd, readSteeringDirective, markSteeringApplied, isEarlierPhase } from "./steering.mjs";

// Exact v4 identity carried over the gateway wire. A legacy card (or v1 model)
// returns an empty object and keeps the historical policy classification path.
//
// TWO ways a card gets a sequence, and the identity differs between them:
//
//   • THE DUTY LADDER. The card's duty is a COMPOSITE whose expansion at its
//     level IS the sequence (`steps[develop][2]` = one leaf step per phase). The
//     identity on the wire is the composite + the phase, and the gateway picks
//     the leaf step out of that expansion. Unchanged.
//   • THE FLOW LIBRARY. The card's sequence is the flow's duty list, so each
//     phase is a DUTY IN ITS OWN RIGHT, running at the level the flow resolved
//     FOR IT (`card.dutyLevels[phase]`, which a pin or an escalation may put
//     above the card's own level). The card's duty expansion has no entry for a
//     phase that is not itself - a leaf duty expands to one self-step - so
//     resolving through it returns null and the gateway then throws
//     `v4 duty route unresolved` on a card that is perfectly well specified.
//
// So the identity is the DUTY CELL THAT IS ACTUALLY EXECUTING: for the flow case
// that is (phase, its own level). This is the only shape that fits down the wire
// - gateway-client.mjs forwards exactly {duty, level, phase, stepIndex, sequence}
// and a per-phase level has nowhere else to ride - and it is the honest one: the
// gateway's ruleId, its compatibility tier and its decision record all describe
// the cell that ran, which is precisely what a per-duty level changes.
//
// Order matters. An explicit per-duty level is authoritative (it is the resolved
// answer, pins and escalations included) and is tried FIRST; otherwise the card's
// own duty expansion is tried exactly as before, so a card with no dutyLevels
// produces a byte-identical wire identity to the one it produced before this
// existed. `stepIndex` indexes the card's sequence, which only aligns with the
// composite expansion, so the self-step path sends none.
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
// location the Discuss duty is told (an absolute path) to write to. Best-effort +
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

export function runCardScopeLabel(card) {
  const routing = card?.routing && typeof card.routing === "object" && !Array.isArray(card.routing)
    ? card.routing
    : {};
  const explicitProjectPresent = typeof routing.project === "string" && routing.project.trim().length > 0;
  const cardProjectPresent = typeof card?.project === "string" && card.project.trim().length > 0;
  const projectWasSpecified = explicitProjectPresent || cardProjectPresent;
  const project = projectNameForRouting(explicitProjectPresent ? routing.project : card?.project);
  if (project) return runProjectLabel(project);
  // A malformed explicit project is refused by the gateway; do not relabel its
  // evidence as personal when the personal fallback was deliberately suppressed.
  if (projectWasSpecified) return "no-project";
  return isPersonalCard(card) ? "personal" : "no-project";
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

// S3d (D9b): a CLARITY-GATED discuss card IS dispatched even though the Discuss list
// is interactive - the discuss duty runs as a normal agent session (ask 1-3 scoping
// questions, write the brief, advance to plan). The gate marker is card.clarity ===
// "needs-discuss" (stamped by the gateway/API carding); it only applies on the
// interactive Discuss list, so a human-initiated discuss card - no
// marker - stays interactive/manual with zero regression.
export function mintRunFields(card, now = Date.now) {
  if (card.runId && card.runDir) return null; // already minted — idempotent
  const runId = ulid(typeof now === "function" ? now() : now);
  return { runId, runDir: path.join(RUNS_HOME(), runCardScopeLabel(card), runId) };
}

// D15: per-list taskType/tier/skill/mode config is DEAD. Resolution comes from
// the compiled policy: the list's PHASE is the task type (D1) and the tier
// rides on the card — see classificationForPhase in ./policy.mjs. This shim
// remains only for external callers/tests that want the old projection; it now
// derives from the phase, never from per-list pins.
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
// { targetId, runtime, provider, model, effort, effortApplied, tier, phase } — plus a human SUFFIX
// ("· claude-code/opus (T2-deep)") appended to the event message. `phase` is the
// engine's own phase name (always known) so the card-front chip can read "plan @ opus"
// even when the gateway's own taskType echo is null. Returns { route: null, suffix: "" }
// when NO routing metadata flowed (a legacy non-routed turn) — a run must NEVER
// fail, and an event must never grow noise, for want of attribution that isn't there.
export function routeStamp(route, phase = null) {
  if (!route || typeof route !== "object") return { route: null, suffix: "" };
  const targetId = route.targetId ?? null;
  const runtime = route.runtime ?? null;
  const provider = route.provider ?? null;
  const model = route.model ?? null;
  const effort = route.effort ?? null;
  const effortApplied = typeof route.effortApplied === "boolean" ? route.effortApplied : null;
  const tier = route.tier ?? null;
  // Pass-through of the gateway's turnAttribution block (widened alongside
  // routeFromDone): the card is the only durable record of who served a phase, so
  // narrowing the stamp here would re-drop the account / duty / project the gateway
  // just told us. Additive — `suffix` is unchanged (it is asserted verbatim in tests).
  const duty = route.duty ?? null;
  const level = Number.isInteger(route.level) ? route.level : null;
  const skill = route.skill ?? null;
  const via = route.via ?? null;
  const accountSource = route.accountSource ?? null;
  const project = route.project ?? null;
  const overridesApplied = Array.isArray(route.overridesApplied) ? route.overridesApplied : null;
  const overridesRejected = Array.isArray(route.overridesRejected) ? route.overridesRejected : null;
  const hasAccount = "account" in route && route.account !== undefined;
  if (
    targetId == null && runtime == null && provider == null && model == null &&
    effort == null && effortApplied == null && tier == null &&
    duty == null && level == null && skill == null && via == null &&
    accountSource == null && project == null && !hasAccount &&
    overridesApplied == null && overridesRejected == null
  ) {
    return { route: null, suffix: "" };
  }
  const stamp = {
    targetId, runtime, provider, model, effort, effortApplied, tier, phase: phase ?? null,
    duty, level, skill, via, accountSource, project,
    overridesApplied, overridesRejected
  };
  if (hasAccount) stamp.account = route.account ?? null;
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
export function parkFields(card, fromList, reason, eventKind = "blocked") {
  return {
    list: ATTENTION_LIST,
    status: "needs-attention",
    parkedFrom: fromList ?? card.parkedFrom ?? null,
    attentionReason: reason,
    // S3a (D8): the lifecycle kind the saveCardCAS terminal edge routes for this park
    // — "failed" (dispatch error / iteration cap / empty reply) or "blocked" (default:
    // verdict-missing / gate-evidence / requiresEvidence / waiting / infra).
    attentionKind: eventKind === "failed" ? "failed" : "blocked"
  };
}

// An explicit human Start consumes a coordination wait and/or schedule, but only
// in the SAME CAS that acquires the run. Keeping this pure lets the server's
// manual-list advance use the identical event contract while processCard and
// processBatch defer consumption until status:"running" actually commits.
export function consumeStartOverrides(card, at = new Date().toISOString()) {
  let next = { ...card };
  if (card.waitingOn) {
    const w = card.waitingOn;
    next = {
      ...next,
      waitingOn: null,
      events: withEvent(next, {
        at,
        kind: "coordination",
        message: `Wait overridden manually (was waiting on ${w.cardTitle || w.cardId})`,
        detail: w.reason || null
      })
    };
  }
  if (card.scheduledFor) {
    next = {
      ...next,
      scheduledFor: null,
      scheduleAction: null,
      scheduleNotifiedAt: null,
      events: withEvent(next, {
        at,
        kind: "moved",
        message: `Schedule cleared by manual start (was scheduled for ${card.scheduledFor})`
      })
    };
  }
  return next;
}

// Parse the router's chosen next list. Takes the last non-empty line (the
// router-prompt convention is to end with the verdict) and EXACT-matches it against
// the valid next list ids. No match → null (→ needs-attention).
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

// Is a card's stamped run owner a LIVE process that is not us? Guards the boot
// sweep below: a live foreign driver's card must be left alone.
export function ownedByAnotherLiveDriver(card, host = hostname()) {
  const o = card?.runOwner;
  if (!o || typeof o !== "object") return false;
  if (o.host !== host) return false;              // another machine — we cannot tell
  if (!Number.isInteger(o.pid)) return false;
  if (o.pid === process.pid) return false;        // our own previous life: not live
  return isPidAlive(o.pid);
}

export function orphanRunThresholdMs() {
  const turn = Number(process.env.KANBAN_TURN_TIMEOUT_MS) || 25 * 60 * 1000;
  const slack = Number(process.env.KANBAN_ORPHAN_SLACK_MS) || 5 * 60 * 1000;
  return turn + slack;
}

export function isOrphanedRun(card, { at = Date.now(), thresholdMs = orphanRunThresholdMs(), host = hostname() } = {}) {
  // `list` IS the state under the five-state board (coherentCardState mirrors
  // `status` off it), so a wedge shows up as list "running" whatever the status
  // field says. Checking status alone made every release a silent no-op.
  if (!card || (card.list !== "running" && card.status !== "running")) return null;
  // A conversation-linked card is NOT orphaned by a dead driver: its state lives
  // in the conversation store and the tick's kick lane resumes it (the gateway
  // 409s while a stretch is advancing, so kicks are idempotent). Releasing it
  // here would strand work the launcher can pick straight back up — and would
  // race the very kick that is about to recover it.
  if (card.conversationId) return null;
  // A card held by a LIVE dispatch claim is being driven by a worker on another
  // machine, and its heartbeat is far better evidence than anything local. Both
  // fallbacks below are single-machine and would misfire here: the runOwner pid
  // belongs to another host (so isPidAlive is meaningless, and may even match an
  // unrelated local process), and the run-age ceiling would reclaim a remote run
  // that is progressing perfectly well. Expiry of a dispatch claim is handled by
  // sweepExpiredDispatchClaims, which knows about the lease.
  if (isDispatchClaimLive(card, { at })) return null;
  const owner = card.runOwner && typeof card.runOwner === "object" ? card.runOwner : null;
  if (owner && owner.host === host && Number.isInteger(owner.pid)) {
    if (!isPidAlive(owner.pid)) return `its driver (pid ${owner.pid}) is gone`;
    return null; // a live owner is running a legitimately long turn — leave it alone
  }
  // No usable owner stamp (a card acquired before this field existed, or a run
  // driven from another host): fall back to the age of the run.
  const started = Date.parse(card.runningSince || "");
  if (!Number.isFinite(started)) return null;
  if (at - started > thresholdMs) {
    return `it has been running for ${Math.round((at - started) / 60000)} min, past the ${Math.round(thresholdMs / 60000)} min ceiling for a single turn`;
  }
  return null;
}

export async function sweepOrphanedRuns(root, { now = () => new Date().toISOString(), at = () => Date.now() } = {}) {
  const cards = await loadAllCards(root);
  const swept = [];
  for (const card of cards) {
    const why = isOrphanedRun(card, { at: at() });
    if (!why) continue;
    const res = await updateCardCAS(root, card.id, (c) => {
      if (!isOrphanedRun(c, { at: at() })) return null; // raced: cleared, re-driven, or conversation-linked
      // The release MOVES the card to To do. `list` is the state: clearing status
      // while leaving the card on the running list is re-derived straight back to
      // "running" by coherentCardState — the exact wedge this sweep exists to break.
      return {
        ...c,
        list: "todo",
        status: "ok",
        runningSince: null,
        runOwner: null,
        lastDispatchError: {
          at: now(),
          reason: "orphaned",
          listId: c.list,
          message: `The run was lost — ${why}. Nothing finished it, so the card was released to To do. Start it to retry.`
        },
        events: withEvent(c, {
          at: now(),
          kind: "recovered",
          message: `Released a lost run — ${why}`,
          detail: "The driver went away without writing a result. The card was moved to To do; any work its runDir already holds is preserved."
        })
      };
    });
    if (res) swept.push(card.id);
  }
  return swept;
}

// ── Card scheduling: the due-sweep ──────────────────────────────────────────
//
// Runs at the top of every tick (2-min cadence = the schedule's resolution).
// A card whose scheduledFor instant has PASSED gets exactly one action:
//   - scheduleAction "notify" (default): stamp scheduleNotifiedAt + emit a
//     schedule-due event + push the reminder (with the tell-Zeca phrases)
//     through the origin/omi/web chain. The hold has expired, so an
//     agent-list card resumes normal dispatch on this same tick; a manual-
//     list card waits for the human (or a "run card X" told to Zeca).
//   - scheduleAction "run": clear the schedule and, on a manual list, advance
//     into the card's rail (sequence head, else the first non-interactive
//     agent exit) exactly like a human Start - the tick's dispatch loop then
//     picks it up. A card with no agent exit (a manual-only rail) degrades to
//     the notify behaviour: there is nothing to run.
// Unparseable scheduledFor values are left alone - scheduleHolds() already
// holds them (fail closed), and rewriting a value the human typed would hide
// the mistake instead of surfacing it in the UI.
function runTargetForSchedule(board, card, targetList) {
  // Conversations: there are no agent lists to enter. A runnable occurrence
  // lands on To do carrying scheduleAction "run", and the tick kicks its
  // conversation from there — the launcher does the running.
  return getList(board, "todo") ? "todo" : targetList;
}

function occurrenceInput(template, list, key, scheduledAt) {
  return {
    title: template.title,
    description: template.description ?? "",
    project: template.project ?? null,
    scope: template.scope ?? null,
    list,
    goalMode: Boolean(template.goalMode),
    acceptance: template.acceptance ?? null,
    flow: template.flow ?? null,
    phases: template.phases ?? null,
    tier: template.tier ?? null,
    routing: template.routing ?? null,
    origin: "scheduler",
    originChannel: template.originChannel ?? null,
    duty: template.duty ?? null,
    level: template.level ?? null,
    sequence: Array.isArray(template.sequence) ? template.sequence : null,
    placement: template.placement ?? null,
    checklist: template.checklist ?? null,
    scheduleTemplateId: template.id,
    scheduleSystemKey: template.systemKey ?? null,
    occurrenceKey: key,
    occurrenceAt: scheduledAt,
    origin_id: `schedule:${template.id}`
  };
}

function pendingScheduleDelivery(id, { started = false, at = new Date().toISOString() } = {}) {
  return {
    id,
    status: "pending",
    started: Boolean(started),
    createdAt: at,
    attempts: 0,
    lastAttemptAt: null,
    deliveredAt: null,
    lastError: null,
    receipts: []
  };
}

async function flushScheduleDeliveriesUnlocked(root, {
  now = () => new Date().toISOString(),
  deliverReminder = deliverScheduleReminder
} = {}) {
  const cards = await loadAllCards(root);
  const results = [];
  for (const snapshot of cards) {
    const delivery = snapshot.scheduleDelivery;
    if (!delivery || delivery.status !== "pending" || typeof delivery.id !== "string") continue;
    const attemptedAt = now();
    let outcome;
    try {
      outcome = await deliverReminder(root, snapshot, {
        started: delivery.started === true,
        idempotencyKey: delivery.id
      });
    } catch (error) {
      outcome = { ok: false, error: String(error?.message ?? error) };
    }
    const ok = outcome?.ok === true;
    const error = ok
      ? null
      : String(outcome?.error ?? outcome?.reason ?? "no delivery channel accepted the reminder").slice(0, 500);
    let acted = false;
    const updated = await updateCardCAS(root, snapshot.id, (current) => {
      acted = false;
      const live = current.scheduleDelivery;
      if (!live || live.id !== delivery.id || live.status !== "pending") return null;
      acted = true;
      const attempts = Math.max(0, Number(live.attempts) || 0) + 1;
      const nextDelivery = {
        ...live,
        status: ok ? "delivered" : "pending",
        attempts,
        lastAttemptAt: attemptedAt,
        deliveredAt: ok ? attemptedAt : null,
        lastError: error,
        receipts: Array.isArray(outcome?.receipts) ? outcome.receipts.slice(0, 24) : []
      };
      return {
        ...current,
        scheduleDelivery: nextDelivery,
        scheduleNotifiedAt: ok && live.started !== true ? attemptedAt : current.scheduleNotifiedAt ?? null,
        events: withEvent(current, {
          at: attemptedAt,
          kind: ok ? "schedule-delivered" : "schedule-delivery-pending",
          message: ok
            ? `Scheduled ${live.started ? "start notice" : "reminder"} delivered`
            : `Scheduled ${live.started ? "start notice" : "reminder"} pending retry: ${error}`
        })
      };
    });
    if (acted) results.push({ id: snapshot.id, deliveryId: delivery.id, ok, card: updated });
  }
  return results;
}

// Public recovery seam for setup/startup callers. Normal ticks call the
// unlocked variant while already holding the schedule lock.
export async function reconcileScheduleDeliveries(root, options = {}) {
  return withFileLock(path.join(root, ".schedule-sweep.lock"), "schedule sweep", () =>
    flushScheduleDeliveriesUnlocked(root, options)
  );
}

async function materialiseOccurrenceUnlocked(root, board, template, scheduledAt, key, { manual = false } = {}) {
  const all = await loadAllCards(root);
  const existing = all.find((card) => card.occurrenceKey === key);
  const schedule = template.schedule;
  const targetList = getList(board, schedule.targetList) ? schedule.targetList : "backlog";
  const runTarget = schedule.action === "run" ? runTargetForSchedule(board, template, targetList) : null;
  const runnable = schedule.action === "run" && Boolean(runTarget);
  if (existing) return { card: existing, created: false, runnable };
  const destination = runnable ? runTarget : targetList;
  const card = await createCard(root, occurrenceInput(template, destination, key, scheduledAt));
  const stamp = new Date().toISOString();
  const stamped = await updateCardCAS(root, card.id, (current) => ({
    ...current,
    scheduleNotifiedAt: null,
    // A runnable occurrence keeps scheduleAction "run" — that is the tick's
    // signal to kick the card's conversation; the kick clears it.
    scheduleAction: runnable ? "run" : null,
    scheduleDelivery: runnable
      ? null
      : pendingScheduleDelivery(`schedule:${key}:reminder`, { started: false, at: stamp }),
    events: withEvent(current, {
      at: stamp,
      kind: manual ? "schedule-run-now" : "schedule-occurrence",
      message: `${manual ? "Run now" : "Scheduled occurrence"} from ${template.id}${runnable ? ` - queued on ${destination}` : " - reminder queued"}`
    })
  }));
  const result = stamped || card;
  return { card: result, created: true, runnable };
}

// Create an extra occurrence without changing a recurring template's next regular
// instant. This is the server/MCP/UI "Run now" seam.
export async function runScheduleNow(root, board, templateId, { now = () => new Date().toISOString() } = {}) {
  return withFileLock(path.join(root, ".schedule-sweep.lock"), "schedule sweep", async () => {
    const template = await loadCard(root, templateId);
    if (template.list !== "scheduled" || template.schedule?.kind !== "cron") {
      throw new Error("run now is only available for recurring templates in Scheduled");
    }
    const stamp = now();
    const key = `${template.id}:manual:${stamp}:${ulid()}`;
    const materialised = await materialiseOccurrenceUnlocked(root, board, { ...template, schedule: { ...template.schedule, action: "run" } }, stamp, key, { manual: true });
    let verified = false;
    const updatedTemplate = await updateCardCAS(root, template.id, (current) => {
      verified = false;
      if (current.list !== "scheduled" || current.schedule?.kind !== "cron") return null;
      verified = true;
      return {
        ...current,
        schedule: {
          ...current.schedule,
          runNowVerification: {
            occurrenceId: materialised.card.id,
            occurrenceKey: key,
            verifiedAt: stamp
          }
        },
        events: withEvent(current, {
          at: stamp,
          kind: "schedule-run-now-verified",
          message: `Run now created occurrence ${materialised.card.id}`
        })
      };
    });
    if (!updatedTemplate || !verified) throw new Error("Run now occurrence was created but its verification receipt could not be persisted");
    return { ...materialised, template: updatedTemplate };
  });
}

export async function sweepDueSchedules(root, board, {
  now = () => new Date().toISOString(),
  at = () => Date.now(),
  deliverReminder = deliverScheduleReminder,
  afterScheduleIntent = null
} = {}) {
  return withFileLock(path.join(root, ".schedule-sweep.lock"), "schedule sweep", async () => {
    // Recovery comes first: a process may have died after committing a due
    // transition but before (or just after) the channel accepted its stable key.
    await flushScheduleDeliveriesUnlocked(root, { now, deliverReminder });
    const cards = await loadAllCards(root);
    const swept = [];
    for (const original of cards) {
      const schedule = original.schedule ?? normaliseCardSchedule(null, {
        scheduledFor: original.scheduledFor,
        scheduleAction: original.scheduleAction,
        targetList: original.list,
        now: original.created ?? now()
      });
      if (!schedule || schedule.enabled === false || !schedule.nextAt) continue;
      const nextMs = Date.parse(schedule.nextAt);
      if (!Number.isFinite(nextMs) || nextMs > at() || original.status === "running") continue;

      if (schedule.kind === "cron") {
        // A stale nextAt after downtime represents the schedule being behind, not a
        // replay order. Select the latest due wall minute and create only that one.
        const latest = latestCronOccurrence(schedule.cron, schedule.timezone, new Date(at()).toISOString());
        const scheduledAt = latest && Date.parse(latest.at) >= nextMs ? latest.at : schedule.nextAt;
        const key = scheduleOccurrenceKey(original.id, scheduledAt, schedule.timezone);
        // Durable intent before creation. A crash here leaves a visible receipt;
        // the next sweep resumes it. A crash after creation finds occurrenceKey
        // and advances without creating a duplicate.
        let intentWritten = false;
        const intentCard = await updateCardCAS(root, original.id, (current) => {
          intentWritten = false;
          const live = current.schedule;
          if (!live || live.kind !== "cron" || live.enabled === false || live.nextAt !== schedule.nextAt) return null;
          intentWritten = true;
          return { ...current, schedule: { ...live, pending: { occurrenceKey: key, at: scheduledAt } } };
        });
        // updateCardCAS returns the current card when the mutator opts out. The
        // explicit flag is therefore the proof that this sweep owns the intent;
        // without it, materialising would resurrect a just-paused/rescheduled run.
        if (!intentCard || !intentWritten) continue;
        if (typeof afterScheduleIntent === "function") await afterScheduleIntent({ template: intentCard, key, scheduledAt });
        const liveIntent = await loadCard(root, original.id).catch(() => null);
        if (
          !liveIntent?.schedule ||
          liveIntent.schedule.kind !== "cron" ||
          liveIntent.schedule.enabled === false ||
          liveIntent.schedule.nextAt !== schedule.nextAt ||
          liveIntent.schedule.pending?.occurrenceKey !== key
        ) continue;
        const materialised = await materialiseOccurrenceUnlocked(root, board, { ...liveIntent, schedule: liveIntent.schedule }, scheduledAt, key);
        const wallKey = zonedMinute(new Date(scheduledAt), schedule.timezone).key;
        const skippedWallTimes = [];
        const following = nextCronOccurrence(schedule.cron, schedule.timezone, scheduledAt, {
          excludeWallKey: wallKey,
          onSkip: (skip) => skippedWallTimes.push({ ...skip, recordedAt: now() })
        });
        let acted = false;
        const updated = await updateCardCAS(root, original.id, (current) => {
          acted = false;
          const live = current.schedule;
          if (!live || live.kind !== "cron" || live.enabled === false || live.nextAt !== schedule.nextAt) return null;
          acted = true;
          const nextSchedule = {
            ...live,
            lastAt: scheduledAt,
            nextAt: following?.at ?? null,
            pending: null,
            snoozedUntil: null,
            ...(skippedWallTimes.length
              ? {
                  skippedWallTimes: [
                    ...(Array.isArray(live.skippedWallTimes) ? live.skippedWallTimes : []),
                    ...skippedWallTimes
                  ].slice(-24)
                }
              : {}),
            ...(following ? { lastError: null } : { enabled: false, lastError: "no next occurrence found within 370 days" })
          };
          let events = withEvent(current, {
            at: now(),
            kind: "schedule-advanced",
            message: `Created occurrence ${materialised.card.id}; next ${nextSchedule.nextAt ?? "disabled"}`
          });
          for (const skipped of skippedWallTimes) {
            events = withEvent({ ...current, events }, {
              at: skipped.recordedAt,
              kind: "schedule-dst-skip",
              message: `Skipped nonexistent wall time ${skipped.wallTime} (${skipped.timezone})`
            });
          }
          return {
            ...current,
            schedule: nextSchedule,
            scheduledFor: nextSchedule.nextAt,
            scheduleAction: nextSchedule.action,
            events
          };
        });
        if (updated && acted) swept.push({
          id: original.id,
          action: materialised.runnable ? "run" : "notify",
          occurrenceId: materialised.card.id,
          recurring: true
        });
        continue;
      }

      const targetList = getList(board, schedule.targetList) ? schedule.targetList : "backlog";
      // A one-shot `run` enters the normal Start path from its release target.
      // A resolved rail/non-interactive agent exit is runnable immediately; a
      // capture-only target such as Backlog falls back to its manual first edge
      // (Backlog → To Do) rather than degrading into a reminder.
      const runTarget = schedule.action === "run"
        ? runTargetForSchedule(board, original, targetList) ?? (validNextFor(board, targetList) || [])[0]
        : null;
      const runnable = schedule.action === "run" && Boolean(runTarget);
      let acted = false;
      const updated = await updateCardCAS(root, original.id, (current) => {
        acted = false;
        const live = current.schedule ?? normaliseCardSchedule(null, {
          scheduledFor: current.scheduledFor,
          scheduleAction: current.scheduleAction,
          targetList: current.list
        });
        if (!live || live.kind !== "once" || live.nextAt !== schedule.nextAt || current.status === "running") return null;
        acted = true;
        const stamp = now();
        const destination = runnable ? runTarget : targetList;
        return {
          ...current,
          list: destination,
          status: "ok",
          schedule: { ...live, enabled: false, lastAt: schedule.nextAt, nextAt: null, pending: null },
          scheduledFor: null,
          // A runnable one-shot keeps scheduleAction "run" for the tick's
          // conversation kick; a reminder clears it as before.
          scheduleAction: runnable ? "run" : null,
          scheduleNotifiedAt: null,
          scheduleDelivery: pendingScheduleDelivery(
            `schedule:${current.id}:${schedule.nextAt}:${runnable ? "started" : "reminder"}`,
            { started: runnable, at: stamp }
          ),
          events: withEvent(current, {
            at: stamp,
            kind: "schedule-due",
            message: runnable
              ? `Scheduled time reached - moved to ${destination} to run`
              : `Scheduled time reached - moved to ${destination}; reminder sent`
          })
        };
      });
      if (updated && acted) {
        swept.push({ id: original.id, action: runnable ? "run" : "notify" });
      }
    }
    await flushScheduleDeliveriesUnlocked(root, { now, deliverReminder });
    return swept;
  });
}

// Reclaim cards whose remote worker went silent (Outpost Dispatch).
//
// The sibling of sweepOrphanedRuns, for the cross-machine case. A machine that
// sleeps, loses its network, or dies mid-run stops heartbeating; without this
// its card stays claimed forever and is invisible to every other machine,
// because claimability() refuses a card whose claim is still held.
//
// PLACEMENT IS CLEARED on reclaim (the product decision): the card returns to
// needs-attention untargeted, so it can be re-dispatched anywhere rather than
// stranded waiting for a machine that may never come back. The machine is NAMED
// in the reason — "it failed" is not actionable, "the Mac mini went silent" is.
export async function sweepExpiredDispatchClaims(
  root,
  { now = () => new Date().toISOString(), at = () => Date.now() } = {}
) {
  const cards = await loadAllCards(root);
  const swept = [];
  for (const card of cards) {
    if (!isDispatchClaimExpired(card, { at: at() })) continue;
    const machine = card.dispatch?.machine || "an outpost";
    const res = await updateCardCAS(root, card.id, (c) => {
      // Re-check under the lock: the worker may have heartbeated or reported a
      // terminal status between our read and this write.
      if (!isDispatchClaimExpired(c, { at: at() })) return null;
      const reason = `Dispatched run on ${machine} went silent (no heartbeat within the lease). The card was reclaimed and its placement cleared, so it can be sent to any machine.`;
      return {
        ...c,
        list: "needs-attention",
        status: "needs-attention",
        runningSince: null,
        runOwner: null,
        // Untargeted, per the reclaim decision.
        placement: { target: "host" },
        // Keep the claim record as evidence of WHERE it was, marked terminal so
        // it is neither live nor swept again.
        dispatch: { ...c.dispatch, state: "failed", releasedAt: now(), detail: reason },
        attentionReason: reason,
        attentionKind: "failed",
        events: withEvent(c, {
          at: now(),
          kind: "parked",
          message: `Reclaimed from ${machine} — no heartbeat`,
          detail: reason
        })
      };
    });
    if (res) swept.push(card.id);
  }
  return swept;
}

export async function recoverInterruptedRuns(root, now = () => new Date().toISOString()) {
  const cards = await loadAllCards(root);
  const recovered = [];
  for (const card of cards) {
    if (card.list !== "running" && card.status !== "running") continue;
    // A conversation-linked card is not interrupted by a BOARD restart: the
    // gateway drives its stretches, and if the gateway itself died the tick's
    // kick lane resumes the conversation from its store. Clearing it here would
    // yank a card out from under a live (or resumable) conversation.
    if (card.conversationId) continue;
    // Do NOT clear a run driven by a LIVE process that is not us — a board restart
    // (every prod:redeploy) must not reset a card another local process is still
    // driving; that driver's own terminal write would then land against a card
    // this sweep had already yanked to To do.
    if (ownedByAnotherLiveDriver(card)) continue;
    const res = await updateCardCAS(root, card.id, (c) => {
      if (c.list !== "running" && c.status !== "running") return null; // raced: already cleared
      if (c.conversationId) return null;
      if (ownedByAnotherLiveDriver(c)) return null;
      // Move, don't flip: see sweepOrphanedRuns — status alone is re-derived
      // back from the running list at the write choke point.
      return {
        ...c,
        list: "todo",
        status: "ok",
        runningSince: null,
        runOwner: null,
        lastDispatchError: {
          at: now(),
          reason: "interrupted",
          listId: c.list,
          message: "The board server restarted while this run was in flight; the run was lost. The card was moved to To do — Start it to retry."
        },
        events: withEvent(c, {
          at: now(),
          kind: "recovered",
          message: "Run interrupted by a board restart — released to To do (Start to retry)"
        })
      };
    });
    if (res) recovered.push(card.id);
  }
  return recovered;
}

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

// Group a list's eligible cards by execution scope. Real projects retain their
// historical keys; personal/no-project cards get the reserved personal token so
// Test dispatch preserves their fixed workspace. An ordinary null/empty project
// still groups under "(no-project)" and receives no cwd pin.
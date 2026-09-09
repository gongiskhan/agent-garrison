// stretch.mjs — the Conversations stretch launcher, exit gate and escalation
// ladder (Conversations plan, 2026-08-26).
//
// A CONVERSATION is the perceived main session; no model ever holds it. Every
// model invocation is a STRETCH: a short-lived, fully native runtime session
// that boots from a brief (L1 summary + last handoffs + task + steering),
// works, writes a structured handoff, and dies. This module owns:
//
//   - buildStretchBrief   L1 + L2 pointers + the exit contract
//   - runStretch          one adapter session (agent-sdk warm-keyed fresh, or
//                         a secondary exec lane), bounded by a hard timeout
//   - runExitGate         refuses to close a stretch without a valid handoff:
//                         file → fenced-JSON reply → ONE in-session re-ask →
//                         ONE floor-rung repair call → synthetic failed
//                         handoff. NEVER silently passes.
//   - resolveRung         pin → forced → tripwire → sticky floor → duty
//                         default, clamped to the duty ceiling
//   - tripwires           pure functions over the store's handoff tail
//   - applyFlowPolicy     review-before-done, done-requires-evidence
//   - runConversation     the loop, one lane per conversation, OFF the
//                         serialized operative turn chain
//
// The launcher lives in the GATEWAY because everything a stretch needs lives
// here: target resolution, adapters, secrets, cancel. The board is a trigger
// and a state sink reached over its HTTP API (writeCardWithHooks fires its
// terminal side effects exactly once).

import { pendingConversationQuestion } from "@garrison/claude-pty/conversation-question.mjs";
import fs from "node:fs";
import path from "node:path";
import {
  openConversation,
  newConversationId,
  validateHandoff,
  defaultResolveEvidence,
  renderSummary,
  runLog,
  aggregateUsageRows,
  priceAggregate,
  composeFindings,
  repetitionReport,
} from "@garrison/claude-pty";
import { boardBase, cardById } from "./autonomous-cards.mjs";
import { endSessionCard, resumeSessionCard, syncWorkSessionTitle, reportCardHook } from "@garrison/talk/conversation-cards";
import { resolveRunScope, listProjectNames, readDevRoot, PERSONAL_SCOPE_TOKEN } from "./project-source.mjs";
import { applyDutyHarnessProfile, runtimeCodexEnabled } from "./harness-profiles.mjs";
import { prepareStretchContinuity } from "./stretch-continuity.mjs";
import { originalRequest, recoverInterruptedStretch, deploymentInFlight, parkConversation } from "./conversation-recovery.mjs";
import {
  routingTableEnabled,
  readRoutingTable,
  pickRoute,
  applyRouteRow,
  markCooling,
  limitShaped,
  modelFamily,
} from "./routing-table.mjs";

export const STRETCH_TIMEOUT_MS = Number(process.env.GARRISON_STRETCH_TIMEOUT_MS) > 0
  ? Number(process.env.GARRISON_STRETCH_TIMEOUT_MS)
  : 30 * 60_000;

export const MAX_STRETCHES_DEFAULT = 24;

// The conversation flow policy — deliberately tiny. Sequencing is the
// handoff's job (nextSteps.next); the policy only enforces two invariants and
// otherwise lets the no-progress tripwire handle a stuck duty.
export const CONVERSATION_FLOW = {
  terminal: ["done", "needs-input"],
  reviewBeforeDone: { from: ["implement"], insert: ["adversarial-review", "review"] },
  doneRequiresEvidence: { kinds: ["gate", "run"], otherwise: "test" },
  selfLoopCap: 2,
};

// review-before-done used to be unconditional, and a decorrelated second read
// on another provider is not free: measured on the 2026-08-28 benchmark it was
// $0.44 of a $2.11 conversation - 21% - across two passes that found nothing
// the eighteen behaviour checks did not already cover. The second pass, over a
// small follow-up edit after the first review had already passed, is the one
// that is hard to defend.
//
// So the review is GATED on what the stretch actually did. The thresholds come
// from the ledger: across 33 recorded conversations the median implement
// stretch writes 7,670 bytes, so 12,000 is "more than a routine pass" rather
// than a number picked to look reasonable. Everything uncertain resolves
// TOWARDS reviewing: an incomplete handoff, a risky path, an explicit ask, or
// an unreadable change size all review.
export const REVIEW_GATE = {
  changedBytes: 12_000,
  changedFiles: 5,
  // A second adversarial pass, after one already ran and passed, has to clear
  // a much higher bar - that is the A-B loop this gate exists to stop.
  repeatChangedBytes: 40_000,
  riskyPath: /(auth|crypt|secret|token|vault|permission|password|credential|\.env)/i,
  askedFor: /\b(review|adversarial|audit|scrutinis|scrutiniz)/i,
};

// The review BUDGET, which is a different question from the review GATE. The
// gate asks "is this particular change worth a second read"; the budget asks
// "how many second reads may this task buy at all". Without one the count is a
// free per-stretch choice by the model: on the 2026-08-31 benchmark the same
// easy task took zero, one and two adversarial passes across three runs and
// swung 2.4x in cost as a result. A cap belongs in the orchestrator, because a
// prompt asking a model to limit its own escalation is the thing that failed.
//
// Counted over both review duties, not just the adversarial one: the
// review-before-done insert picks whichever is selected, so a budget that only
// covered adversarial-review would be silently satisfied by the other.
export const REVIEW_BUDGET_DEFAULT = 2;
export const REVIEW_DUTIES = new Set(CONVERSATION_FLOW.reviewBeforeDone.insert);

// A per-task override, so a task that genuinely wants more (or none) says so in
// its own brief rather than in global config. `routing.reviewBudget` is the
// structured form; the text form is what a human writes in a card body.
const REVIEW_BUDGET_DIRECTIVE = /review[\s_-]*budget\s*[:=]\s*(\d+)/i;

/** Everything a task said about itself: the card, and every message in the
 *  conversation (the opening task is recorded as the first user-message). This
 *  is "the brief" as the human wrote it, which is where a per-task override has
 *  to be readable from. */
export function briefTextFor(store = null, card = null) {
  const messages = (store?.tail?.(200, { kinds: ["user-message"] }) ?? [])
    .map((e) => String(e.payload?.text ?? ""));
  return [card?.title, card?.description, card?.acceptance, ...messages]
    .filter((v) => typeof v === "string" && v)
    .join("\n");
}

/** The cap for this task, and where it came from. */
export function reviewBudgetFor({ card = null, env = process.env, briefText = null } = {}) {
  const routed = card?.routing?.reviewBudget;
  if (Number.isFinite(Number(routed)) && Number(routed) >= 0) {
    return { cap: Math.floor(Number(routed)), source: "card.routing.reviewBudget" };
  }
  const text = briefText ?? briefTextFor(null, card);
  const hit = REVIEW_BUDGET_DIRECTIVE.exec(text);
  if (hit) return { cap: Math.floor(Number(hit[1])), source: "brief" };
  const fromEnv = Number(env?.GARRISON_HTTPGATEWAY_REVIEW_BUDGET);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return { cap: Math.floor(fromEnv), source: "config" };
  return { cap: REVIEW_BUDGET_DEFAULT, source: "default" };
}

/** Review stretches this task has already STARTED, off the ledger rather than a
 *  card counter: the ledger is the record and survives a gateway restart. */
function workCycleEvents(store, kinds, limit = 400) {
  const events = store?.tail?.(limit, { kinds: [...new Set([...kinds, "handoff"])] }) ?? [];
  const completed = events.findLastIndex((e) => e.kind === "handoff" && e.payload?.nextSteps?.next === "done");
  return events.slice(completed + 1).filter((e) => kinds.includes(e.kind));
}

export function reviewsUsed(store) {
  return workCycleEvents(store, ["stretch-started"])
    .filter((e) => REVIEW_DUTIES.has(e.payload?.duty ?? e.duty)).length;
}

/** Review stretches ASKED for so far, including any the budget already refused
 *  - the number worth knowing when the cap looks too tight. */
export function reviewsRequested(store) {
  return workCycleEvents(store, ["handoff", "review-budget"])
    .filter((e) => (e.kind === "review-budget" ? true : REVIEW_DUTIES.has(e.payload?.nextSteps?.next))).length;
}

/** May this task start another review? */
export function reviewBudgetDecision(store, { card = null, env = process.env } = {}) {
  const { cap, source } = reviewBudgetFor({ card, env, briefText: briefTextFor(store, card) });
  const used = reviewsUsed(store);
  return { allowed: used < cap, cap, used, requested: reviewsRequested(store) + 1, source };
}

/** How much a stretch actually changed, read off the ledger rather than off
 *  git: a conversation's cwd is not always a repo, and the tool calls are the
 *  authoritative record of what was written. Longest input per tool id, because
 *  a tool_use block's arguments arrive as a growing prefix of their JSON. */
export function stretchChangeFootprint(store, stretchId) {
  if (!store || !stretchId) return { bytes: 0, files: [], known: false };
  const events = store.tail(4000, { kinds: ["session-event"] }) ?? [];
  const byTool = new Map();
  for (const e of events) {
    if (e.stretch !== stretchId) continue;
    for (const b of e.payload?.blocks ?? []) {
      if (b?.type !== "tool_use" || !b.toolUseId) continue;
      if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(b.name)) continue;
      const cur = byTool.get(b.toolUseId) ?? "";
      const next = typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? "");
      if (next.length > cur.length) byTool.set(b.toolUseId, next);
    }
  }
  let bytes = 0;
  const files = new Set();
  for (const raw of byTool.values()) {
    bytes += raw.length;
    try {
      const j = JSON.parse(raw);
      if (typeof j.file_path === "string") files.add(j.file_path);
    } catch { /* a truncated prefix still counts its bytes */ }
  }
  return { bytes, files: [...files], known: byTool.size > 0 };
}

/** Should this implement stretch be read by someone else before it closes? */
export function reviewGateDecision(store, { stretchId, handoff = null } = {}) {
  const status = handoff?.status ?? null;
  if (status && status !== "complete") {
    return { review: true, reason: `handoff status ${status}` };
  }
  const foot = stretchChangeFootprint(store, stretchId);
  if (!foot.known) {
    // No readable footprint is not evidence of a small change.
    return { review: true, reason: "change size unknown" };
  }
  const risky = foot.files.find((f) => REVIEW_GATE.riskyPath.test(f));
  if (risky) return { review: true, reason: `touched a sensitive path (${risky})` };

  // Did anyone ask for one? The task and any steering are the standing record
  // of what the human wanted.
  const asks = (store.tail(200, { kinds: ["user-message"] }) ?? [])
    .some((e) => REVIEW_GATE.askedFor.test(String(e.payload?.text ?? "")));
  if (asks) return { review: true, reason: "the request asks for a review" };

  const reviewedBefore = (store.tail(200, { kinds: ["handoff"] }) ?? [])
    .some((e) => String(e.payload?.duty ?? "").includes("review") && e.payload?.status === "complete");
  const threshold = reviewedBefore ? REVIEW_GATE.repeatChangedBytes : REVIEW_GATE.changedBytes;
  if (foot.bytes >= threshold || foot.files.length >= REVIEW_GATE.changedFiles) {
    return { review: true, reason: `${foot.bytes}B across ${foot.files.length} file(s)` };
  }
  return {
    review: false,
    reason: `${foot.bytes}B across ${foot.files.length} file(s) is below the ${threshold}B / ${REVIEW_GATE.changedFiles}-file bar${reviewedBefore ? " for a repeat pass" : ""}`,
  };
}

// Tripwire thresholds (locked): 3 attempts without progress, 2 consecutive
// gate-duty failures. Tuned from validation data later.
export const TRIPWIRE_NO_PROGRESS = 3;
export const TRIPWIRE_TEST_FAILS = 2;
const GATE_DUTIES = new Set(["test", "adversarial-test", "validate"]);

// ── ladders ─────────────────────────────────────────────────────────────────

/** The duty's ladder from the resolved model, or a synthetic one-rung ladder
 *  from its (duty, level) cell so every duty works with zero YAML edits. */
export async function ladderForDuty(gateway, duty, level = 1) {
  const model = await gateway.executionModel();
  const fromModel = model?.dutyLadder?.[duty];
  if (fromModel?.rungs?.length) return fromModel;
  const route = await gateway.executionRouteFor({ duty, level });
  if (!route?.target) return null;
  return {
    ladder: "synthetic",
    rungs: [
      {
        id: "only",
        target: route.targetId,
        runtime: route.target.runtime,
        provider: route.target.provider ?? null,
        model: route.target.model,
        params: route.target,
      },
    ],
    defaultIndex: 0,
    ceilingIndex: 0,
  };
}

/**
 * Which rung runs this stretch. Precedence: explicit pin → forced escalation
 * (a forceEscalation handoff: adversarial review, or any duty relaying the
 * user's ask for a stronger model) → tripwire (one rung above the floor) → the
 * conversation's sticky floor → the duty default. Clamped to the ceiling; a
 * clamp is recorded, and above-ceiling autonomy NEVER happens — the caller
 * turns a clamped force into needs-input when it must.
 */
export function resolveRung({ ladder, floorRungId = null, pinRungId = null, forced = false, tripwire = null }) {
  const rungs = ladder?.rungs ?? [];
  if (!rungs.length) return null;
  const idx = (id) => rungs.findIndex((r) => r.id === id);
  const floorIndex = floorRungId != null && idx(floorRungId) >= 0 ? idx(floorRungId) : ladder.defaultIndex;
  let index = floorIndex;
  let chosenBy = floorRungId != null && idx(floorRungId) >= 0 ? "floor" : "default";
  let chosenWhy = null;
  if (tripwire) {
    index = floorIndex + 1;
    chosenBy = "escalation-tripwire";
    chosenWhy = tripwire;
  }
  if (forced) {
    index = Math.max(index, floorIndex + 1);
    chosenBy = "escalation-forced";
    chosenWhy = typeof forced === "string" ? forced : "adversarial review forced escalation";
  }
  if (pinRungId != null && idx(pinRungId) >= 0) {
    index = idx(pinRungId);
    chosenBy = "pin";
    chosenWhy = null;
  }
  let clamped = false;
  if (index > ladder.ceilingIndex) {
    index = ladder.ceilingIndex;
    clamped = true;
    chosenBy = "ceiling-clamp";
  }
  if (index < 0) index = 0;
  const notify = index === rungs.length - 1 && rungs.length > 1 ? "top-tier" : null;
  return { rung: rungs[index], index, chosenBy, chosenWhy, clamped, notify, floorIndex };
}

/** Pure functions over the handoff tail. No counters on the card — the store
 *  is the record. */
export function tripwires(store, { duty, window = 12 } = {}) {
  const tail = store.tail(window, { kinds: ["handoff"] });
  // no-progress: trailing handoffs for THIS duty that are not complete and
  // carry no new evidence (empty or byte-identical to the previous attempt).
  let noProgress = 0;
  let prevEvidence = null;
  for (const evt of tail) {
    if (evt.duty !== duty) continue;
    const h = evt.payload ?? {};
    // A user steer cut the stretch short; it is neither progress nor its lack.
    if (h.steered === true) continue;
    if (h.status === "complete") {
      noProgress = 0;
      prevEvidence = null;
      continue;
    }
    const ev = JSON.stringify(h.evidenceRefs ?? []);
    if (!h.evidenceRefs?.length || ev === prevEvidence) noProgress += 1;
    else noProgress = 0;
    prevEvidence = ev;
  }
  // test-fail loops: trailing gate-duty handoffs failed|partial with no
  // intervening complete, across ANY gate duty.
  let testFails = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const evt = tail[i];
    if (!GATE_DUTIES.has(evt.duty)) continue;
    if (evt.payload?.steered === true) continue;
    const status = evt.payload?.status;
    if (status === "failed" || status === "partial") testFails += 1;
    else break;
  }
  const fires =
    noProgress >= TRIPWIRE_NO_PROGRESS
      ? "no-progress"
      : testFails >= TRIPWIRE_TEST_FAILS
        ? "test-fail"
        : null;
  return { noProgress, testFails, fires };
}

const ANSWER_DUTIES = new Set(["plan", "review", "adversarial-review", "validate", "discuss", "research", "report"]);
const ANSWER_CYCLE_DUTIES = new Set([...ANSWER_DUTIES, "triage", "dispatch", "responder", "dialogue"]);

// A prose deliverable has no runnable artifact to prove. It must be declared
// explicitly, and only an analytical, cardless response cycle can use it.
// Missing/old contracts stay on the work rail; neither an implement stretch nor
// its later review can rename changed work into an evidence-free answer.
function isAnswerCompletion({ store, duty, handoff, card }) {
  if (card || !ANSWER_DUTIES.has(duty) || handoff?.completion !== "answer"
    || handoff.status !== "complete" || handoff.synthesized !== false
    || handoff.nextSteps?.next !== "done" || handoff.nextSteps.items?.length !== 0 || handoff.blocker !== null) return false;
  const events = store?.tail?.(4000, { kinds: ["handoff", "stretch-started", "session-event", "finding"] }) ?? [];
  let boundary = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    // needs-input can park unfinished implementation; it cannot erase that
    // work from the evidence obligation when an analytical follow-up resumes.
    if (events[i].kind === "handoff" && events[i].payload?.nextSteps?.next === "done") { boundary = i; break; }
  }
  if (boundary < 0 && events.length >= 4000) return false; // unknown earlier work
  for (const event of events.slice(boundary + 1)) {
    if (["handoff", "stretch-started"].includes(event.kind)
      && !ANSWER_CYCLE_DUTIES.has(event.duty ?? event.payload?.duty)) return false;
    if (event.kind === "finding" && event.payload?.kind === "change") return false;
    for (const block of event.payload?.blocks ?? []) {
      if (block?.type !== "tool_use" || !["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "file_change"].includes(block.name)) continue;
      let input = block.input;
      try { if (typeof input === "string") input = JSON.parse(input); } catch { return false; }
      const file = input?.file_path;
      // Writing the mandatory handoff is session bookkeeping, not a project
      // mutation. Every other observed file edit retains the evidence gate.
      if (block.name === "Write" && typeof file === "string" && store?.dir
        && path.dirname(path.resolve(file)) === path.join(path.resolve(store.dir), "handoffs") && file.endsWith(".json")) continue;
      return false;
    }
  }
  return true;
}

/** The two flow invariants plus the review budget. Returns {next, rewritten, reason}. */
export function applyFlowPolicy(next, { store, duty, selectedDuties = [], cwd = null, stretchId = null, handoff = null, card = null, env = process.env } = {}) {
  // The responder answers a person on a settled conversation. Where it points
  // next is where the conversation already stood (done stays done after a
  // question) or the duty the person's follow-up asks for - the review and
  // evidence invariants below judge WORK, and a question is not work. Without
  // this, "is this deployed?" on a done card without on-disk evidence became a
  // fresh implement stretch.
  if (duty === "responder") {
    const unfinishedWork = workCycleEvents(store, ["handoff", "stretch-started"])
      .some((event) => !ANSWER_CYCLE_DUTIES.has(event.duty ?? event.payload?.duty));
    // A follow-up cannot turn an unfinished implementation/check into an
    // evidence-free answer. Questions on a settled cycle keep the fast path.
    if (!unfinishedWork) return { next, rewritten: false, reason: null };
  }
  // Dialogue is the spoken conversation (D62): one pass, one answer, then stop.
  // It has no work to show evidence for and nothing to hand off to - the work it
  // recognises becomes its own card, which runs the loop there. Without this
  // exemption "que horas são em Lisboa" answered, said done, and was rewritten
  // into a `test` stretch by the evidence invariant below - two minutes of
  // stretches and a closing line spoken instead of the answer.
  if (duty === "dialogue") return { next, rewritten: false, reason: null };
  if (next === "done" && isAnswerCompletion({ store, duty, handoff, card })) return { next, rewritten: false, reason: null };
  const budget = reviewBudgetDecision(store, { card, env });
  let reviewBudget = null;
  if (REVIEW_DUTIES.has(next)) {
    // The model asked for another review. Inside the budget this is its call and
    // nothing here touches it.
    if (budget.allowed) return { next, rewritten: false, reason: null };
    // A spent budget is a pause, never evidence that unfinished work passed.
    reviewBudget = { ...budget, from: next, to: "needs-input", trigger: "asked" };
    return { next: "needs-input", rewritten: true, reason: `review-budget: ${budget.used}/${budget.cap} spent`, reviewBudget };
  }
  if (next !== "done") return { next, rewritten: false, reason: null };
  let skippedReview = reviewBudget ? `review budget spent: ${reviewBudget.used}/${reviewBudget.cap}` : null;
  // Triage never closes a conversation as done: its job is to open the work
  // and name the first working duty, and a capable floor model will happily do
  // a small task itself and hand off done (observed on the first live run —
  // the whole deliverable written inside triage, skipping plan, implement and
  // review). needs-input stays allowed: parking for clarity IS triage's call.
  if (duty === "triage") {
    const first = ["implement", "plan"].find((d) => selectedDuties.includes(d));
    if (first) return { next: first, rewritten: true, reason: "triage-never-done" };
  }
  // review-before-done: implement work is not done until someone else read it -
  // when the change is big enough, risky enough, or unfinished enough to be
  // worth another provider's turn. See REVIEW_GATE.
  if (!reviewBudget && CONVERSATION_FLOW.reviewBeforeDone.from.includes(duty)) {
    const insert = CONVERSATION_FLOW.reviewBeforeDone.insert.find((d) => selectedDuties.includes(d));
    if (insert) {
      const gate = reviewGateDecision(store, { stretchId, handoff });
      if (gate.review && budget.allowed) {
        return { next: insert, rewritten: true, reason: `review-before-done: ${gate.reason}` };
      }
      if (gate.review) {
        // The gate wanted one and the budget refused. Recorded like an asked-for
        // review, because that is what it is: the orchestrator asked.
        reviewBudget = { ...budget, from: insert, to: "needs-input", trigger: "insert" };
        return { next: "needs-input", rewritten: true, reason: `required review exceeds the ${budget.cap}-review budget`, reviewBudget };
      } else {
        // Skipping is a decision, recorded as one. `done` still has to clear
        // done-requires-evidence below, so this is not a shortcut to closing.
        skippedReview = gate.reason;
      }
    }
  }
  // done-requires-evidence: somewhere in this conversation a gate/run evidence
  // ref must still resolve on disk. Restates the old terminal Test→Done
  // invariant without a phase graph.
  const handoffs = workCycleEvents(store, ["handoff"]);
  const hasResolvable = [handoff, ...handoffs.map((evt) => evt.payload)].some((candidateHandoff) =>
    (candidateHandoff?.evidenceRefs ?? []).some((ev) => {
      if (!CONVERSATION_FLOW.doneRequiresEvidence.kinds.includes(ev?.kind)) return false;
      // Anchor relative refs where the stretches WORK — the same anchoring the
      // exit gate's rule 10 uses. A bare statSync resolved against the gateway
      // process cwd, which is nowhere the evidence lives.
      const candidate = path.isAbsolute(String(ev?.ref ?? "")) || !cwd ? ev.ref : path.join(cwd, ev.ref);
      try {
        const st = fs.statSync(candidate);
        return st.isFile() && st.size > 0;
      } catch {
        return false;
      }
    })
  );
  if (!hasResolvable) {
    const otherwise = CONVERSATION_FLOW.doneRequiresEvidence.otherwise;
    const corrected = workCycleEvents(store, ["policy-rewrite"])
      .some((event) => event.payload?.reason === "verification-evidence-missing");
    if (selectedDuties.includes(otherwise) && (duty !== otherwise || !corrected)) {
      return {
        next: otherwise, rewritten: true,
        reason: duty === otherwise ? "verification-evidence-missing" : "done-without-evidence",
        verificationMissing: true, skippedReview, reviewBudget,
        items: ["Record the completed verification in a non-empty owner file, including actual commands/checks, outcomes and remaining limits. Reference it in evidenceRefs with kind run or gate. Reuse existing results where valid; source files and build markers alone are not verification. Finish any missing checks before reporting done."],
      };
    }
    return { next: "needs-input", rewritten: true, reason: "No completed verification was recorded; work cannot be marked done", skippedReview, reviewBudget };
  }
  return {
    next,
    rewritten: Boolean(reviewBudget),
    reason: reviewBudget ? `review-budget: ${reviewBudget.used}/${reviewBudget.cap} spent` : null,
    skippedReview,
    reviewBudget,
  };
}

// ── brief ───────────────────────────────────────────────────────────────────

const FINDINGS_CONTRACT = `## Findings (record these AS YOU GO, not at the end)

Every time you establish something the next stretch would otherwise have to
re-discover, record it immediately with \`mcp__garrison__garrison_finding_add\`.
A finding is ONE LINE of what you established plus pointers to where it lives -
never the code itself. "mintKey lives in src/lib/identity.js and returns a
sortable id" is a finding; pasting identity.js is not, and will be rejected.

  fact      something you verified about the code   REQUIRES anchorPath
  change    something you altered                   REQUIRES anchorPath
  decision  a choice you made, and why              no anchor
  rejected  an approach you ruled out, and why      no anchor
  failure   something that did not work             no anchor

The anchor is how the next stretch learns your claim went out of date: if that
file changes afterwards it is shown the entry marked STALE and told to re-read.
Record rejected and failure entries too - an approach that did not work is the
most expensive thing for the next stretch to rediscover.

When a finding points at a ledger address (\`<conversationId>#<seq>\`) and you need
the detail behind it, read it with \`mcp__garrison__garrison_conversation_fetch\`
(\`seq\` returns that record whole, \`digest: true\` returns the conversation as prose
plus one line per tool call). When you have no address and the handoffs you were
given are too thin, find one first with
\`mcp__garrison__garrison_conversation_search\`.`;

// Why triage recorded nothing. Across every recorded run the triage stretch read
// eight or nine files and appended ZERO findings, and none of the obvious causes
// held: the tool is in SHARED_MCP_TOOLS so every duty carries it, triage runs on
// agent-sdk (haiku) with the shared tool profile, and FINDINGS_CONTRACT is in
// every brief. Reading the replies settled it. Triage established exactly the
// facts the next stretch needed - which file is the persistence choke point,
// where ids are minted, what the conventions file requires - and put every one
// of them in its handoff summary and evidenceRefs, because that is what its duty
// description asks for and what the exit contract validates. The generic "record
// what the next stretch would re-discover" never says that ORIENTING is itself a
// finding, so a duty whose stated output is a summary routes everything there.
//
// So the brief now states the expectation per duty. This is per-task dynamic
// material and belongs in the message after the last cache breakpoint, alongside
// the brief and the findings record - never in the system prompt.
export const DUTY_FINDINGS_EXPECTATION = {
  triage: `### What to record on this duty

You are the opening stretch, so everything you establish is something the next
stretch would otherwise re-read from nothing. Before you hand off, record what
you learned about the shape of this repo as \`fact\` entries with an anchorPath:
where the entry point is, where persistence, configuration and id minting live,
what the conventions file requires, and what is already built. One line each,
pointers not content.

Naming these in your handoff summary is not recording them. The summary is prose
for a human and is not carried forward as claims; the findings record is what the
next stretch is actually handed.`,
};

// Per-duty guidance on the SHAPE of the reply, beside the findings expectation.
// The responder is the one duty a person talks to directly: it answers on a
// settled conversation, and a follow-up ask ("now also do X", the answer to
// what the work was parked on) has to become WORK again rather than a haiku
// paragraph - by handing off to the duty that does it, never by doing it.
export const DUTY_GUIDANCE = {
  triage: `### Intake, then hand off
Read the user's complete request, the prior handoff and any attached context.
Identify the desired result, scope, acceptance checks and existing authorization.
Use at most a few targeted reads when a fact changes the route. Do not perform
the work, delegate exploration, edit files, run commands or restart services.
For a bounded fix go straight to implement; use plan only when there is a real
design decision. Route operational work to ops, questions to discuss/research.
Missing facts you can inspect are not blockers. Ask for user input only when an
essential decision cannot be inferred or checked. Do not re-ask for authorized work.
Return a concise handoff with concrete remaining steps and constraints, using
the fenced handoff form. Findings belong in the findings tool, not just prose.
Finish intake within eight tool turns; the working duty can investigate further.`,
  // The one duty a person SPEAKS to (D62). Everything here is read aloud into an
  // earpiece, so the register is the voice lane's, not the loop's: the word cap
  // and the markdown ban are the same ones buildVoiceDiscussPrompt has carried
  // since D25, and they are load-bearing - tts.mjs refuses to render past 600
  // characters. The other half is the escalation rule: this duty finishes small
  // things itself and REFUSES to start big ones inline, because the moment it
  // does, the delivery loop opens on a conversation the person is listening to.
  dialogue: `### How to answer on this duty

You are talking with the person, out loud. They are wearing an earpiece or
holding a phone; what you write here is spoken back to them. One pass: answer,
act, stop. There is no next stretch to hand to and nothing to hand off.

How to speak here, which is different from writing:

- Under 55 words. This is a hard limit, not a guideline.
- No markdown, no bullets, no headings, no code, no URLs, no file paths, no
  emoji - nothing you would not say out loud to someone next to you.
- No preamble, no sign-off, no repeating their question back at them.
- Answer in the language they spoke. When that is Portuguese it is EUROPEAN
  Portuguese: "tu", not "você"; "estou a fazer", not "estou fazendo".
- Say plainly when you do not know. Disagree when they are about to do
  something daft, and say why - agreement they did not earn is worth nothing.
- When the request is genuinely ambiguous, ask ONE short question and stop.
  They answer by voice and the conversation carries on right here.

What to DO, not just say. Finish it in this pass whenever you can:

- A question you can answer, from what you know or with the tools you have:
  answer it.
- A fact about them or their work worth keeping: save it with your memory
  tools, then say in a few words that you kept it.
- A note or a thought to keep: write it down.
- A reminder, an errand, an appointment, something for a day: put it on the
  board with a due date. Say what you put there.
- A message to send through a connector: send it, then say you sent it.

What NOT to do here. Real project work - code, a feature, a bug, a refactor, a
deployment, an automation to build, an investigation that needs several steps -
does not happen in this conversation. Create a card for it with
garrison_create_card (title, and a description carrying what they actually
said), which starts its own conversation and runs there under triage, and tell
them in one sentence that it is on the board and running. Never open that work inline, never promise
to do it "now" here, and never hand off: your handoff is always
"nextSteps.next": "done", status "complete".`,
  responder: `### How to answer on this duty

You are the conversation's responder: a person wrote into a conversation with no
work running. Use the summary and handoffs as context, and answer their LATEST
message even when it changes the subject. Do not append unrelated old work updates.
For a question, use the tools available to find the answer: public web search or
fetch can supply current information without a dedicated connector. A bounded
lookup belongs in this reply. Try another suitable source or method if the first
fails; ask one focused question if an essential detail, such as location, is
missing. Cite checked sources in text replies. Never fabricate an answer or claim
an attempt you did not make. The message has one of two shapes:

- A QUESTION or a remark. Answer it plainly in your reply, record anything you
  promised in your handoff summary, and hand off with "nextSteps.next" set to
  where the conversation already stood: "done" when the work was finished,
  "needs-input" when it was parked and still is.
- A REQUEST FOR WORK: a follow-up task, a change, a fix, or the answer to what
  the work was parked on. Do NOT do the work yourself. Say in one or two
  sentences what happens next, put the request into "nextSteps.items", and hand
  off with "nextSteps.next" naming the duty that should do it - "triage" when
  the ask still needs scoping, otherwise the duty that fits (implement, plan,
  review, ...). Status "complete". The conversation re-opens on that duty and
  the card goes back to work.`,
};

export function dutyGuidanceFor(duty) {
  return DUTY_GUIDANCE[duty] ?? null;
}

// Behind `triage_findings` (default on) so the per-duty expectation can be
// reverted without touching the shared contract above.
export function dutyFindingsExpectationEnabled(env = process.env) {
  const raw = String(env?.GARRISON_HTTPGATEWAY_TRIAGE_FINDINGS ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false;
  return true;
}

// ── card attachments ────────────────────────────────────────────────────────
// Card-owned uploads (kanban cards/<id>/attachments/) reached the model in the
// duty-list era: buildCardPrompt folded the absolute paths into every dispatch
// prompt. THE CUT deleted that engine and the conversation brief never picked
// the fold up, so a card could say "describe the attached images" while no
// stretch ever saw a path or had a tool to list one. The card detail read now
// carries `path` on uploaded attachments and the brief folds them back in,
// re-read per stretch so a file attached mid-conversation reaches the NEXT
// stretch, not the next conversation.
export function cardAttachmentsEnabled(env = process.env) {
  const raw = String(env?.GARRISON_HTTPGATEWAY_CARD_ATTACHMENTS ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false;
  return true;
}

export function findingsExpectationFor(duty, env = process.env) {
  if (!dutyFindingsExpectationEnabled(env)) return null;
  return DUTY_FINDINGS_EXPECTATION[duty] ?? null;
}

const HANDOFF_CONTRACT = `## Exit contract (MANDATORY)

Before you finish, write your handoff as JSON to the ABSOLUTE path given
below ("handoffPath"). If you cannot write files, end your reply with the
same JSON in a fenced code block labeled handoff (\`\`\`handoff ... \`\`\`).

The handoff schema — every KEY is mandatory; empty arrays are valid, absent
keys are not:
{
  "v": 1,
  "stretchId": "<given below>",
  "duty": "<your duty>",
  "status": "complete" | "partial" | "blocked" | "failed",
  "completion": "work" | "answer",
  "summary": "<what happened - concise, plain language, <=4000 chars>",
  "evidenceRefs": [{"kind":"file|commit|run|gate|artifact|url|log","ref":"<ABSOLUTE path or id>","note":"..."}],
  "nextSteps": {"next":"<a selected duty, or done, or needs-input>","why":"...","items":["..."]},
  "blocker": null | {"what":"...","needs":"...","who":"..."},
  "activeConstraints": ["..."],
  "failedApproaches": [{"approach":"...","why":"..."}],
  "surprises": ["..."],
  "forceEscalation": null | "<reason>",
  "synthesized": false
}
When next is "needs-input", include an optional "question": {"question":"one concise question", "options":[{"label":"a short reply the user can send", "description":"optional consequence"}]}. Offer up to 4 concrete, distinct replies when useful; an empty options array is valid and free-form input is always available. These labels are sent verbatim as the user's message. For missing Vault credentials offer "I have added the keys to the vault". For an unresolved merge decision, where the alternatives actually apply, offer "Drop it - stash", "Drop it - delete", "Merge it in" and explain what each does. Never suggest destructive choices for completed decision records. Omit question outside needs-input. No extra model call is needed to generate these choices.

Rules: blocked requires a blocker; partial/failed require at least one
failedApproaches entry; next "done" requires status "complete"; a gate/run/file
evidence ref must point at a real non-empty file. Update nothing else — the
exit gate applies your handoff to the conversation summary.

For completion "work", next "done" also requires a verification report with
evidenceRefs kind "run" or "gate". Save the actual checks/commands, outcomes and
remaining limits in a non-empty file under the conversation store, and use its
absolute path as ref. Reuse already-completed checks when their results still
apply; do not repeat them just to produce a report. A source file, commit or
build marker alone does not establish that verification passed. If checks are
missing, continue with test/validate and name what remains; this is work for
the agent, not a reason to ask the user to record evidence.

completion defaults to "work" for older handoffs. Use "answer" ONLY when the
user requested an informational reply (for example a prose plan, explanation,
review or evaluation), your reply fully delivers it, and no requested change,
artifact creation, command/test execution or other action remains. A request to
implement, fix, deploy or actually run checks is "work", even when its current
duty is plan/review/validate: keep working or hand off the remaining duty.
An answer has next "done", no blocker and no nextSteps.items. Do not invent or
run tests, create evidence files or expand scope to prove a prose-only answer.
The gateway permits this evidence exception only for cardless analytical
responses without implementation work or recorded project edits in the current
response cycle. All card deliverables remain "work". Citations and read-only
inspection can support an answer without fabricating gate/run evidence.

forceEscalation is the model lever: it runs the NEXT stretch one rung above
the conversation's floor and raises the sticky floor. Set it to a one-line
reason when the user asked for a stronger model or more effort (relay their
ask — a plain chat message cannot move the rung by itself), or when your own
attempt failed for capability rather than missing-information reasons.
Otherwise keep it null: escalation is paid for, and a reflexive escalation on
routine work is a cost bug.

The summary is read by a HUMAN — when next is "done" it is shown whole as the
conversation's final report. Write it tight: lead with the outcome in one short
sentence, then short markdown bullets for what changed and how it was verified.
No filler, no restating the task, no hedging.

HOSTED NODE DEPLOYMENT: never kill or restart the gateway, app, or parent
process directly. In the Garrison checkout use npm run node:reload or
npm run node:redeploy. The command queues a job owned by the machine's service
supervisor. When it returns, hand off immediately to ops or validate; do not
wait or start another restart. The job resumes this conversation after the node
returns so the next stretch can verify the live result. This is the one
exception to waiting for foreground commands below.

YOUR SESSION ENDS THE MOMENT YOUR TURN ENDS. There is no later: nothing will
re-invoke you, and a background task's completion notification will never reach
you. Never start a background command and end your turn "waiting" for it — run
commands in the foreground and wait them out inside this turn, even long ones.
If something genuinely cannot finish inside this stretch, say exactly that in
the handoff (status partial, next pointing at the duty that should continue)
instead of ending your turn without one.`;

// The card-description fold cap. Above it the loop writes the full text to
// <conversationDir>/card-description.md and the brief points there.
export const DESCRIPTION_FOLD_CAP = 8000;

export function buildStretchBrief({
  conversationId,
  conversationDir,
  summaryText,
  lastHandoffs = [],
  duty,
  level = 1,
  dutyDescription = null,
  skill = null,
  task = null,
  card = null,
  steering = [],
  userMessages = [],
  handoffPath,
  stretchId,
  attempt = 1,
  floorLine = null,
  selectedDuties = [],
  findingsText = "",
  findingsExpectation = null,
  dutyGuidance = null,
  objective = null,
  dutyDescriptions = {},
  recovery = null,
}) {
  const parts = [];
  parts.push(`# Stretch brief — conversation ${conversationId}`);
  parts.push(`Conversation store: ${conversationDir} (log.jsonl is the full record; grep it when you need history)`);
  parts.push("");
  parts.push(summaryText?.trim() || "(no summary yet — you are the first stretch; write the objective into your handoff summary)");
  if (objective) parts.push("", "## Original request (keep this in scope until delivered)", objective);
  if (recovery) parts.push("", "## Interrupted work to resume", recovery);
  if (card) {
    // The card IS the task. The first live run inferred the whole purpose from
    // the TITLE alone and went off to do something else entirely — every brief
    // carries the full card so no stretch ever works from a headline.
    parts.push("", "## The card");
    parts.push(`Title: ${String(card.title ?? "(untitled)").slice(0, 300)}`);
    if (typeof card.description === "string" && card.description.trim()) {
      parts.push("", String(card.description).slice(0, DESCRIPTION_FOLD_CAP));
      // A silently truncated brief is a card the stretch CANNOT do right -
      // live: a 78k-char roadmap brief was cut to 8k, the stretch burned a
      // ledger-fetch trying to recover the rest, and the card parked on
      // "Part B incompletely retrievable". Truncation now says so and points
      // at the whole text.
      if (card.description.length > DESCRIPTION_FOLD_CAP) {
        parts.push(
          "",
          card.descriptionPath
            ? `(the description above is TRUNCATED at ${DESCRIPTION_FOLD_CAP} of ${card.description.length} characters - the FULL text is at ${card.descriptionPath}; Read it before acting on this card)`
            : `(the description above is TRUNCATED at ${DESCRIPTION_FOLD_CAP} of ${card.description.length} characters)`
        );
      }
    }
    if (typeof card.acceptance === "string" && card.acceptance.trim()) {
      parts.push("", `Acceptance: ${String(card.acceptance).slice(0, 2000)}`);
    }
    const files = Array.isArray(card.attachments)
      ? card.attachments.filter((a) => typeof a?.path === "string" && a.path).slice(0, 50)
      : [];
    if (files.length) {
      parts.push("", "Attached files (context for this card - read them with the Read tool; describe an image from its pixels, never from its filename):");
      for (const a of files) parts.push(`- ${a.path}`);
    }
    const items = Array.isArray(card.checklist) ? card.checklist.slice(0, 100) : [];
    if (items.length) {
      parts.push("", "Checklist — the card's concrete asks. Every unchecked item is in scope; do not invent work outside them:");
      for (const it of items) {
        const text = typeof it?.text === "string" ? it.text.slice(0, 1000) : "";
        if (text) parts.push(`- [${it?.done === true ? "x" : " "}] ${text}`);
      }
    }
  }
  if (lastHandoffs.length) {
    parts.push("", "## Recent handoffs (newest last)");
    for (const { ordinal, handoff } of lastHandoffs) {
      parts.push(
        `- #${ordinal} [${handoff.duty}/${handoff.status}] ${String(handoff.summary ?? "").slice(0, ordinal === lastHandoffs.at(-1)?.ordinal ? 4000 : 600)} → next: ${handoff.nextSteps?.next}`
      );
      for (const item of handoff.nextSteps?.items ?? []) parts.push(`  Remaining: ${String(item).slice(0, 1000)}`);
      for (const failed of handoff.failedApproaches ?? []) parts.push(`  Do not repeat: ${failed.approach} — ${failed.why}`);
      for (const ref of handoff.evidenceRefs ?? []) parts.push(`  Evidence: ${ref.ref}${ref.note ? ` — ${ref.note}` : ""}`);
    }
    parts.push(`Older handoffs are under ${path.join(conversationDir, "handoffs")}.`);
  }
  // The findings record from earlier stretches. This is per-task dynamic
  // material and lives HERE, in the message, after the last cache breakpoint -
  // putting it in the system prompt would fork the prefix every stretch and
  // undo cross-stretch cache sharing.
  if (findingsText) parts.push("", findingsText);
  parts.push("", `## Your duty: ${duty} (level ${level}${attempt > 1 ? `, attempt ${attempt}` : ""})`);
  if (dutyDescription) parts.push(dutyDescription);
  if (dutyGuidance) parts.push("", dutyGuidance);
  if (duty === "triage") {
    parts.push("", "Available duties:");
    for (const name of selectedDuties) parts.push(`- ${name}: ${String(dutyDescriptions[name]?.description ?? "").slice(0, 300)}`);
  }
  if (skill) parts.push(`Bound skill: ${skill}`);
  if (task) parts.push("", "## Task", task);
  if (userMessages.length) {
    parts.push("", "## User messages since the last stretch");
    for (const m of userMessages) {
      if (typeof m === "string") {
        parts.push(`- ${m}`);
        continue;
      }
      parts.push(`- ${m.text}`);
      if (m.context) parts.push(`  context: ${m.context}`);
    }
  }
  if (steering.length) {
    parts.push("", "## Steering");
    for (const s of steering) parts.push(`- ${s}`);
  }
  parts.push("", FINDINGS_CONTRACT);
  if (findingsExpectation) parts.push("", findingsExpectation);
  parts.push("", HANDOFF_CONTRACT);
  parts.push("", `handoffPath: ${handoffPath}`);
  parts.push(`stretchId: ${stretchId}`);
  parts.push(`selected duties for "next": ${[...selectedDuties, "done", "needs-input"].join(", ")}`);
  if (floorLine) parts.push(floorLine);
  return parts.join("\n");
}

// ── one stretch ─────────────────────────────────────────────────────────────

function routeFromRung(rung, { effort = null, duty, level }) {
  const params = rung.params && typeof rung.params === "object" ? rung.params : {};
  const target = {
    ...params,
    id: typeof rung.target === "string" ? rung.target : params.id ?? rung.id,
    type: typeof params.type === "string" ? params.type : "runtime-target",
    runtime: rung.runtime,
    provider: rung.provider ?? params.provider ?? undefined,
    model: rung.model,
    effort,
  };
  return { targetId: target.id, target, duty, level };
}

export const STRETCH_TEE_THROTTLE_MS = Number(process.env.GARRISON_STRETCH_TEE_MS) > 0
  ? Number(process.env.GARRISON_STRETCH_TEE_MS)
  : 400;
const TEE_TEXT_CAP = 48_000;

// Cap text blocks so a tee record never crosses the store's 64KB spill
// threshold — a spilled session-event is a pointer the transcript adapter
// cannot render, which would un-fix the very bug the tee fixes. The full
// reply stays durable at payloads/stretch-NNNN-reply.md.
function capSessionEventBlocks(event) {
  const blocks = event.blocks.map((b) =>
    b && typeof b === "object" && typeof b.text === "string" && b.text.length > TEE_TEXT_CAP
      ? { ...b, text: `${b.text.slice(0, TEE_TEXT_CAP)}\n… [truncated for the ledger — full text in the stretch reply payload]` }
      : b
  );
  return { ...event, blocks };
}

/**
 * Tee a stretch's transcript into the conversation store. Without this the
 * store — the single source of truth the UI renders — carries only ledger
 * boundaries, and a conversation reads as "stretch started … handoff row …
 * stretch ended" with the assistant's actual prose reachable nowhere.
 *
 * Agent-sdk lanes hand us rich SessionEvents (text/thinking/tool blocks with
 * stable ids and in-place revisions); exec lanes stream only reply chunks, so
 * `syntheticFromChunks` folds those into ONE synthetic text event. Appends are
 * throttled per event id: the serving layer's SSE polls the log at ~350ms, so
 * revisions faster than that would be invisible anyway — the throttle keeps the
 * append-only log bounded while the viewer still sees the text grow live.
 * `flush()` after the turn makes the final state durable. A tee failure never
 * kills the stretch.
 */
export function makeStretchEventTee(store, { stretchId, duty, syntheticFromChunks = false, throttleMs = STRETCH_TEE_THROTTLE_MS, now = Date.now } = {}) {
  const state = new Map(); // event id -> { latest, dirty, lastAppendedAt }
  let syntheticText = "";
  const record = (event) => {
    try {
      store.append({ kind: "session-event", duty, stretch: stretchId, payload: capSessionEventBlocks(event) });
    } catch {
      /* the transcript tee must never kill the stretch */
    }
  };
  // A block's SHAPE — which blocks exist, whether each has its input yet,
  // whether it failed. Text GROWTH stays throttled (the serve poll hides
  // sub-second deltas anyway), but a shape change must land immediately: the
  // live viewer watching "Bash" with no command for a whole stretch was this
  // throttle holding the completed-input revision until the final flush.
  const shapeOf = (event) =>
    event.blocks
      .map((b) => (b && typeof b === "object"
        ? `${b.type}:${String(b.input ?? "").length > 0 ? 1 : 0}:${b.isError ? 1 : 0}:${b.status ?? ""}:${b.name ?? ""}`
        : "?"))
      .join("|");
  const admit = (event) => {
    if (!event || typeof event !== "object" || typeof event.id !== "string" || !event.id || !Array.isArray(event.blocks)) return;
    // -Infinity so the FIRST snapshot of every event always lands immediately —
    // only subsequent same-shape revisions ride the throttle.
    const entry = state.get(event.id) ?? { latest: null, dirty: false, lastAppendedAt: -Infinity, shape: null };
    entry.latest = event;
    entry.dirty = true;
    const at = now();
    const shape = shapeOf(event);
    if (shape !== entry.shape || at - entry.lastAppendedAt >= throttleMs) {
      record(event);
      entry.lastAppendedAt = at;
      entry.dirty = false;
      entry.shape = shape;
    }
    state.set(event.id, entry);
  };
  return {
    event: admit,
    chunk(text, replace) {
      if (!syntheticFromChunks || typeof text !== "string") return;
      syntheticText = replace ? text : syntheticText + text;
      if (!syntheticText.trim()) return;
      admit({ id: `${stretchId}:reply`, ts: new Date(now()).toISOString(), role: "assistant", blocks: [{ type: "text", text: syntheticText }] });
    },
    flush() {
      for (const entry of state.values()) {
        if (entry.dirty && entry.latest) {
          record(entry.latest);
          entry.dirty = false;
          entry.lastAppendedAt = now();
        }
      }
    },
  };
}

/**
 * Run one stretch: ONE adapter session, warm-keyed fresh for agent-sdk
 * (sessionKey "stretch:<id>" guarantees a fresh spawn; released at exit), a
 * stateless exec spawn for secondary engines. Bounded by a hard timeout that
 * cancels through the adapter's own stop primitive.
 */
export async function runStretch(gateway, {
  route,
  brief,
  stretchId,
  conversationId = null,
  cwd = null,
  turnId = null,
  onChunk = null,
  onEvent = null,
  onUsage = null,
  signal = null,
  timeoutMs = STRETCH_TIMEOUT_MS,
  env = process.env,
}) {
  const started = Date.now();
  let continuity = null;
  let stop = null;
  let partialReply = "";
  let timedOut = false;
  const registerStop = (fn) => {
    stop = fn;
    // Stop can arrive while the runtime is spawning or waiting for its lock.
    // Deliver it as soon as the adapter exposes its cancellation primitive.
    if (signal?.aborted || timedOut) { try { stop?.(); } catch { /* cancellation is best-effort */ } }
  };
  const abort = () => {
    try {
      stop?.();
    } catch {
      /* cancel is best-effort */
    }
  };
  if (signal) signal.addEventListener("abort", abort, { once: true });
  let timer = null;
  try {
    if (signal?.aborted) throw new Error("stretch cancelled before runtime admission");
    const prepared = prepareStretchContinuity({ cwd: cwd ?? gateway.compositionDir, conversationId, stretchId,
      model: route.target.model, runtime: route.target.runtime, duty: route.duty, env, signal });
    continuity = prepared?.then ? await prepared : prepared;
    if (signal?.aborted) throw new Error("stretch cancelled before runtime admission");
    const groundedBrief = [
      continuity.instructions ? `## Enrolled project instructions (local files; preserve override precedence)\n${continuity.instructions}` : "",
      brief,
      continuity.context ? `## Shared project context and peer sessions (cached; verify current evidence)\n${continuity.context}` : "",
    ].filter(Boolean).join("\n\n");
    const onRuntimeAdmission = () => continuity.admit();
    // The separately bounded local cache read precedes the runtime deadline;
    // no timeout promise can reject while its consumer is still preparing.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        abort();
        reject(new Error(`stretch timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const isAgentSdk = route.target.runtime === "agent-sdk";
    const captureChunk = (text, replace) => {
      partialReply = replace ? String(text ?? "") : partialReply + String(text ?? "");
      partialReply = partialReply.slice(-100_000);
      onChunk?.(text, replace);
    };
    const turnPromise = isAgentSdk
      ? gateway.runAgentSdkTurn(route, groundedBrief, captureChunk, {
          sessionKey: `stretch:${stretchId}`,
          turnId: turnId ?? `stretch:${stretchId}`,
          // The stretch's own conversation, so the layer-3 tools default to it
          // instead of making the model quote an id back out of its brief.
          ...(conversationId ? { conversationId } : {}),
          stretchId,
          ...(cwd ? { cwd } : {}),
          onEvent,
          onUsage,
          registerStop,
          onRuntimeAdmission,
        })
      : gateway.runSecondaryTurn(route, groundedBrief, {
          onChunk: captureChunk,
          registerStop,
          signal,
          onRuntimeAdmission,
          ...(cwd ? { cwd } : {}),
          // Stretch identity: the exec lane uses it to mount the Garrison MCP
          // server scoped to this conversation (provider-two step 3). A
          // delegation turn has neither and mounts nothing.
          ...(conversationId ? { conversationId } : {}),
          ...(stretchId ? { stretchId } : {}),
        });
    const result = await Promise.race([turnPromise, timeout]);
    // The exec lane has no streaming seam, so its rows only exist here, on the
    // settled envelope. Hand them to the same sink the agent-sdk lane streams
    // into so both lanes land in the ledger identically.
    //
    // ONLY the exec lane. The agent-sdk lane already streamed each row through
    // onUsage as it happened and also returns them on the envelope; replaying
    // those emitted every row twice and doubled every cost.
    if (!isAgentSdk && typeof onUsage === "function" && Array.isArray(result?.usage)) {
      for (const row of result.usage) onUsage(row);
    }
    return {
      ok: true,
      reply: result?.reply ?? "",
      sessionId: result?.session_id ?? null,
      usage: Array.isArray(result?.usage) ? result.usage : [],
      sdkCostUsd: typeof result?.cost_usd === "number" ? result.cost_usd : null,
      usedTokens: typeof result?.usedTokens === "number" ? result.usedTokens : null,
      costUnknown: typeof result?.usedTokens !== "number",
      model: result?.model ?? route.target.model,
      effortApplied: result?.effortApplied ?? null,
      stoppedReason: result?.stoppedReason ?? null,
      durationMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      reply: partialReply,
      sessionId: null,
      // A timed-out stretch returns no rows, but the ones it already streamed
      // through onUsage are in the ledger — which is precisely why capture is
      // live rather than on settle.
      usage: [],
      sdkCostUsd: null,
      usedTokens: null,
      costUnknown: true,
      model: route.target.model,
      effortApplied: null,
      stoppedReason: signal?.aborted ? "cancelled" : null,
      durationMs: Date.now() - started,
      error: err?.message ?? String(err),
    };
  } finally {
    // Queued local lifecycle events finish independently of model cancellation
    // and never await a Basic Memory or network operation on the turn path.
    void continuity?.finish();
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abort);
    // A stretch dies with its session: the warm pool must never leak prior
    // context into the next stretch (that would silently defeat the concept).
    if (route.target.runtime === "agent-sdk") {
      await gateway.releaseConversationSessions?.(`stretch:${stretchId}`).catch?.(() => {});
    }
  }
}

// ── exit gate ───────────────────────────────────────────────────────────────

export function parseFencedHandoff(reply) {
  const text = String(reply ?? "");
  // Prefer the last corrected handoff. A prose sentence after a JSON fence or
  // an earlier malformed attempt must not trigger another paid model call.
  const candidates = [...text.matchAll(/```(?:handoff|json)\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  if (!candidates.length && text.trim().startsWith("{")) candidates.push(text.trim());
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && parsed.nextSteps && parsed.summary) return parsed;
    } catch { /* try an earlier complete handoff; schema validation still follows */ }
  }
  return null;
}

/**
 * The exit gate. Runs AFTER the session ends, off disk. Order: the handoff
 * file → a fenced JSON block in the reply (written to the file server-side) →
 * ONE bounded in-session re-ask (agent-sdk only; the session is still warm
 * until release) → ONE fresh floor-rung repair call → a synthetic failed
 * handoff routing needs-input. NEVER silently passes.
 */
export async function runExitGate(gateway, {
  store,
  stretchId,
  ordinal,
  duty,
  route,
  reply,
  selectedDuties,
  resolveEvidence = null,
  reAsk = null, // async (prompt) => replyText — injected; null = not resumable
  repair = null, // async (prompt) => replyText — floor-rung one-shot
  runtimeError = null, // the runtime's OWN failure reason (crash, auth, limit)
}) {
  const resolver = resolveEvidence ?? defaultResolveEvidence(gateway.compositionDir);
  const file = store.handoffPath(ordinal);
  let repairs = 0;
  let source = "file";

  const readCandidate = (text = reply) => {
    const fromFile = store.readHandoff(ordinal);
    if (fromFile && validateHandoff(fromFile, { selectedDuties, resolveEvidence: resolver }).ok) return { handoff: fromFile, from: "file" };
    const fromReply = parseFencedHandoff(text);
    if (fromReply) return { handoff: fromReply, from: "reply" };
    if (fromFile) return { handoff: fromFile, from: "file" };
    return { handoff: null, from: "absent" };
  };

  let { handoff, from } = readCandidate();
  source = from;
  let verdict = handoff
    ? validateHandoff(handoff, { selectedDuties, resolveEvidence: resolver })
    : { ok: false, errors: ["handoff absent (no file, no fenced block)"], resolved: [] };

  if (!verdict.ok && typeof reAsk === "function") {
    const allowedNext = [...(selectedDuties ?? []), "done", "needs-input"].join(", ");
    const prompt = `Your handoff is invalid: ${verdict.errors.join("; ")}.\nRewrite the handoff JSON at ${file} (or reply with ONLY a \`\`\`handoff fenced block). Fix every error. Use the EXACT schema from your brief's exit contract - do not invent fields. "nextSteps.next" must be one of: ${allowedNext}. Reply with nothing else.`;
    try {
      const reAskReply = await reAsk(prompt);
      const candidate = readCandidate(reAskReply);
      const again = candidate.handoff;
      if (again) {
        handoff = again;
        source = candidate.from === "file" ? "file" : "re-ask-reply";
        verdict = validateHandoff(handoff, { selectedDuties, resolveEvidence: resolver });
      }
    } catch {
      /* the re-ask is best-effort; the repair path follows */
    }
  }

  if (!verdict.ok && typeof repair === "function") {
    repairs = 1;
    const spill = store.spillPayload({ stretchId, reply: String(reply ?? "").slice(0, 200_000) });
    // A FRESH session repairs this - it has never seen the brief, so the
    // contract travels with the prompt or the repairer cannot know the schema.
    const allowedNext = [...(selectedDuties ?? []), "done", "needs-input"].join(", ");
    const prompt = `A work stretch (duty: ${duty}, stretchId: ${stretchId}) ended without a valid handoff. Errors: ${verdict.errors.join("; ")}.\nFrom the stretch's reply below, write the most honest handoff JSON you can. Do NOT invent evidence: if the reply names no verifiable evidence, evidenceRefs stays []. If the work seems incomplete, status is "partial" and failedApproaches says what fell short. "nextSteps.next" must be one of: ${allowedNext}. Reply with ONLY a \`\`\`handoff fenced block. Do not use tools or continue the task.\n\n${HANDOFF_CONTRACT}\n\nSTRETCH REPLY (may be truncated; full copy at ${spill.ref}):\n${String(reply ?? "").slice(0, 20_000)}`;
    try {
      const repairReply = await repair(prompt);
      const again = parseFencedHandoff(repairReply);
      if (again) {
        handoff = again;
        source = "repair";
        verdict = validateHandoff(handoff, { selectedDuties, resolveEvidence: resolver });
      }
    } catch {
      /* fall through to synthesis */
    }
  }

  let synthesized = false;
  if (!verdict.ok || !handoff) {
    synthesized = true;
    source = "synthesized";
    handoff = {
      v: 1,
      stretchId,
      duty,
      status: "failed",
      // Contract rule 2: when the RUNTIME died (crash, auth expiry, usage
      // limit, timeout), the reason the reader needs is the runtime's own -
      // "codex exec exited 1: You've hit your usage limit" - not the generic
      // no-handoff line. writeCardTransition copies this blocker onto the
      // card, so the card wears the real reason too.
      summary: runtimeError
        ? `The stretch runtime failed: ${String(runtimeError).slice(0, 300)}. Findings recorded before the failure are kept.`
        : `The stretch ended without a valid handoff (${(verdict.errors ?? []).join("; ") || "no output"}). Raw reply preserved in payloads/.`,
      evidenceRefs: [],
      nextSteps: { next: "needs-input", why: "the exit gate could not extract an honest handoff", items: [] },
      blocker: runtimeError
        ? { what: `${duty} stretch runtime failed: ${String(runtimeError).slice(0, 250)}`, needs: "a human decision - retry, reroute, or park", who: "user" }
        : { what: "no valid handoff from the stretch", needs: "a human look at the conversation log", who: "user" },
      activeConstraints: [],
      failedApproaches: [{ approach: `run duty ${duty} as a stretch`, why: "no valid handoff produced" }],
      surprises: [],
      forceEscalation: null,
      synthesized: true,
    };
    verdict = validateHandoff(handoff, { selectedDuties, resolveEvidence: resolver });
  }

  // Normalise identity fields the model may have fumbled — identity comes from
  // the launcher, honesty comes from the model.
  handoff.v = 1;
  handoff.stretchId = stretchId;
  handoff.duty = duty;
  handoff.synthesized = synthesized;
  store.writeHandoff(ordinal, handoff);

  return { handoff, valid: verdict.ok, errors: verdict.errors, resolved: verdict.resolved, repairs, synthesized, source };
}

// ── summary application ─────────────────────────────────────────────────────

export function applyHandoffToSummary(parsed, handoff, { floorUpdate = null } = {}) {
  const next = { ...(parsed ?? {}) };
  next.title = next.title || "Conversation";
  next.objective = next.objective || "";
  next.currentState = `${handoff.duty}/${handoff.status}: ${String(handoff.summary).slice(0, 1200)}`;
  next.decisions = [...(next.decisions ?? [])];
  // A handoff's nextSteps.why is the decision trail worth keeping.
  if (handoff.nextSteps?.why) {
    next.decisions.push(`${handoff.duty} → ${handoff.nextSteps.next}: ${String(handoff.nextSteps.why).slice(0, 200)}`);
  }
  // Active constraints are the CURRENT set, not a log — the handoff replaces.
  if (Array.isArray(handoff.activeConstraints) && handoff.activeConstraints.length) {
    next.activeConstraints = handoff.activeConstraints.map((c) => String(c).slice(0, 200));
  } else {
    next.activeConstraints = next.activeConstraints ?? [];
  }
  next.escalationFloor = { ...(next.escalationFloor ?? {}) };
  if (floorUpdate) {
    next.escalationFloor[floorUpdate.duty] = {
      duty: floorUpdate.duty,
      rung: floorUpdate.rung,
      raisedAt: floorUpdate.raisedAt,
      reason: floorUpdate.reason,
    };
  }
  return next;
}

// ── card writes (board HTTP, engine context, rev-refresh retries) ───────────

export async function patchCardEngine({ id, patch, logFn = () => {} }) {
  const base = boardBase();
  if (!base || !id) return { ok: false, error: "no-board" };
  // Every failure mode below must RETRY and, on giving up, LOG WITH DETAIL.
  // The first version let a thrown fetch (board momentarily unreachable)
  // escape the retry loop to an outer catch that neither retried nor logged —
  // a one-instant blip became a silent single-attempt failure, which is
  // exactly how a finished conversation's park write vanished without a trace
  // (card 01M106TB…, 2026-08-27).
  let lastError = "board-patch-failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let rev = 0;
      try {
        const fresh = await fetch(`${base}/cards/${id}`);
        if (fresh.ok) {
          const doc = await fresh.json();
          rev = doc.card?.rev ?? doc.rev ?? 0;
        }
      } catch {
        /* retry with rev 0 */
      }
      const res = await fetch(`${base}/cards/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
        body: JSON.stringify({ ...patch, rev }),
      });
      if (res.ok) return { ok: true };
      const body = await res.text().catch(() => "");
      lastError = `HTTP ${res.status}: ${body.slice(0, 300)}`;
    } catch (err) {
      lastError = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  logFn({ kind: "conversation-card-patch-failed", id, error: lastError, patch: Object.keys(patch).join(",") });
  return { ok: false, error: lastError };
}

async function writeCardTransition(gateway, { cardId, conversationId, stretchId, phase, handoff = null, duty = null }) {
  if (!cardId) return;
  const workCard = await cardById(cardId).catch(() => null);
  if (workCard?.origin?.type === "workSession") {
    if (phase === "started") await resumeSessionCard(conversationId).catch(reportCardHook);
    await syncWorkSessionTitle(conversationId).catch(reportCardHook);
    return;
  }
  const logFn = (e) => gateway.logFn?.(e);
  if (duty === "responder") {
    // The responder used to leave the card untouched, so a message on a done
    // card was answered by a card that showed no sign of working. Now the card
    // is on Running while the responder works - same as any stretch - and
    // settles where the responder's handoff points: back to done after a
    // question, to needs-attention when it is still parked, or on to the duty
    // a follow-up asked for (whose own start keeps it running).
    if (phase === "started") {
      await patchCardEngine({ id: cardId, patch: { conversationId, list: "running", status: "running", runningSince: new Date().toISOString(), awaitingApproval: null }, logFn });
      return;
    }
    const next = handoff?.nextSteps?.next;
    const reply = String(handoff?.summary ?? "").slice(0, 600);
    if (next === "done") {
      await patchCardEngine({ id: cardId, patch: { list: "done", status: "ok", ...(reply ? { lastReply: reply } : {}) }, logFn });
    } else if (next === "needs-input" || phase === "error") {
      const reason = handoff?.blocker
        ? `${handoff.blocker.what} — needs: ${handoff.blocker.needs}`
        : (handoff?.summary ?? "responder error");
      await patchCardEngine({ id: cardId, patch: { list: "needs-attention", status: "needs-attention", attentionReason: String(reason).slice(0, 400) }, logFn });
    } else if (next) {
      await patchCardEngine({ id: cardId, patch: { status: "ok", duty: next, ...(reply ? { lastReply: reply } : {}) }, logFn });
    }
    return;
  }
  if (phase === "started") {
    // A starting stretch consumes any standing approval ask — the approval
    // arrived (or Autonomous was flipped), so the card must stop wearing it.
    await patchCardEngine({ id: cardId, patch: { conversationId, list: "running", status: "running", runningSince: new Date().toISOString(), awaitingApproval: null }, logFn });
    return;
  }
  const next = handoff?.nextSteps?.next;
  if (next === "done") {
    await patchCardEngine({ id: cardId, patch: { list: "done", status: "ok", terminalSummary: String(handoff.summary).slice(0, 600), lastReply: String(handoff.summary).slice(0, 600) }, logFn });
  } else if (next === "needs-input" || phase === "error") {
    const reason = handoff?.blocker
      ? `${handoff.blocker.what} — needs: ${handoff.blocker.needs}`
      : (handoff?.summary ?? "stretch error");
    await patchCardEngine({ id: cardId, patch: { list: "needs-attention", status: "needs-attention", attentionReason: String(reason).slice(0, 400) }, logFn });
  } else if (next) {
    await patchCardEngine({ id: cardId, patch: { status: "ok", duty: next, lastReply: String(handoff?.summary ?? "").slice(0, 600) }, logFn });
  }
}

// ── the conversation loop ───────────────────────────────────────────────────

function unconsumedUserMessages(store) {
  const all = store.tail(200, { kinds: ["user-message", "handoff", "messages-consumed"] });
  // Only a BUILT BRIEF consumes a message. The old rule ("older than the last
  // handoff") silently ate any message that arrived while a stretch was
  // running: the stretch's own handoff outranked it though no brief ever
  // carried it - live, a mid-stretch "hand off to implement" directive
  // vanished exactly this way. The loop stamps a messages-consumed high-water
  // mark at every brief build; conversations from before the stamp fall back
  // to the handoff rule.
  const lastConsumed = all.reduce(
    (acc, e) => (e.kind === "messages-consumed" ? Math.max(acc, Number(e.payload?.throughIndex ?? -1)) : acc),
    -1
  );
  // A steered handoff is written AFTER the message that caused it, so under
  // the pre-stamp rule it would eat exactly the message it exists to carry.
  const lastHandoffIdx = all.reduce((acc, e) => (e.kind === "handoff" && e.payload?.steered !== true ? e.index : acc), -1);
  const hwm = lastConsumed >= 0 ? lastConsumed : lastHandoffIdx;
  return all
    .filter((e) => e.kind === "user-message" && e.index > hwm)
    .map((e) => ({
      index: e.index,
      text: String(e.payload?.text ?? ""),
      context: typeof e.payload?.context === "string" ? e.payload.context : null,
      routing: e.payload?.routing && typeof e.payload.routing === "object" && !Array.isArray(e.payload.routing) ? e.payload.routing : null,
    }))
    .filter((m) => m.text);
}

/** The newest unconsumed message that carries a routing pin decides the rung.
 *  A pin naming something OFF this duty's ladder pins nothing — resolveRung's
 *  normal precedence answers instead (an explicit-but-alien pin must not
 *  silently pick the floor). */
function pinnedRungFor(messages, ladder) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const routing = messages[i]?.routing;
    if (!routing) continue;
    if (typeof routing.rung === "string" && ladder.rungs.some((r) => r.id === routing.rung)) return routing.rung;
    if (typeof routing.target === "string") {
      const hit = ladder.rungs.find((r) => r.target === routing.target);
      if (hit) return hit.id;
    }
    if (typeof routing.model === "string") {
      const hit = ladder.rungs.find((r) => r.model === routing.model);
      if (hit) return hit.id;
    }
    return null;
  }
  return null;
}

// Duties that OPEN or STEER work rather than doing it. A non-autonomous card
// may run these freely; the first duty outside this set is the moment the
// conversation starts changing things, and that is where the approval gate sits.
export const PLANNING_DUTIES = new Set(["triage", "plan", "responder", "dispatch"]);

/** The Autonomous gate, as a pure predicate over (store, card, duty). */
export function shouldPauseForApproval(store, card, duty) {
  if (!card || card.autonomous === true) return false;
  if (PLANNING_DUTIES.has(duty)) return false;
  return !approvalState(store).approved;
}

/** Has the user approved going ahead since the launcher last asked?
 *  Approval is a user message AFTER the newest approval-requested record —
 *  the original task text (recorded before any ask) never auto-approves. */
export function approvalState(store) {
  const tail = store.tail(400, { kinds: ["user-message", "approval-requested"] });
  let lastAsk = -1;
  let lastMsg = -1;
  for (const e of tail) {
    if (e.kind === "approval-requested") lastAsk = e.index;
    else lastMsg = e.index;
  }
  return { asked: lastAsk >= 0, approved: lastAsk >= 0 && lastMsg > lastAsk };
}

function nextDutyFor(store, selectedDuties) {
  const handoffs = store.tail(1, { kinds: ["handoff"] });
  if (!handoffs.length) {
    return selectedDuties.includes("triage") ? "triage" : (selectedDuties[0] ?? "other");
  }
  const next = handoffs[0].payload?.nextSteps?.next ?? "needs-input";
  // A user message on an otherwise-settled conversation wakes the RESPONDER:
  // it answers from L1, its commitments land in the summary, and the
  // conversation settles again. It never re-opens the work by itself.
  if (CONVERSATION_FLOW.terminal.includes(next) && selectedDuties.includes("responder")) {
    if (unconsumedUserMessages(store).length) return "responder";
  }
  return next;
}

function consecutiveSameDuty(store, duty) {
  const tail = store.tail(10, { kinds: ["handoff"] });
  let n = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].duty !== duty) break;
    // A steered stretch re-runs its duty as a continuation, not a retry.
    if (tail[i].payload?.steered === true) continue;
    n += 1;
  }
  return n;
}

/**
 * Drive a conversation forward, stretch by stretch, until a terminal state,
 * the cap, or cancellation. Runs on `gateway._onLane("conversation:"+id)` —
 * OFF the serialized operative turn chain, so a 20-minute implement stretch
 * never wedges web chat.
 *
 * onFrame(name, data) mirrors the /chat/stream vocabulary for SSE relays.
 */
/**
 * Where a card's stretches EXECUTE. Explicit routing.project wins, then the
 * card's own project, then the personal token for a personal-scope card —
 * the same precedence the board's cardTurnRouting encoded. The label resolves
 * through resolveRunScope (wire-safe: dev-root child names + the exact
 * personal token, nothing else), so a hostile card body can never name an
 * arbitrary cwd. Returns { label, cwd, degraded }: `degraded` means a project
 * WAS specified but did not resolve on this machine — the stretch then runs in
 * the composition dir and the stretch-started payload says so, because
 * silently running project work in the wrong directory is the exact incident
 * tests/kanban-turn-cwd.test.ts was written for.
 */
// Strict project resolution (2026-08-31). A card that names a project which
// does not resolve on this machine used to fall back to the composition
// directory and run there anyway: the stretch worked, wrote files, and reported
// success in a tree nobody asked it to touch. That is silent, and the damage is
// only visible afterwards. Strict mode refuses to start instead.
//
// ON by default. Set the gateway fitting's `strict_project_resolution` to false
// (env GARRISON_HTTPGATEWAY_STRICT_PROJECT_RESOLUTION=false) to restore the old
// fallback, which is the revert path rather than a supported mode.
export function strictProjectResolution(env = process.env) {
  const raw = String(env?.GARRISON_HTTPGATEWAY_STRICT_PROJECT_RESOLUTION ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false;
  return true;
}

// The rule the resolver actually enforces, in one sentence, so the ledger entry
// tells a reader what to fix rather than only that something failed.
export const PROJECT_RESOLUTION_RULE =
  "a project label must name a directory containing .git directly under the dev-root " +
  "(~/.garrison/dev-root, default ~/dev) - no path separators, no absolute paths, no " +
  "dotfiles, and nothing whose realpath leaves the dev-root. The only other accepted " +
  "scope is the exact token @personal.";

/** The ledger record for a project that did not resolve here: what was asked
 *  for, what it resolved to, where the old fallback would have run it, and the
 *  rule that rejected it. */
export function projectResolutionFailure(scope, { compositionDir = null, devRoot = null } = {}) {
  return {
    reason: "project-not-resolvable-here",
    requestedProject: scope?.label ?? null,
    resolvedPath: scope?.cwd ?? null,
    fallbackPath: compositionDir ?? null,
    devRoot: devRoot ?? null,
    rule: PROJECT_RESOLUTION_RULE,
    knownProjects: (() => {
      try { return listProjectNames().slice(0, 60); } catch { return []; }
    })(),
    message:
      `project ${JSON.stringify(scope?.label ?? null)} resolved to ${scope?.cwd ?? "nothing"} on this machine. ` +
      `The stretch was NOT started; running it would have used ${compositionDir ?? "the composition directory"} instead. ` +
      `Rule: ${PROJECT_RESOLUTION_RULE}`,
  };
}

export function stretchScopeForCard(card) {
  if (!card) return { label: null, cwd: null, degraded: false };
  const routing = card.routing && typeof card.routing === "object" && !Array.isArray(card.routing) ? card.routing : {};
  const explicit = typeof routing.project === "string" && routing.project.trim() ? routing.project.trim() : null;
  const own = typeof card.project === "string" && card.project.trim() ? card.project.trim() : null;
  const label = explicit ?? own ?? (card.scope === "personal" ? PERSONAL_SCOPE_TOKEN : null);
  if (!label) return { label: null, cwd: null, degraded: false };
  const cwd = resolveRunScope(label);
  return { label, cwd, degraded: !cwd };
}

/** The closing record every downstream number is built from. `cost_usd` is OUR
 *  arithmetic over the rate table; `sdkCostUsd` is what the provider's own SDK
 *  reported for the same calls. Kept apart on purpose - a divergence beyond a
 *  rounding margin means the table or the parsing is wrong, and averaging the
 *  two would hide exactly that. One builder, so a steered stretch and a gated
 *  one leave the same shape behind. */
function stretchEndedPayload({ stretchId, ordinal, duty, route, result, usageRows, outcome, stoppedReason, replyRef, summaryWrite, next }) {
  const usageAgg = aggregateUsageRows(usageRows);
  const priced = priceAggregate(usageAgg, { fallbackModel: result.model ?? route.target.model });
  return {
    stretchId,
    ordinal,
    duty,
    provider: route.target.provider ?? null,
    runtime: route.target.runtime ?? null,
    target: route.targetId ?? null,
    effort: route.target.effort ?? null,
    apiCalls: usageAgg.apiCalls,
    inputTokens: usageAgg.usage.inputTokens,
    outputTokens: usageAgg.usage.outputTokens,
    cacheWriteTokens: usageAgg.usage.cacheWrite5mTokens + usageAgg.usage.cacheWrite1hTokens,
    cacheWrite5mTokens: usageAgg.usage.cacheWrite5mTokens,
    cacheWrite1hTokens: usageAgg.usage.cacheWrite1hTokens,
    cacheReadTokens: usageAgg.usage.cacheReadTokens,
    usageBasis: usageAgg.basis,
    usageSources: usageAgg.sources,
    ttlSplit: usageAgg.ttlSplit,
    subagentsInvisible: usageAgg.subagentsInvisible,
    byModel: usageAgg.byModel,
    cost_usd: priced.usd,
    costUnpricedReason: priced.reason,
    sdkCostUsd: usageAgg.sdkCostUsd ?? result.sdkCostUsd ?? null,
    outcome,
    usedTokens: result.usedTokens,
    costUnknown: result.costUnknown,
    durationMs: result.durationMs,
    model: result.model,
    effortApplied: result.effortApplied,
    stoppedReason,
    error: result.error,
    handoffRef: `handoffs/${String(ordinal).padStart(4, "0")}.json`,
    replyRef,
    summaryWrite,
    next,
  };
}

export async function runConversation(gateway, {
  conversationId,
  task = null,
  maxStretches = MAX_STRETCHES_DEFAULT,
  signal = null,
  onFrame = () => {},
  env = process.env,
} = {}) {
  return gateway._onLane(`conversation:${conversationId}`, async () => {
    const store = openConversation(conversationId, { role: "gateway", env });
    store.init({ title: task ? String(task).slice(0, 80) : "Conversation" });
    let ownedStretchId = null;
    let ownsWorkLifecycle = false;
    try {
    if (deploymentInFlight(store)) return { stretches: 0, terminal: "deploying" };
    if (store.currentStretch()) return { stretches: 0, terminal: "already-running" };
    ownsWorkLifecycle = true;
    const recovered = recoverInterruptedStretch(store);
    // The opening task IS the first user message — one vocabulary, one record.
    if (task && store.count("user-message") === 0) {
      recordUserMessage(store, { text: task, origin: "advance" });
    }
    const model = await gateway.executionModel();
    const selectedDuties = model?.selectedDuties ?? [];
    const card = await cardById(conversationId).catch(() => null);
    let scope = stretchScopeForCard(card);
    if (!card) {
      const previous = store.tail(1, { kinds: ["stretch-started"] })[0]?.payload;
      if (previous?.cwd && previous?.project) scope = { cwd: previous.cwd, label: previous.project, degraded: false };
    }
    const objective = card ? null : originalRequest(store);
    const summary = store.parseSummary() ?? {};
    if (objective && summary.objective !== objective.slice(0, 1800)) {
      summary.objective = objective.slice(0, 1800);
      summary.title = summary.title === "Conversation" ? objective.split("\n")[0].slice(0, 100) : summary.title;
      store.writeSummary(summary);
    }
    if (recovered?.parked) {
      await writeCardTransition(gateway, { cardId: card?.id, conversationId, stretchId: recovered.start.stretch,
        phase: "error", handoff: recovered.handoff, duty: recovered.start.duty });
      return { stretches: 0, terminal: "needs-input" };
    }
    if (scope.degraded) {
      const failure = projectResolutionFailure(scope, {
        compositionDir: gateway.compositionDir ?? null,
        devRoot: (() => { try { return readDevRoot(); } catch { return null; } })(),
      });
      if (strictProjectResolution(env)) {
        // Hard failure: no stretch starts. Working in the composition directory
        // because a project label did not resolve is not a degraded run, it is
        // the wrong run - and it is only ever noticed after the writes land.
        store.append({ kind: "project-unresolved", payload: failure });
        if (card?.id) {
          await patchCardEngine({
            id: card.id,
            patch: {
              list: "needs-attention",
              status: "needs-attention",
              attentionReason: String(failure.message).slice(0, 400),
            },
            logFn: (e) => gateway.logFn?.(e),
          });
        }
        gateway.logFn?.({ kind: "conversation-project-unresolved", conversationId, project: scope.label });
        onFrame("done", { terminal: "needs-input", stretches: 0 });
        return { stretches: 0, terminal: "needs-input" };
      }
      // Legacy fallback, reachable only with strict_project_resolution off: say
      // so in the ledger and run in the composition dir anyway.
      store.append({ kind: "policy-rewrite", payload: { from: `project:${scope.label}`, to: "composition-dir", reason: "project-not-resolvable-here" } });
    }
    const runId = env.GARRISON_SESSION_LOG_RUN ?? null;
    let stretches = 0;
    let terminal = null;

    while (stretches < maxStretches) {
      if (deploymentInFlight(store)) { terminal = "deploying"; break; }
      if (signal?.aborted) {
        terminal = "cancelled";
        break;
      }
      const pendingMessages = unconsumedUserMessages(store);
      // Cards keep their own run configuration and flow. A plain Talk thread
      // has no card, so its explicitly pinned message is its run context.
      const messagePins = !card
        ? Object.assign({}, ...pendingMessages.map((message) => message.routing ?? {}))
        : {};
      const rejectPins = (rejected) => {
        const text = `The conversation did not start: ${rejected.map(({ field, reason }) => `${field}: ${reason}`).join("; ")}. Update the run settings and send again.`;
        if (pendingMessages.length) store.append({ kind: "messages-consumed", payload: {
          throughIndex: Math.max(...pendingMessages.map((message) => message.index ?? -1)), count: pendingMessages.length,
        } });
        store.append({ kind: "routing-rejected", payload: { rejected } });
        // Notes are a rendered part of the conversation contract. A custom
        // diagnostic event alone would leave a refused turn invisible.
        store.append({ kind: "note", payload: { text, origin: "gateway" } });
      };
      const supportedPins = new Set(["target", "model", "effort", "duty", "level", "project", "account", "rung"]);
      const invalidPins = Object.entries(messagePins)
        .filter(([field, value]) => value != null && value !== "" && !supportedPins.has(field))
        .map(([field]) => ({ field, reason: "unsupported for a conversation" }));
      for (const [field, value] of Object.entries(messagePins)) {
        if (field !== "level" && supportedPins.has(field) && value != null && typeof value !== "string") {
          invalidPins.push({ field, reason: "must be text" });
        }
      }
      if (messagePins.duty && !selectedDuties.includes(messagePins.duty)) invalidPins.push({ field: "duty", reason: "duty-not-selected" });
      if (messagePins.level != null && (!Number.isInteger(messagePins.level) || messagePins.level < 1 || messagePins.level > 9)) {
        invalidPins.push({ field: "level", reason: "level must be an integer from 1 to 9" });
      }
      if (invalidPins.length) {
        rejectPins(invalidPins);
        terminal = "needs-input";
        break;
      }
      const duty = messagePins.duty || nextDutyFor(store, selectedDuties);
      if (CONVERSATION_FLOW.terminal.includes(duty)) {
        terminal = duty;
        break;
      }
      if (!selectedDuties.includes(duty)) {
        store.append({ kind: "policy-rewrite", duty, payload: { from: duty, to: "needs-input", reason: "duty-not-selected" } });
        terminal = "needs-input";
        break;
      }

      // The Autonomous gate. OFF (the default) means: plan freely, but STOP
      // before the first duty that changes things and ask. Any reply in the
      // conversation approves (Start alone re-asks); the gate asks ONCE per
      // conversation — after an approval it never re-arms.
      if (shouldPauseForApproval(store, card, duty)) {
        {
          const lastHandoff = store.tail(1, { kinds: ["handoff"] })[0]?.payload ?? null;
          store.append({
            kind: "approval-requested",
            duty,
            payload: { next: duty, plan: lastHandoff?.summary ?? null, items: lastHandoff?.nextSteps?.items ?? [] },
          });
          // The card STAYS on To do wearing the ask — awaiting approval is not
          // a blocked state, it is work ready to go the moment the human nods.
          // The field carries what the board needs to render a one-look
          // decision: the next duty, the plan summary, and its first items.
          await patchCardEngine({
            id: card.id,
            patch: {
              list: "todo",
              status: "ok",
              awaitingApproval: {
                next: duty,
                plan: typeof lastHandoff?.summary === "string" ? lastHandoff.summary.slice(0, 1200) : null,
                items: (Array.isArray(lastHandoff?.nextSteps?.items) ? lastHandoff.nextSteps.items : [])
                  .slice(0, 6).map((item) => String(item).slice(0, 200)),
                at: new Date().toISOString(),
              },
            },
            logFn: (e) => gateway.logFn?.(e),
          });
          onFrame("approval-requested", { next: duty });
          terminal = "awaiting-approval";
          break;
        }
      }

      const level = messagePins.level ?? (Number(card?.level) >= 1 ? Number(card.level) : 1);
      const ladder = await ladderForDuty(gateway, duty, level);
      if (!ladder) {
        store.append({ kind: "stretch-ended", duty, payload: { outcome: "error", error: `no route for duty ${duty}` } });
        terminal = "needs-input";
        break;
      }
      const summaryParsed = store.parseSummary() ?? {};
      const floorRungId = summaryParsed.escalationFloor?.[duty]?.rung ?? null;
      const lastHandoff = store.tail(1, { kinds: ["handoff"] })[0]?.payload ?? null;
      const forced = lastHandoff?.forceEscalation ?? false;
      const wire = tripwires(store, { duty });
      const rungPick = resolveRung({
        ladder,
        floorRungId,
        forced,
        tripwire: wire.fires,
        pinRungId: pinnedRungFor(pendingMessages, ladder),
      });
      if (!rungPick) {
        terminal = "needs-input";
        break;
      }

      // Effort comes from the duty LEVEL cell (rung supplies identity only).
      const baseRoute = await gateway.executionRouteFor({ duty, level });
      const effort = baseRoute?.target?.effort ?? null;
      let route = applyDutyHarnessProfile(
        ladder.ladder === "synthetic" && baseRoute
          ? baseRoute
          : routeFromRung(rungPick.rung, { effort, duty, level }),
        duty
      );

      // Provider-two step 4: the routing table. Per duty, an ORDERED list of
      // routes (provider, account, model, effort); the first entry is the
      // default and the router stays there, moving down only on a cooling
      // account (a prior rate/usage limit), a capability the duty requires
      // that a row lacks, or an explicit `route: <id>` in the brief. The
      // table refines only the DEFAULT lane - a pin, tripwire, or forced
      // escalation is an explicit choice and keeps today's path untouched.
      // No table file, no change. Step 5 rides the same walk: a review duty
      // avoids the model family implement last ran on, whenever the table
      // has another family to offer.
      let tableDecision = null;
      if (
        routingTableEnabled(env) &&
        (rungPick.chosenBy === "default" || rungPick.chosenBy === "floor")
      ) {
        const table = readRoutingTable(gateway.compositionDir);
        if (table?.error) gateway.logFn?.({ kind: "routing-table-invalid", error: table.error });
        const rows = table?.duties?.[duty];
        if (Array.isArray(rows) && rows.length) {
          // Step 5: what family did the work under review run on? The most
          // recent routed stretch of a WORKING duty is the thing a review is
          // reading - responders are excluded along with review duties, or a
          // haiku responder answering "resume" between implement and review
          // re-anchors the family check to itself (live: it steered the
          // rerouted review onto the SAME family implement used).
          const lastWorked = REVIEW_DUTIES.has(duty)
            ? store
                .tail(50, { kinds: ["stretch-routing"] })
                .filter((e) => e.duty && !REVIEW_DUTIES.has(e.duty) && e.duty !== "responder" && e.payload?.model)
                .slice(-1)[0] ?? null
            : null;
          const avoidFamily = lastWorked ? modelFamily(lastWorked.payload.model) : null;
          tableDecision = pickRoute({
            rows,
            duty,
            briefText: briefTextFor(store, card),
            avoidFamily,
            env,
          });
          if (tableDecision) {
            route = applyRouteRow(route, tableDecision.row);
            tableDecision = { ...tableDecision, coolingMinutes: table.coolingMinutes };
          } else {
            gateway.logFn?.({ kind: "routing-table-exhausted", duty, conversationId });
          }
        }
      }

      let pinDecision = null;
      if (Object.keys(messagePins).length) {
        // Reuse the gateway's existing target/account/project validators and
        // route overlay. This is the same seam the chat lane uses; a target
        // can be any configured target, not only a rung of the default ladder.
        const overridePins = Object.fromEntries(Object.entries(messagePins).filter(([field]) =>
          ["target", "model", "effort", "project", "account"].includes(field)));
        pinDecision = !Object.keys(overridePins).length ? { applied: [], rejected: [] }
          : typeof gateway._applyOverride === "function"
            ? gateway._applyOverride(route, overridePins)
            : { applied: [], rejected: [{ field: "routing", reason: "the gateway cannot apply conversation pins" }] };
        if (pinDecision.rejected?.length) {
          rejectPins(pinDecision.rejected);
          terminal = "needs-input";
          break;
        }
        if (Object.hasOwn(messagePins, "project")) {
          scope = { label: pinDecision.project ?? null, cwd: pinDecision.projectPath ?? null, degraded: false };
        }
        route = applyDutyHarnessProfile(route, duty);
      }
      const stretchId = `st_${newConversationId()}`;
      const ordinal = store.nextHandoffOrdinal();
      const handoffPath = store.handoffPath(ordinal);

      // A raised floor is sticky per conversation, recorded in L1 (and again
      // as an event — a corrupted L1 is rebuildable from the log).
      let floorUpdate = null;
      if ((wire.fires || forced) && rungPick.index > (rungPick.floorIndex ?? 0)) {
        floorUpdate = {
          duty,
          rung: rungPick.rung.id,
          raisedAt: new Date().toISOString(),
          reason: rungPick.chosenWhy ?? wire.fires ?? "forced",
        };
        store.append({
          kind: "escalation",
          duty,
          stretch: stretchId,
          payload: { from: floorRungId ?? "default", to: rungPick.rung.id, reason: floorUpdate.reason, chosenBy: rungPick.chosenBy },
        });
      }

      // Stale marker from a crashed run: this lane is the only stretch driver
      // for the conversation, so a marker nobody in-process owns is stale.
      if (!store.claimStretch(stretchId)) {
        // Sweep dead holders, but never steal a live process's marker.
        const holder = store.currentStretch();
        if (holder) { terminal = "already-running"; break; }
        if (!store.claimStretch(stretchId)) {
          terminal = "error";
          break;
        }
      }
      ownedStretchId = stretchId;

      const startedPayload = {
        stretchId,
        ordinal,
        duty,
        level,
        rung: { ladder: ladder.ladder ?? "standard", id: rungPick.rung.id, index: rungPick.index },
        target: {
          id: route.targetId,
          runtime: route.target.runtime,
          provider: route.target.provider ?? null,
          model: route.target.model,
          effort: route.target.effort ?? null,
        },
        chosenBy: pinDecision?.applied?.length || messagePins.duty || messagePins.level ? "pin" : rungPick.chosenBy,
        chosenWhy: pinDecision?.applied?.length || messagePins.duty || messagePins.level ? "requested conversation run settings" : rungPick.chosenWhy,
        floorBefore: floorRungId,
        floorAfter: floorUpdate?.rung ?? floorRungId,
        notify: rungPick.notify,
        attempt: consecutiveSameDuty(store, duty) + 1,
        cardId: card?.id ?? null,
        project: scope.label,
        cwd: scope.cwd,
        cwdDegraded: scope.degraded,
      };
      store.append({ kind: "stretch-started", duty, stretch: stretchId, runId, payload: startedPayload });
      runLog()?.append({ domain: "lifecycle", kind: "stretch", turn: stretchId, payload: { conversationId, stretchId, duty, target: route.targetId } });
      onFrame("stretch-started", startedPayload);
      if (rungPick.notify === "top-tier") {
        gateway.logFn?.({ kind: "conversation-top-tier", conversationId, duty, model: route.target.model });
        onFrame("notification", { kind: "top-tier", duty, model: route.target.model });
      }
      // Routing provenance. Assignment is static per duty today, so every
      // reason is "default"; this line is what a router will later be built
      // and measured against, and it must exist before the router does.
      store.append({
        kind: "stretch-routing",
        stretch: stretchId,
        duty,
        payload: {
          provider: route.target.provider ?? null,
          account: route.target.account ?? null,
          model: route.target.model ?? null,
          effort: route.target.effort ?? null,
          runtime: route.target.runtime ?? null,
          target: route.targetId ?? null,
          // The step-4 router extends this line rather than inventing a new
          // one: reason says WHY this route ("default", "brief-route",
          // "cooling until <ts>", "capability:<x>", "cross-family"), and
          // table carries what was skipped on the way down.
          reason: pinDecision?.applied?.length || messagePins.duty || messagePins.level ? "turn-override" : tableDecision?.reason ?? "default",
          ...(pinDecision ? { overridesApplied: [...(messagePins.duty ? ["duty"] : []), ...(messagePins.level ? ["level"] : []), ...pinDecision.applied] } : {}),
          ...(tableDecision
            ? { table: { index: tableDecision.index, id: tableDecision.row?.id ?? null, skipped: tableDecision.skipped } }
            : {}),
        },
      });
      await writeCardTransition(gateway, { cardId: card?.id, conversationId, stretchId, phase: "started", duty });

      // Deterministic concatenation of what earlier stretches recorded, with
      // every anchor rechecked against the tree the stretch will actually work
      // in. No model in this path.
      // The card is re-read for THIS stretch's brief (the duty-list engine
      // re-listed attachments per dispatch): a file attached or a checklist
      // edited mid-conversation reaches the next stretch, not the next
      // conversation. Flag off restores the stale single-read card, whole.
      let briefCard = !card
        ? card
        : cardAttachmentsEnabled(env)
          ? (await cardById(conversationId).catch(() => null)) ?? card
          : { ...card, attachments: [] };
      if (typeof briefCard?.description === "string" && briefCard.description.length > DESCRIPTION_FOLD_CAP) {
        const fullPath = path.join(store.dir, "card-description.md");
        try {
          fs.writeFileSync(fullPath, briefCard.description, "utf8");
          briefCard = { ...briefCard, descriptionPath: fullPath };
        } catch {
          /* the brief still says it is truncated, just without a pointer */
        }
      }
      const composedFindings = composeFindings(
        store.range({ fromIndex: 0, limit: 200_000 }).events,
        { cwd: scope.cwd ?? gateway.compositionDir, conversationId }
      );
      const brief = buildStretchBrief({
        conversationId,
        conversationDir: store.dir,
        findingsText: composedFindings.text,
        summaryText: store.readSummary(),
        lastHandoffs: store.lastHandoffs(3),
        duty,
        level,
        dutyDescription: model?.duties?.[duty]?.description ?? null,
        skill: route.skill ?? baseRoute?.skill ?? null,
        card: briefCard,
        userMessages: pendingMessages,
        handoffPath,
        stretchId,
        attempt: startedPayload.attempt,
        floorLine: floorRungId ? `Escalation floor for ${duty}: ${floorRungId} (sticky for this conversation)` : null,
        selectedDuties,
        findingsExpectation: findingsExpectationFor(duty, env),
        dutyGuidance: dutyGuidanceFor(duty),
        objective,
        dutyDescriptions: model?.duties ?? {},
        recovery: recovered ? `Read ${recovered.context} before acting. Verify the last commands' effects; an interrupted command is not proof of success. Continue the same objective.` : null,
      });
      if (pendingMessages.length) store.append({ kind: "messages-consumed", duty, stretch: stretchId,
        payload: { throughIndex: Math.max(...pendingMessages.map((m) => m.index ?? -1)), count: pendingMessages.length } });

      const tee = makeStretchEventTee(store, {
        stretchId,
        duty,
        syntheticFromChunks: route.target.runtime !== "agent-sdk",
      });
      // Cost instrumentation: every API call the provider described, appended to
      // L3 AS IT HAPPENS. Live rather than on settle so a stretch that times out
      // still leaves behind what it burned — the old scalar reported null there.
      const usageRows = [];
      const onUsage = (row) => {
        if (!row) return;
        usageRows.push(row);
        store.append({ kind: "usage", duty, stretch: stretchId, runId, payload: { ...row, ordinal } });
      };
      // A steer interrupts THIS stretch only. Its controller is chained to the
      // conversation's cancel signal, so a cancel still stops everything, while
      // a steer stops one stretch and the loop carries on with the same duty.
      const stretchAbort = new AbortController();
      let steer = null;
      const onOuterAbort = () => stretchAbort.abort();
      if (signal?.aborted) stretchAbort.abort();
      else signal?.addEventListener("abort", onOuterAbort, { once: true });
      steerRegistry().set(conversationId, {
        stretchId,
        duty,
        steer: (info = {}) => {
          if (steer || stretchAbort.signal.aborted) return false;
          steer = {
            at: new Date().toISOString(),
            seq: typeof info.seq === "number" ? info.seq : null,
            text: String(info.text ?? "").slice(0, 4000),
          };
          store.append({ kind: "stretch-steered", duty, stretch: stretchId, runId, payload: { ...steer, stretchId, ordinal } });
          onFrame("stretch-steered", { stretchId, duty, ordinal, seq: steer.seq });
          stretchAbort.abort();
          return true;
        },
      });
      let result;
      try {
        result = await runStretch(gateway, {
          route,
          brief,
          stretchId,
          conversationId,
          cwd: scope.cwd,
          turnId: `${conversationId}#${ordinal}`,
          onChunk: (text, replace) => {
            onFrame("chunk", { type: "chunk", text, replace });
            tee.chunk(text, replace);
          },
          onEvent: (event) => {
            onFrame("session_event", event);
            tee.event(event);
          },
          onUsage,
          signal: stretchAbort.signal,
          timeoutMs: duty === "triage" ? Math.min(STRETCH_TIMEOUT_MS, 120_000) : STRETCH_TIMEOUT_MS,
          env,
        });
      } finally {
        if (steerRegistry().get(conversationId)?.stretchId === stretchId) steerRegistry().delete(conversationId);
        signal?.removeEventListener("abort", onOuterAbort);
      }
      tee.flush();

      if (signal?.aborted || steer) {
        // A steered stretch is not a failed one: no exit gate, no repair call,
        // no needs-input. Its handoff routes straight back to the same duty,
        // and the brief that duty boots from carries the steering message (it
        // landed after this stretch's messages-consumed stamp, so it is still
        // unconsumed). The partial reply is kept as evidence of what was cut.
        const cancelled = signal?.aborted === true;
        // A human Stop must never start the exit gate's re-ask/repair model.
        // Preserve partial output and a resumable summary locally instead.
        const handoff = cancelled ? {
          v: 1, stretchId, duty, status: "partial", summary: "Stopped by the user before the stretch finished.",
          evidenceRefs: [], nextSteps: { next: "needs-input", why: "The user stopped this conversation.", items: [] },
          blocker: { what: "Conversation stopped", needs: "a new user message to continue", who: "user" },
          activeConstraints: [], failedApproaches: [], surprises: [], forceEscalation: null,
          synthesized: true, cancelled: true,
        } : steeredHandoff({ stretchId, duty, steer, reply: result.reply });
        store.writeHandoff(ordinal, handoff);
        const replyRef = store.writeNamedPayload(`stretch-${String(ordinal).padStart(4, "0")}-reply.md`, result.reply ?? "");
        store.append({
          kind: "handoff",
          duty,
          stretch: stretchId,
          payload: { ...handoff, ordinal, _gate: { valid: true, repairs: 0, synthesized: true, source: cancelled ? "cancel" : "steer", resolved: [] } },
        });
        onFrame("handoff", { ordinal, duty, status: handoff.status, next: handoff.nextSteps.next, synthesized: true });
        const updated = applyHandoffToSummary(store.parseSummary() ?? {}, handoff, { floorUpdate });
        let write = store.writeSummary(updated, { stretchId: store.currentStretch() });
        if (!write.ok && write.reason === "over-cap") {
          write = store.trimSummary(updated, { stretchId: store.currentStretch() });
        }
        if (cancelled) await writeCardTransition(gateway, { cardId: card?.id, conversationId, stretchId, phase: "ended", handoff, duty });
        // A steer keeps the card Running: the same duty starts again shortly.
        const endedPayload = stretchEndedPayload({
          stretchId, ordinal, duty, route, result, usageRows,
          outcome: cancelled ? "cancelled" : "steered",
          stoppedReason: cancelled ? "cancelled" : "steered",
          replyRef: replyRef.ref,
          summaryWrite: write.ok ? "ok" : write.reason,
          next: handoff.nextSteps.next,
        });
        store.append({ kind: "stretch-ended", duty, stretch: stretchId, runId, payload: endedPayload });
        onFrame("stretch-ended", endedPayload);
        store.releaseStretch(stretchId);
        stretches += 1;
        if (cancelled) { terminal = "cancelled"; break; }
        continue;
      }

      // Step 4: an account that answered with a rate/usage limit is marked
      // cooling and skipped by later table walks until the interval passes.
      // Only limit SHAPES cool - a crash or syntax error must not push every
      // later stretch onto the paid lane.
      if (!result.ok && routingTableEnabled(env) && limitShaped(result.error) && route.target.provider) {
        const minutes = tableDecision?.coolingMinutes ?? 30;
        const until = markCooling(
          { provider: route.target.provider, account: route.target.account ?? null },
          minutes,
          { env }
        );
        store.append({
          kind: "route-cooling",
          duty,
          stretch: stretchId,
          payload: {
            provider: route.target.provider,
            account: route.target.account ?? null,
            until,
            error: String(result.error ?? "").slice(0, 200),
          },
        });
        gateway.logFn?.({ kind: "route-cooling", provider: route.target.provider, account: route.target.account ?? null, until });
      }

      // Exit gate — with an in-session re-ask only where the session is warm.
      // runStretch already closed the native session. Re-asking that key used
      // to create a fresh agent without its brief, cwd or exit contract.
      const reAsk = null;
      const repair = async (prompt) => {
        const floorLadder = await ladderForDuty(gateway, "triage", 1);
        const repairRung = floorLadder?.rungs?.find((r) => r.runtime === "agent-sdk");
        if (!repairRung) return ""; // only this adapter enforces an empty tool inventory
        const floorRoute = routeFromRung(repairRung, { effort: "low", duty, level: 1 });
        // Formatting repair cannot do more work or wait indefinitely. The
        // provider-neutral run path preserves cancellation and teardown.
        const repairRoute = { ...floorRoute, target: { ...floorRoute.target,
          tools: [], mcpServers: null, mcpTools: [], maxTurns: 1 } };
        const r = await runStretch(gateway, { route: repairRoute, brief: prompt,
          stretchId: `repair-${stretchId}`, conversationId, cwd: scope.cwd,
          timeoutMs: 45_000, signal, env,
          onUsage: (row) => onUsage({ ...row, phase: "repair" }) });
        return r?.reply ?? "";
      };

      const gate = await runExitGate(gateway, {
        store,
        stretchId,
        ordinal,
        duty,
        route,
        reply: result.reply,
        selectedDuties,
        // Step-3 flag: with runtime_codex off the gate synthesizes the old
        // generic no-handoff line even for a dead runtime.
        runtimeError: !result.ok && runtimeCodexEnabled(env) ? (result.error ?? null) : null,
        reAsk,
        repair: result.ok ? repair : null,
        // Rule 10 (anti-fabrication) must look where the stretch actually
        // worked: a project stretch's file/gate/run refs live in the repo,
        // not the composition dir.
        resolveEvidence: defaultResolveEvidence(scope.cwd ?? gateway.compositionDir),
      });

      // Persist the raw reply (L3) and the handoff event.
      const replyRef = store.writeNamedPayload(`stretch-${String(ordinal).padStart(4, "0")}-reply.md`, result.reply ?? "");
      const policy = applyFlowPolicy(gate.handoff.nextSteps.next, {
        store, duty, selectedDuties, cwd: scope.cwd ?? gateway.compositionDir,
        stretchId, handoff: gate.handoff, card, env,
      });
      if (policy.reviewBudget) {
        // The budget bit. Recorded on its own kind rather than folded into
        // policy-rewrite, because "how many reviews did this task ask for and
        // how many did it get" has to be answerable without parsing prose.
        store.append({
          kind: "review-budget",
          duty,
          stretch: stretchId,
          payload: { ...policy.reviewBudget, allowed: false },
        });
        onFrame("review-budget", policy.reviewBudget);
      }
      if (policy.skippedReview) {
        store.append({
          kind: "policy-rewrite", duty, stretch: stretchId,
          payload: { from: "adversarial-review", to: "done", reason: `review skipped: ${policy.skippedReview}` },
        });
      }
      if (policy.rewritten) {
        store.append({ kind: "policy-rewrite", duty, stretch: stretchId, payload: { from: gate.handoff.nextSteps.next, to: policy.next, reason: policy.reason } });
        gate.handoff.nextSteps = { ...gate.handoff.nextSteps, next: policy.next, why: `${gate.handoff.nextSteps.why} [policy: ${policy.reason}]` };
        if (policy.items) gate.handoff.nextSteps.items = [...new Set([...gate.handoff.nextSteps.items, ...policy.items])];
        if (policy.verificationMissing) {
          gate.handoff.status = "partial";
          gate.handoff.failedApproaches.push({ approach: "Report completion", why: "Completed verification was not recorded with a resolvable run/gate reference; record it before closing." });
        }
        // A refused answer classification resumes the work rail. Persist a
        // valid contract rather than answer + a nonterminal next duty.
        if (gate.handoff.completion === "answer") gate.handoff.completion = "work";
        if (policy.next === "needs-input") {
          gate.handoff.status = "partial";
          gate.handoff.blocker = { what: policy.reason, needs: "Review the saved work and send a message to continue", who: "user" };
          gate.handoff.summary = `${policy.reason}.\n\n${gate.handoff.summary}`.slice(0, 4000);
        }
        store.writeHandoff(ordinal, gate.handoff);
      }
      if (deploymentInFlight(store) && !signal?.aborted) {
        const verificationDuty = ["ops", "validate", "test"].find((d) => selectedDuties.includes(d)) ?? duty;
        gate.handoff.status = "partial";
        gate.handoff.completion = "work";
        gate.handoff.nextSteps = { next: verificationDuty, why: "The supervised deployment must finish and be verified", items: ["Read deployment.json and the deployment log; verify the live node before reporting completion"] };
        store.writeHandoff(ordinal, gate.handoff);
      }
      store.append({
        kind: "handoff",
        duty,
        stretch: stretchId,
        payload: { ...gate.handoff, ordinal, _gate: { valid: gate.valid, repairs: gate.repairs, synthesized: gate.synthesized, source: gate.source, resolved: gate.resolved } },
      });
      onFrame("handoff", { ordinal, duty, status: gate.handoff.status, next: gate.handoff.nextSteps.next, synthesized: gate.synthesized });

      // L1 update — the exiting stretch's handoff application IS the summary
      // maintenance. The gate holds the marker, so it is the only writer.
      const updated = applyHandoffToSummary(store.parseSummary() ?? {}, gate.handoff, { floorUpdate });
      let write = store.writeSummary(updated, { stretchId: store.currentStretch() });
      if (!write.ok && write.reason === "over-cap") {
        write = store.trimSummary(updated, { stretchId: store.currentStretch() });
      }

      await writeCardTransition(gateway, { cardId: card?.id, conversationId, stretchId, phase: result.ok ? "ended" : "error", handoff: gate.handoff, duty });

      // Aggregate the stretch's calls onto its closing event (see
      // stretchEndedPayload for what the cost fields mean).
      const endedPayload = stretchEndedPayload({
        stretchId, ordinal, duty, route, result, usageRows,
        outcome: !result.ok ? "error" : gate.synthesized ? "synthesized" : gate.repairs ? "repaired" : "handoff",
        stoppedReason: result.stoppedReason,
        replyRef: replyRef.ref,
        summaryWrite: write.ok ? "ok" : write.reason,
        next: gate.handoff.nextSteps.next,
      });
      store.append({ kind: "stretch-ended", duty, stretch: stretchId, runId, payload: endedPayload });
      onFrame("stretch-ended", endedPayload);

      // THE INSTRUMENTED NUMBER. How many of this stretch's read/search targets
      // an earlier stretch in the same task had already hit. Written to the
      // ledger next to the cost figures so the two are read together. Reported,
      // not judged: nothing in this slice is tuned to move it.
      try {
        const rep = repetitionReport(store.range({ fromIndex: 0, limit: 200_000 }).events);
        const mine = rep.stretches.find((r) => r.stretch === stretchId) ?? null;
        store.append({
          kind: "read-repetition",
          duty,
          stretch: stretchId,
          runId,
          payload: {
            stretch: mine,
            task: rep.task,
            findingsCarriedIn: composedFindings.entries.length,
            findingsStaleAtCompose: composedFindings.staleCount,
          },
        });
      } catch (err) {
        // The measurement must never be the reason a stretch fails.
        store.append({ kind: "read-repetition-failed", stretch: stretchId, payload: { error: String(err?.message ?? err) } });
      }
      store.releaseStretch(stretchId);
      stretches += 1;

      if (!result.ok && !signal?.aborted) {
        // The stretch itself errored (timeout, adapter failure). The synthetic
        // handoff already routed needs-input; stop here.
        terminal = "needs-input";
        break;
      }
    }

    if (terminal === null) {
      const lastNext = store.tail(1, { kinds: ["handoff"] })[0]?.payload?.nextSteps?.next;
      terminal = CONVERSATION_FLOW.terminal.includes(lastNext) ? lastNext : "needs-input";
      if (!CONVERSATION_FLOW.terminal.includes(lastNext)) parkConversation(store, {
        reason: `Paused after ${maxStretches} stretches without completing the request. All work and remaining steps are saved; send a message to continue.`,
      });
    }
    if (terminal === "done" || terminal === "needs-input") {
      // The closing stretch already wrote the terminal transition — normally.
      // A failed write (evidence guard, rev storm, a board momentarily
      // unreachable) leaves the card wedged on Running with a FINISHED
      // conversation, and the tick's recovery kick lands right here: re-assert
      // the terminal so the wedge self-heals. BOTH terminals need this — the
      // first version covered only done, and a needs-input park that hit a
      // transient write failure stayed wedged for hours while every kick
      // no-opped through this branch (card 01M106TB…, 2026-08-27).
      const lastH = store.tail(1, { kinds: ["handoff"] })[0];
      const lastNext = lastH?.payload?.nextSteps?.next;
      if (card?.id && (lastNext === "done" || lastNext === "needs-input")) {
        await writeCardTransition(gateway, {
          cardId: card.id,
          conversationId,
          stretchId: lastH.stretch ?? null,
          phase: "ended",
          handoff: lastH.payload,
          duty: lastH.duty ?? null,
        });
      }
    } else if (terminal === "cap" && card?.id) {
      await patchCardEngine({
        id: card.id,
        patch: { list: "needs-attention", status: "needs-attention", attentionReason: `conversation hit the ${maxStretches}-stretch cap` },
        logFn: (e) => gateway.logFn?.(e),
      });
    }
    onFrame("done", { terminal, stretches });
    return { stretches, terminal };
    } catch (err) {
      if (ownedStretchId) store.releaseStretch(ownedStretchId);
      const failure = recoverInterruptedStretch(store, { reason: `The conversation stopped: ${String(err?.message ?? err).slice(0, 350)}`, maxRecoveries: 0 });
      store.append({ kind: "note", payload: { origin: "gateway", text: failure?.handoff.summary ?? `The conversation could not continue: ${String(err?.message ?? err).slice(0, 350)}` } });
      if (failure) await writeCardTransition(gateway, { cardId: (await cardById(conversationId).catch(() => null))?.id,
        conversationId, stretchId: failure.start.stretch, phase: "error", handoff: failure.handoff, duty: failure.start.duty });
      onFrame("done", { terminal: "needs-input", error: String(err?.message ?? err) });
      return { stretches: 0, terminal: "needs-input", error: String(err?.message ?? err) };
    } finally {
      if (ownedStretchId) store.releaseStretch(ownedStretchId);
      steerRegistry().delete(conversationId);
      await syncWorkSessionTitle(conversationId).catch(reportCardHook);
      if (ownsWorkLifecycle) await endSessionCard(conversationId).catch(reportCardHook);
    }
  });
}

/** Record a user message in the store; a running stretch picks it up at its
 *  next brief, and when nothing is running the caller kicks an advance so a
 *  responder stretch answers from L1. */
export function recordUserMessage(store, { text, origin = "web", threadId = null, context = null, routing = null, delivery = null, steered = false, clientRequestId = null, questionId = null }) {
  const requestId = typeof clientRequestId === "string" && clientRequestId.trim() ? clientRequestId.trim().slice(0, 200) : null;
  const fullText = String(text ?? "");
  const normalizedText = fullText.slice(0, 32_000);
  if (requestId) {
    // A browser may retry after the gateway recorded the message but its HTTP
    // reply was lost. Read the durable ledger, not a process-local cache: this
    // remains idempotent after a gateway restart and after a long conversation.
    // The check and append are synchronous, so concurrent requests handled by
    // this gateway cannot interleave them.
    const previous = store.tail(Number.MAX_SAFE_INTEGER, { kinds: ["user-message"] })
      .find((event) => event.payload?.clientRequestId === requestId);
    if (previous) {
      const previousText = previous.payload.textRef ? store.readPayload(previous.payload.textRef) : previous.payload.text;
      if (previousText !== fullText) {
        return { ok: false, conflict: true, error: "clientRequestId was already used for a different message" };
      }
      return { ok: true, duplicate: true, ts: previous.ts, seq: previous.seq };
    }
  }
  if (questionId != null && pendingConversationQuestion(store)?.id !== questionId) {
    return { ok: false, conflict: true, error: "This question has already been answered or is no longer active. Refresh the conversation." };
  }
  const running = store.currentStretch();
  return store.append({
    kind: "user-message",
    payload: {
      text: normalizedText,
      ...(fullText.length > normalizedText.length ? { textRef: store.spillPayload(fullText).ref } : {}),
      ...(requestId ? { clientRequestId: requestId } : {}),
      ...(questionId ? { questionId } : {}),
      origin,
      threadId,
      arrivedDuringStretch: running,
      // `steer`: the running stretch is interrupted for this message and its
      // duty re-runs with it in the brief. `queued`: it waits for the next
      // brief. `opened`: nothing was running; a responder answers.
      disposition: running ? (steered ? "steer" : "queued") : "opened",
      ...(delivery === "steer" || delivery === "queue" ? { delivery } : {}),
      // Host-supplied grounding (a Discuss card's brief) and a Turn Rail pin
      // ride the message: the next stretch's brief carries the context, and
      // the pin decides its rung (resolveRung precedence: pin first).
      ...(typeof context === "string" && context.trim() ? { context: context.slice(0, 8000) } : {}),
      ...(routing && typeof routing === "object" && !Array.isArray(routing) ? { routing } : {}),
    },
  });
}

// ── steering a stretch in flight ────────────────────────────────────────────
// One entry per conversation whose stretch can be interrupted RIGHT NOW,
// registered by the loop for the duration of runStretch. On globalThis because
// the gateway's HTTP handler imports this module per request and has to find
// the same map the loop wrote into. Steering is what typing into a working
// Claude Code session does: the turn in flight stops at its next boundary and
// the same duty continues with the new instruction - it is NOT a cancel (the
// loop goes on) and NOT a failure (no exit gate, no repair, no needs-input).
function steerRegistry() {
  return (globalThis.__conversationSteers ??= new Map());
}

/** The stretch a steer would interrupt, or null when nothing is interruptible
 *  (between stretches, or nothing running). */
export function steerableStretch(conversationId) {
  const entry = steerRegistry().get(conversationId);
  return entry ? { stretchId: entry.stretchId, duty: entry.duty } : null;
}

/** Interrupt the running stretch so its duty re-runs with the message that was
 *  just recorded. True when a stretch was interrupted; false when none could be
 *  (the message is then simply queued - the next brief carries it anyway). */
export function steerRunningStretch(conversationId, info = {}) {
  const entry = steerRegistry().get(conversationId);
  if (!entry) return false;
  return entry.steer(info);
}

/** The handoff a steered stretch leaves behind: partial (the work was cut
 *  short), routing straight back to the SAME duty, and marked so the tripwires
 *  and attempt counters know it was the user's interruption, not a failure. */
export function steeredHandoff({ stretchId, duty, steer, reply = "" }) {
  const quoted = String(steer?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return {
    v: 1,
    stretchId,
    duty,
    status: "partial",
    summary: `Interrupted by the user to steer the work${quoted ? `: "${quoted}"` : ""}. What this stretch did before the interruption may be partly applied in the working tree - check the tree before redoing any of it. The next ${duty} stretch continues with the user's message in its brief.`,
    evidenceRefs: [],
    nextSteps: { next: duty, why: "the user steered mid-stretch; the same duty continues with the new instruction", items: [] },
    blocker: null,
    activeConstraints: [],
    failedApproaches: [{ approach: `run duty ${duty} as a stretch`, why: "interrupted by a user steer before it finished" }],
    surprises: [],
    forceEscalation: null,
    synthesized: true,
    steered: true,
    ...(String(reply ?? "").trim() ? { partialReply: String(reply).slice(0, 2000) } : {}),
  };
}

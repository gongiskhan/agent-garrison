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

import fs from "node:fs";
import path from "node:path";
import {
  openConversation,
  newConversationId,
  validateHandoff,
  defaultResolveEvidence,
  renderSummary,
  runLog,
} from "@garrison/claude-pty";
import { boardBase, cardById } from "./autonomous-cards.mjs";
import { resolveRunScope, PERSONAL_SCOPE_TOKEN } from "./project-source.mjs";

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
 * (an adversarial handoff) → tripwire (one rung above the floor) → the
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

/** The two flow invariants. Returns {next, rewritten, reason}. */
export function applyFlowPolicy(next, { store, duty, selectedDuties = [], cwd = null } = {}) {
  if (next !== "done") return { next, rewritten: false, reason: null };
  // Triage never closes a conversation as done: its job is to open the work
  // and name the first working duty, and a capable floor model will happily do
  // a small task itself and hand off done (observed on the first live run —
  // the whole deliverable written inside triage, skipping plan, implement and
  // review). needs-input stays allowed: parking for clarity IS triage's call.
  if (duty === "triage") {
    const first = ["plan", "implement"].find((d) => selectedDuties.includes(d));
    if (first) return { next: first, rewritten: true, reason: "triage-never-done" };
  }
  // review-before-done: implement work is not done until someone else read it.
  if (CONVERSATION_FLOW.reviewBeforeDone.from.includes(duty)) {
    const insert = CONVERSATION_FLOW.reviewBeforeDone.insert.find((d) => selectedDuties.includes(d));
    if (insert) return { next: insert, rewritten: true, reason: "review-before-done" };
  }
  // done-requires-evidence: somewhere in this conversation a gate/run evidence
  // ref must still resolve on disk. Restates the old terminal Test→Done
  // invariant without a phase graph.
  const handoffs = store.tail(50, { kinds: ["handoff"] });
  const hasResolvable = handoffs.some((evt) =>
    (evt.payload?.evidenceRefs ?? []).some((ev) => {
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
    if (selectedDuties.includes(otherwise) && duty !== otherwise) {
      return { next: otherwise, rewritten: true, reason: "done-without-evidence" };
    }
  }
  return { next, rewritten: false, reason: null };
}

// ── brief ───────────────────────────────────────────────────────────────────

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
  "summary": "<what happened, <=4000 chars>",
  "evidenceRefs": [{"kind":"file|commit|run|gate|artifact|url|log","ref":"<ABSOLUTE path or id>","note":"..."}],
  "nextSteps": {"next":"<a selected duty, or done, or needs-input>","why":"...","items":["..."]},
  "blocker": null | {"what":"...","needs":"...","who":"..."},
  "activeConstraints": ["..."],
  "failedApproaches": [{"approach":"...","why":"..."}],
  "surprises": ["..."],
  "forceEscalation": null | "<reason>",
  "synthesized": false
}
Rules: blocked requires a blocker; partial/failed require at least one
failedApproaches entry; next "done" requires status "complete"; a gate/run/file
evidence ref must point at a real non-empty file. Update nothing else — the
exit gate applies your handoff to the conversation summary.`;

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
}) {
  const parts = [];
  parts.push(`# Stretch brief — conversation ${conversationId}`);
  parts.push(`Conversation store: ${conversationDir} (log.jsonl is the full record; grep it when you need history)`);
  parts.push("");
  parts.push(summaryText?.trim() || "(no summary yet — you are the first stretch; write the objective into your handoff summary)");
  if (card) {
    // The card IS the task. The first live run inferred the whole purpose from
    // the TITLE alone and went off to do something else entirely — every brief
    // carries the full card so no stretch ever works from a headline.
    parts.push("", "## The card");
    parts.push(`Title: ${String(card.title ?? "(untitled)").slice(0, 300)}`);
    if (typeof card.description === "string" && card.description.trim()) {
      parts.push("", String(card.description).slice(0, 8000));
    }
    if (typeof card.acceptance === "string" && card.acceptance.trim()) {
      parts.push("", `Acceptance: ${String(card.acceptance).slice(0, 2000)}`);
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
        `- #${ordinal} [${handoff.duty}/${handoff.status}] ${String(handoff.summary ?? "").slice(0, 300)} → next: ${handoff.nextSteps?.next}`
      );
    }
    parts.push(`Older handoffs are under ${path.join(conversationDir, "handoffs")}.`);
  }
  parts.push("", `## Your duty: ${duty} (level ${level}${attempt > 1 ? `, attempt ${attempt}` : ""})`);
  if (dutyDescription) parts.push(dutyDescription);
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
  : 1000;
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
 * throttled per event id: the serving layer's SSE polls the log at ~800ms, so
 * sub-second revisions would be invisible anyway — the throttle keeps the
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
  cwd = null,
  turnId = null,
  onChunk = null,
  onEvent = null,
  signal = null,
  timeoutMs = STRETCH_TIMEOUT_MS,
}) {
  const started = Date.now();
  let stop = null;
  const registerStop = (fn) => {
    stop = fn;
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
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      abort();
      reject(new Error(`stretch timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const isAgentSdk = route.target.runtime === "agent-sdk";
    const turnPromise = isAgentSdk
      ? gateway.runAgentSdkTurn(route, brief, onChunk, {
          sessionKey: `stretch:${stretchId}`,
          turnId: turnId ?? `stretch:${stretchId}`,
          ...(cwd ? { cwd } : {}),
          onEvent,
          registerStop,
        })
      : gateway.runSecondaryTurn(route, brief, {
          onChunk,
          registerStop,
          ...(cwd ? { cwd } : {}),
        });
    const result = await Promise.race([turnPromise, timeout]);
    return {
      ok: true,
      reply: result?.reply ?? "",
      sessionId: result?.session_id ?? null,
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
      reply: "",
      sessionId: null,
      usedTokens: null,
      costUnknown: true,
      model: route.target.model,
      effortApplied: null,
      stoppedReason: signal?.aborted ? "cancelled" : null,
      durationMs: Date.now() - started,
      error: err?.message ?? String(err),
    };
  } finally {
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
  const fenced = /```handoff\s*\n([\s\S]*?)```/i.exec(text) ?? /```json\s*\n([\s\S]*?)```\s*$/i.exec(text);
  if (!fenced) return null;
  try {
    return JSON.parse(fenced[1]);
  } catch {
    return null;
  }
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
}) {
  const resolver = resolveEvidence ?? defaultResolveEvidence(gateway.compositionDir);
  const file = store.handoffPath(ordinal);
  let repairs = 0;
  let source = "file";

  const readCandidate = () => {
    const fromFile = store.readHandoff(ordinal);
    if (fromFile) return { handoff: fromFile, from: "file" };
    const fromReply = parseFencedHandoff(reply);
    if (fromReply) return { handoff: fromReply, from: "reply" };
    return { handoff: null, from: "absent" };
  };

  let { handoff, from } = readCandidate();
  source = from;
  let verdict = handoff
    ? validateHandoff(handoff, { selectedDuties, resolveEvidence: resolver })
    : { ok: false, errors: ["handoff absent (no file, no fenced block)"], resolved: [] };

  if (!verdict.ok && typeof reAsk === "function") {
    const prompt = `Your handoff is invalid: ${verdict.errors.join("; ")}.\nRewrite the handoff JSON at ${file} (or reply with ONLY a \`\`\`handoff fenced block). Fix every error. Reply with nothing else.`;
    try {
      const reAskReply = await reAsk(prompt);
      const again = store.readHandoff(ordinal) ?? parseFencedHandoff(reAskReply);
      if (again) {
        handoff = again;
        source = store.readHandoff(ordinal) ? "file" : "re-ask-reply";
        verdict = validateHandoff(handoff, { selectedDuties, resolveEvidence: resolver });
      }
    } catch {
      /* the re-ask is best-effort; the repair path follows */
    }
  }

  if (!verdict.ok && typeof repair === "function") {
    repairs = 1;
    const spill = store.spillPayload({ stretchId, reply: String(reply ?? "").slice(0, 200_000) });
    const prompt = `A work stretch (duty: ${duty}) ended without a valid handoff. Errors: ${verdict.errors.join("; ")}.\nFrom the stretch's reply below, write the most honest handoff JSON you can (schema in the fenced block contract). Do NOT invent evidence: if the reply names no verifiable evidence, evidenceRefs stays []. If the work seems incomplete, status is "partial" and failedApproaches says what fell short. Reply with ONLY a \`\`\`handoff fenced block.\n\nSTRETCH REPLY (may be truncated; full copy at ${spill.ref}):\n${String(reply ?? "").slice(0, 20_000)}`;
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
      summary: `The stretch ended without a valid handoff (${(verdict.errors ?? []).join("; ") || "no output"}). Raw reply preserved in payloads/.`,
      evidenceRefs: [],
      nextSteps: { next: "needs-input", why: "the exit gate could not extract an honest handoff", items: [] },
      blocker: { what: "no valid handoff from the stretch", needs: "a human look at the conversation log", who: "user" },
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
  next.currentState = `${handoff.duty}/${handoff.status}: ${String(handoff.summary).slice(0, 600)}`;
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
  // The responder answers a user; it never moves the card. A question about a
  // done card must not reopen or re-park it.
  if (duty === "responder") return;
  const logFn = (e) => gateway.logFn?.(e);
  if (phase === "started") {
    await patchCardEngine({ id: cardId, patch: { list: "running", status: "running", runningSince: new Date().toISOString() }, logFn });
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
  const all = store.tail(200, { kinds: ["user-message", "handoff"] });
  const lastHandoffIdx = all.reduce((acc, e) => (e.kind === "handoff" ? e.index : acc), -1);
  return all
    .filter((e) => e.kind === "user-message" && e.index > lastHandoffIdx)
    .map((e) => ({
      text: String(e.payload?.text ?? "").slice(0, 4000),
      context: typeof e.payload?.context === "string" ? e.payload.context.slice(0, 4000) : null,
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
    if (tail[i].duty === duty) n += 1;
    else break;
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
    // The opening task IS the first user message — one vocabulary, one record.
    if (task && store.count("user-message") === 0) {
      recordUserMessage(store, { text: task, origin: "advance" });
    }
    const model = await gateway.executionModel();
    const selectedDuties = model?.selectedDuties ?? [];
    const card = await cardById(conversationId).catch(() => null);
    const scope = stretchScopeForCard(card);
    if (scope.degraded) {
      // Project named on the card but absent on this machine: say so in the
      // ledger rather than silently working in the composition dir.
      store.append({ kind: "policy-rewrite", payload: { from: `project:${scope.label}`, to: "composition-dir", reason: "project-not-resolvable-here" } });
    }
    const runId = env.GARRISON_SESSION_LOG_RUN ?? null;
    let stretches = 0;
    let terminal = null;

    while (stretches < maxStretches) {
      if (signal?.aborted) {
        terminal = "cancelled";
        break;
      }
      const duty = nextDutyFor(store, selectedDuties);
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
          await patchCardEngine({
            id: card.id,
            patch: {
              list: "needs-attention",
              status: "needs-attention",
              attentionReason: `Plan ready — next step is ${duty}. Reply in the conversation to approve and continue, or flip Autonomous on the card to skip this gate.`,
            },
            logFn: (e) => gateway.logFn?.(e),
          });
          onFrame("approval-requested", { next: duty });
          terminal = "awaiting-approval";
          break;
        }
      }

      const level = Number(card?.level) >= 1 ? Number(card.level) : 1;
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
      const pendingMessages = unconsumedUserMessages(store);
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
      const route = ladder.ladder === "synthetic" && baseRoute
        ? baseRoute
        : routeFromRung(rungPick.rung, { effort, duty, level });

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
        const holder = store.currentStretch();
        if (holder) store.releaseStretch(holder);
        if (!store.claimStretch(stretchId)) {
          terminal = "error";
          break;
        }
      }

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
          effort,
        },
        chosenBy: rungPick.chosenBy,
        chosenWhy: rungPick.chosenWhy,
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
      await writeCardTransition(gateway, { cardId: card?.id, conversationId, stretchId, phase: "started", duty });

      const brief = buildStretchBrief({
        conversationId,
        conversationDir: store.dir,
        summaryText: store.readSummary(),
        lastHandoffs: store.lastHandoffs(3),
        duty,
        level,
        dutyDescription: model?.duties?.[duty]?.description ?? null,
        skill: route.skill ?? baseRoute?.skill ?? null,
        card,
        userMessages: pendingMessages,
        handoffPath,
        stretchId,
        attempt: startedPayload.attempt,
        floorLine: floorRungId ? `Escalation floor for ${duty}: ${floorRungId} (sticky for this conversation)` : null,
        selectedDuties,
      });

      const tee = makeStretchEventTee(store, {
        stretchId,
        duty,
        syntheticFromChunks: route.target.runtime !== "agent-sdk",
      });
      const result = await runStretch(gateway, {
        route,
        brief,
        stretchId,
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
        signal,
      });
      tee.flush();

      // Exit gate — with an in-session re-ask only where the session is warm.
      const reAsk = route.target.runtime === "agent-sdk" && result.ok
        ? async (prompt) => {
            const r = await gateway.runAgentSdkTurn(route, prompt, null, {
              sessionKey: `stretch:${stretchId}`,
              turnId: `${conversationId}#${ordinal}#re-ask`,
            });
            return r?.reply ?? "";
          }
        : null;
      const repair = async (prompt) => {
        const floorLadder = await ladderForDuty(gateway, duty, 1);
        const floorRoute = routeFromRung(floorLadder.rungs[0], { effort: "low", duty, level: 1 });
        const r = await gateway.runAgentSdkTurn(
          floorRoute.target.runtime === "agent-sdk" ? floorRoute : baseRoute ?? floorRoute,
          prompt,
          null,
          { sessionKey: `repair:${stretchId}`, turnId: `${conversationId}#${ordinal}#repair`, ...(scope.cwd ? { cwd: scope.cwd } : {}) }
        );
        await gateway.releaseConversationSessions?.(`repair:${stretchId}`)?.catch?.(() => {});
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
        reAsk,
        repair,
        // Rule 10 (anti-fabrication) must look where the stretch actually
        // worked: a project stretch's file/gate/run refs live in the repo,
        // not the composition dir.
        resolveEvidence: defaultResolveEvidence(scope.cwd ?? gateway.compositionDir),
      });

      // Persist the raw reply (L3) and the handoff event.
      const replyRef = store.writeNamedPayload(`stretch-${String(ordinal).padStart(4, "0")}-reply.md`, result.reply ?? "");
      const policy = applyFlowPolicy(gate.handoff.nextSteps.next, { store, duty, selectedDuties, cwd: scope.cwd ?? gateway.compositionDir });
      if (policy.rewritten) {
        store.append({ kind: "policy-rewrite", duty, stretch: stretchId, payload: { from: gate.handoff.nextSteps.next, to: policy.next, reason: policy.reason } });
        gate.handoff.nextSteps = { ...gate.handoff.nextSteps, next: policy.next, why: `${gate.handoff.nextSteps.why} [policy: ${policy.reason}]` };
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

      const endedPayload = {
        stretchId,
        ordinal,
        duty,
        outcome: !result.ok ? "error" : gate.synthesized ? "synthesized" : gate.repairs ? "repaired" : "handoff",
        usedTokens: result.usedTokens,
        costUnknown: result.costUnknown,
        durationMs: result.durationMs,
        model: result.model,
        effortApplied: result.effortApplied,
        stoppedReason: result.stoppedReason,
        error: result.error,
        handoffRef: `handoffs/${String(ordinal).padStart(4, "0")}.json`,
        replyRef: replyRef.ref,
        summaryWrite: write.ok ? "ok" : write.reason,
        next: gate.handoff.nextSteps.next,
      };
      store.append({ kind: "stretch-ended", duty, stretch: stretchId, runId, payload: endedPayload });
      onFrame("stretch-ended", endedPayload);
      store.releaseStretch(stretchId);
      stretches += 1;

      if (!result.ok && !signal?.aborted) {
        // The stretch itself errored (timeout, adapter failure). The synthetic
        // handoff already routed needs-input; stop here.
        terminal = "needs-input";
        break;
      }
    }

    if (terminal === null) terminal = "cap";
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
  });
}

/** Record a user message in the store; a running stretch picks it up at its
 *  next brief, and when nothing is running the caller kicks an advance so a
 *  responder stretch answers from L1. */
export function recordUserMessage(store, { text, origin = "web", threadId = null, context = null, routing = null }) {
  const running = store.currentStretch();
  return store.append({
    kind: "user-message",
    payload: {
      text: String(text ?? "").slice(0, 32_000),
      origin,
      threadId,
      arrivedDuringStretch: running,
      disposition: running ? "queued" : "opened",
      // Host-supplied grounding (a Discuss card's brief) and a Turn Rail pin
      // ride the message: the next stretch's brief carries the context, and
      // the pin decides its rung (resolveRung precedence: pin first).
      ...(typeof context === "string" && context.trim() ? { context: context.slice(0, 8000) } : {}),
      ...(routing && typeof routing === "object" && !Array.isArray(routing) ? { routing } : {}),
    },
  });
}

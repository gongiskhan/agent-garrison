// probe-core.mjs — the Improver Probe's PURE logic (GARRISON-FLOW-V2 S8, D22-D27).
//
// The Probe asks the operator ONE tappable question at an attended task boundary
// and records the answer as high-weight evidence for the nightly Improver. This
// module holds every decision that can be made WITHOUT touching the filesystem —
// the gates, the "did a real task just complete" heuristic, decisions.jsonl
// correlation, question building, policy target resolution, and answer matching —
// so they unit-test without a sandbox. All I/O (reading sessions/policy/decisions,
// writing the pending record + the feedback queue, the stale-pending sweep) lives
// in probe-store.mjs, exactly the pure-analysis / collectors split the coordination
// rule uses.
//
// Fail-closed by construction (RUN_SPEC A10): a gate returns false unless it has
// POSITIVE evidence to fire. An unreadable input, a missing field, an ambiguous
// session — all resolve to "do not probe".

import { createHash } from "node:crypto";

// v1 question areas (FLOW_PLAN S8). "orchestrator" = was this routed / pipelined
// right; "went-well" = did the work itself land well.
export const PROBE_AREAS = ["orchestrator", "went-well"];

// promptDigest — byte-identical to the gateway's routing-telemetry.promptDigest
// (sha256(prompt).slice(0,16)). Replicated here rather than imported: the
// orchestrator fitting is a SEPARATE installed package at runtime, so a cross-
// fitting import would break the improver's containment. Source of truth:
// fittings/seed/orchestrator/lib/routing-telemetry.mjs.
export function promptDigest(prompt) {
  return createHash("sha256").update(String(prompt ?? "")).digest("hex").slice(0, 16);
}

// YYYY-MM-DD in UTC for the per-day mute / retrospective flag files.
export function dayStamp(now) {
  const d = now ? new Date(now) : new Date();
  return d.toISOString().slice(0, 10);
}

// ── Gates ─────────────────────────────────────────────────────────────────────

// A5/E9 ordering: the goal loop owns a session's Stop while its sentinel is
// armed. The Probe NEVER blocks such a session (a probe block would fight the
// goal-loop block). Both sentinel homes are honored during the autothing→garrison
// transition (RUN_SPEC A5): a present sentinel under EITHER home defers.
export function hasGoalSentinel(sessionId, sentinelPaths) {
  if (!sessionId) return true; // no id → cannot prove it isn't a goal session → defer
  return (sentinelPaths || []).some((p) => p && p.length);
}

// A10 attended gating, FAIL-CLOSED. Positive evidence only: the dev-env fitting
// tagged this session as opened-in-dev-env. Pool/worker/ambient sessions have no
// such tag and are NEVER probed. `state` is the parsed ~/.garrison/sessions/state.json
// (nested projects.<path>.sessions.<claudeSessionId>).
export function isAttended(sessionId, state) {
  if (!sessionId || !state || typeof state !== "object") return false;
  const projects = state.projects && typeof state.projects === "object" ? state.projects : {};
  for (const proj of Object.values(projects)) {
    const sessions = proj && proj.sessions && typeof proj.sessions === "object" ? proj.sessions : {};
    const row = sessions[sessionId] || Object.values(sessions).find((r) => r && r.claudeSessionId === sessionId);
    if (row && (row.openedInDevEnv === true || row.source === "dev-env-open")) return true;
  }
  return false;
}

// "A real task just completed" — a cheap heuristic over the transcript tail
// (RUN_SPEC S8: "last assistant text > N chars or a tool_use in the last turn").
// `events` is the parsed tail (newest last). We look at the LAST assistant message:
// substantial prose OR any tool_use ⇒ real work happened, so a boundary worth a
// probe. A tiny "ok"/"done" reply or a pure-conversation turn ⇒ not probed.
export function taskLooksComplete(events, { minChars = 40 } = {}) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i];
    const msg = ev && ev.message;
    const role = ev?.type === "assistant" || msg?.role === "assistant";
    if (!role) continue;
    const content = msg?.content;
    if (Array.isArray(content)) {
      if (content.some((c) => c && c.type === "tool_use")) return true;
      const textLen = content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .reduce((n, c) => n + c.text.trim().length, 0);
      return textLen > minChars;
    }
    if (typeof content === "string") return content.trim().length > minChars;
    return false; // last assistant message with an unrecognised shape → not proven
  }
  return false; // no assistant message in the tail → not proven
}

// Extract the last user prompt text from the transcript tail (for digest
// correlation). Tolerant of the {message:{role,content}} and string shapes.
export function lastUserPrompt(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i];
    const msg = ev && ev.message;
    const isUser = ev?.type === "user" || msg?.role === "user";
    if (!isUser) continue;
    const content = msg?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}

// ── decisions.jsonl correlation (E11) ────────────────────────────────────────
// The routing decision record is per-TURN, keyed by promptDigest — it carries NO
// sessionId / cardId / runId (E11). So we cannot key it by session directly; we
// correlate by digest when the transcript's last user prompt reproduces the same
// digest, else fall back to the most-recent decision by timestamp (the Stop fires
// right after the turn the gateway just routed). Returns the matched record or null.
export function correlateDecision(decisions, { digest, at } = {}) {
  const list = (Array.isArray(decisions) ? decisions : []).filter((d) => d && typeof d === "object");
  if (!list.length) return null;
  if (digest) {
    const byDigest = list.filter((d) => d.promptDigest === digest);
    if (byDigest.length) {
      // newest digest match at-or-before `at`
      return pickLatest(byDigest, at);
    }
  }
  return pickLatest(list, at);
}

function pickLatest(list, at) {
  const bound = at ? Date.parse(at) : NaN;
  let best = null;
  let bestT = -Infinity;
  for (const d of list) {
    const t = d.at ? Date.parse(d.at) : NaN;
    // Prefer records at-or-before the Stop time; if none qualify, take the latest.
    const key = Number.isFinite(t) ? t : -1;
    if (Number.isFinite(bound) && Number.isFinite(t) && t > bound) continue;
    if (key >= bestT) {
      bestT = key;
      best = d;
    }
  }
  return best || list[list.length - 1];
}

// Build the {kind, tier, plan} classification snapshot for a record from the
// correlated decision + the card (when found). kind ← card work kind, else the
// decision's taskType; tier ← decision tier; plan ← card phase plan.
export function classificationFrom({ decision, card } = {}) {
  return {
    kind: card?.workKind ?? card?.kind ?? decision?.taskType ?? null,
    tier: decision?.tier ?? null,
    plan: card?.phasePlan ?? card?.plan ?? null,
  };
}

// ── Question building (deterministic, area-tagged) ───────────────────────────
// v1 phrases the question deterministically from the real classification so the
// operator sees a grounded question with no model round-trip on the Stop path
// (a model call would block every attended Stop on runtime availability + latency;
// the resolved target is recorded regardless — see probe-store.resolveProbeTarget
// and scripts/probe-generate.mjs, which log the target the policy cell names).
// Each question carries 2-4 concrete options; the relay always appends "Other".
export function buildProbeQuestion({ area, classification, card } = {}) {
  const c = classification || {};
  const kind = c.kind || "this task";
  const tier = c.tier || "an unclassified tier";
  if (area === "went-well") {
    return {
      area: "went-well",
      question: `How did that ${kind} task go?`,
      options: ["Went well", "Rough but done", "Needed rework", "Wrong approach"],
    };
  }
  // default: orchestrator (routing / pipeline depth)
  return {
    area: "orchestrator",
    question: `Garrison routed that as ${kind} (${tier}). Was that the right call?`,
    options: ["Right call", "Should have gone deeper", "Overkill - too heavy", "Wrong task type"],
    ...(card?.id ? {} : {}),
  };
}

// Choose the area for a normal probe. Deterministic so tests pin it: a card-backed
// (pipelined) turn asks the orchestrator/pipeline question; a bare turn asks how it
// went. Kept trivial on purpose — richer selection is a later, evidence-driven step.
export function chooseArea({ card } = {}) {
  return card ? "orchestrator" : "went-well";
}

// ── Retrospective (D25) ──────────────────────────────────────────────────────
// Once per day at the first attended boundary, instead of a single probe we list
// up to 4 of YESTERDAY's work-kind/phase-plan resolutions (cards updated yesterday)
// and ask, per task, whether it should have run the full pipeline or less. Each
// answer becomes ONE record (provenance "retrospective").
export function isFromYesterday(iso, now) {
  if (!iso) return false;
  const y = dayStamp(new Date(Date.parse(now || Date.now()) - 86400000).toISOString());
  return dayStamp(iso) === y;
}

// Pick up to `max` cards touched yesterday that carry a work-kind/plan resolution.
export function selectRetrospectiveCards(cards, { now, max = 4 } = {}) {
  const out = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (out.length >= max) break;
    const updatedAt = card?.updatedAt || card?.lastUpdatedAt || lastEventAt(card);
    if (!isFromYesterday(updatedAt, now)) continue;
    const kind = card?.workKind ?? card?.kind ?? null;
    const plan = card?.phasePlan ?? card?.plan ?? null;
    if (!kind && !plan) continue;
    out.push(card);
  }
  return out;
}

function lastEventAt(card) {
  const events = Array.isArray(card?.events) ? card.events : [];
  return events.length ? events[events.length - 1]?.at : null;
}

export function buildRetrospectiveQuestions(cards, { now } = {}) {
  const picked = selectRetrospectiveCards(cards, { now });
  return picked.map((card) => {
    const kind = card?.workKind ?? card?.kind ?? "work";
    const plan = card?.phasePlan ?? card?.plan ?? "its plan";
    const title = card?.title ? ` "${truncate(card.title, 48)}"` : "";
    return {
      area: "orchestrator",
      question: `Yesterday's ${kind}${title} ran ${plan}. Should it have run the full pipeline, or less?`,
      options: ["That was right", "Should have run the full pipeline", "Should have run less"],
      classification: { kind, tier: null, plan },
      card_id: card?.id ?? null,
    };
  });
}

function truncate(s, n) {
  const str = String(s);
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// ── Policy target resolution (fail LOUD) ─────────────────────────────────────
// The probe-question row resolves to a concrete target in the COMPILED policy
// (policy.matrix["probe-question"][tier]). We read any tier (all tiers point at
// the fast target by construction — D23/D29e). Throws when the cell or its target
// is missing so the caller can fail loudly to the probe-skip log (never silently).
export function resolveProbeTarget(policy) {
  if (!policy || typeof policy !== "object") throw new Error("policy is not an object");
  const row = (policy.matrix || {})["probe-question"];
  if (!row || typeof row !== "object") {
    throw new Error('policy.matrix has no "probe-question" row — the probe-question task type is not compiled into the live policy');
  }
  const tiers = Object.keys(row);
  if (!tiers.length) throw new Error('policy.matrix["probe-question"] has no tier cells');
  const cell = row[tiers[0]];
  if (!cell || !cell.targetId) {
    throw new Error(`policy.matrix["probe-question"]["${tiers[0]}"] resolves to no target`);
  }
  return { targetId: cell.targetId, runtime: cell.runtime ?? null, provider: cell.provider ?? null, model: cell.model ?? null, effort: cell.effort ?? null, tier: tiers[0] };
}

// ── Answer matching (capture side) ───────────────────────────────────────────
// Given a pending record and the AskUserQuestion tool_response.answers map
// ({question: label}), return which pending questions were answered vs left
// unanswered. Exact question-text match first; when the pending is a single
// question and exactly one answer came back, match them even if the model
// rephrased the text slightly (D24 asks for verbatim, but capture stays robust).
export function matchAnswers(pending, answers) {
  const questions = Array.isArray(pending?.questions) ? pending.questions : [];
  const map = answers && typeof answers === "object" ? answers : {};
  const keys = Object.keys(map);
  const answered = [];
  const unanswered = [];
  for (const q of questions) {
    if (Object.prototype.hasOwnProperty.call(map, q.question)) {
      answered.push({ q, answer: map[q.question] });
    } else {
      unanswered.push(q);
    }
  }
  // Rephrase fallback: exactly one pending question, exactly one answer, no exact hit.
  if (!answered.length && questions.length === 1 && keys.length === 1) {
    answered.push({ q: questions[0], answer: map[keys[0]] });
    unanswered.length = 0;
  }
  return { answered, unanswered };
}

// ── D26 record builders (pure) ───────────────────────────────────────────────
// The one on-queue schema shared with the gateway's override writer
// (fittings/seed/http-gateway/scripts/lib/feedback-queue.mjs): session_id?, area,
// question, answer, timestamp, provenance. The probe/retrospective records add
// options[], classification{kind,tier,plan}, and card_id when known.
export function buildFeedbackRecord({ session_id, area, question, options, answer, classification, card_id, provenance = "probe", at } = {}) {
  const rec = {};
  if (session_id != null && String(session_id).length) rec.session_id = String(session_id);
  rec.area = area || "orchestrator";
  rec.question = question ?? null;
  if (Array.isArray(options)) rec.options = options;
  rec.answer = answer ?? null;
  rec.timestamp = at ?? new Date().toISOString();
  rec.provenance = provenance;
  rec.classification = {
    kind: classification?.kind ?? null,
    tier: classification?.tier ?? null,
    plan: classification?.plan ?? null,
  };
  if (card_id != null && String(card_id).length) rec.card_id = String(card_id);
  return rec;
}

// The verbatim relay instruction the Stop hook injects as the block reason (D24).
// The model is a pure relay: ask the pre-generated question(s) through
// AskUserQuestion, verbatim, without reasoning about or rephrasing them.
export function relayReason(pending) {
  const questions = Array.isArray(pending?.questions) ? pending.questions : [];
  const lines = [];
  lines.push(
    "GARRISON IMPROVER PROBE. A question has been pre-generated for the user. Relay it NOW, verbatim, using the AskUserQuestion tool — do NOT answer it yourself, do NOT reason about it, do NOT rephrase it. You are a relay."
  );
  if (questions.length === 1) {
    lines.push("Ask exactly this one question with exactly these options (add an \"Other\" option so the user can free-type):");
  } else {
    lines.push(`Ask exactly these ${questions.length} questions in a single AskUserQuestion call, each with exactly its options (add an \"Other\" option to each):`);
  }
  questions.forEach((q, i) => {
    lines.push(`  ${questions.length > 1 ? `${i + 1}. ` : ""}question: ${JSON.stringify(q.question)}`);
    lines.push(`     options: ${JSON.stringify(q.options)}`);
  });
  lines.push("Use each question string EXACTLY as given (it is the key the answer is matched on). After the user answers, continue your work normally — do not comment on the probe.");
  return lines.join("\n");
}

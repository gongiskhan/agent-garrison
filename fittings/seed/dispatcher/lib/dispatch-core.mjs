// dispatch-core.mjs — the pure heart of the Dispatcher duty (MARATHON-V3 D6).
//
// The Dispatcher replaces the tier classifier. Where the classifier spoke
// (taskType, tier), the Dispatcher speaks the duties-and-levels vocabulary of
// the resolved composition model: it reads a message + the composition's
// selected DUTIES (each with its LEVELS) and picks a (duty, level) pair. The
// pick is made by ONE single-shot, STRUCTURED garrison-call on a small fast
// model — no tool loop, no session (garrison-call is single-shot and never a
// primary). Code, not the model, does the clamping, the human-override, and the
// resolution to a leaf cell.
//
// This module is PURE + injectable: no fs writes except appendEvidence, no
// network — dispatch() takes the garrison-call invoker as `opts.call`, so tests
// mock it and never need Ollama. The resolution of a (duty, level) to a leaf
// cell is the Resolver's job (src/lib/resolver.ts resolveSequence); this module
// only produces the (duty, level) + a confidence note, mirroring how the old
// classifier produced (taskType, tier) and left resolveRoute to the pure core.
//
// PARITY (assumption 5): buildDispatchPrompt mirrors buildClassifierPrompt (list
// the whole vocabulary, ask for single-line JSON); parseDispatch mirrors
// parseClassification (clamp out-of-vocab, default the middle/standard slot,
// null only on total failure); the (duty, level) resolves through the migrated
// duties model to the SAME (runtime, model, effort) the old (taskType, tier)
// matrix produced — proven exhaustively in tests/dispatcher-parity.test.ts.

import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";

// ── Model helpers ────────────────────────────────────────────────────────────
// A "model" is the shape the Resolver emits: { duties, selectedDuties }.
//   duties:         Record<dutyId, { id, title, description, levels: [{description, cell?, sequence?}] }>
//   selectedDuties: string[]  (the composition's wired duty ids)
// A leaf duty (one whose chosen level is a `cell`) is the dispatch target; the
// old classifier only ever produced leaf task-types, so parity lives here.

function selectedDutyList(model) {
  const selected = Array.isArray(model?.selectedDuties) ? model.selectedDuties : [];
  const duties = model?.duties ?? {};
  // Only duties that actually exist in the model are dispatchable. `dispatch`
  // itself is the routing mechanism, never a destination for user work.
  return selected.filter((id) => id !== "dispatch" && duties[id]);
}

function dutySpec(model, dutyId) {
  return (model?.duties ?? {})[dutyId] ?? null;
}

// The "standard" default level — parity with the classifier clamping every
// out-of-vocab tier to T1-standard (the middle tier). The v3→v4 migration maps
// tier index → level (T0→1, T1→2, T2→3), so level 2 is the standard slot;
// clamped to the duty's actual level count for shorter ladders.
function defaultLevelFor(spec) {
  const n = Array.isArray(spec?.levels) ? spec.levels.length : 1;
  return Math.min(2, Math.max(1, n));
}

// The default duty when the model returns nothing usable — "other" if the
// composition wires it (it always did under the task-type vocabulary), else the
// first selected duty. Documented fallback, never a throw.
function defaultDutyFor(model) {
  const selected = selectedDutyList(model);
  if (selected.includes("other")) return "other";
  return selected[0] ?? null;
}

// The EDITABLE clarity rubric (S3d D9b): the default text folded into the prompt
// so the dispatcher judges specification-clarity alongside the (duty, level). A
// composition overrides it via the dispatcher config `dispatch_clarity_rubric`,
// threaded here as opts.clarityRubric - this default is the fallback.
export const DEFAULT_CLARITY_RUBRIC =
  "Judge whether the ask carries enough to plan against - a clear goal, a scope, and any hard " +
  "constraints. When the goal or scope is missing or vague, it is needs-discuss; otherwise clear.";

// ── Prompt (mirrors routing-core.buildClassifierPrompt) ──────────────────────
export function buildDispatchPrompt(model, userPrompt, opts = {}) {
  const selected = selectedDutyList(model);
  const rubric =
    typeof opts.clarityRubric === "string" && opts.clarityRubric.trim()
      ? opts.clarityRubric.trim()
      : DEFAULT_CLARITY_RUBRIC;
  const lines = [];
  lines.push(
    "You are a work dispatcher. Read the task below and choose which DUTY should handle it, and at which LEVEL. Respond with ONLY a single-line JSON object — no prose, no code fence."
  );
  lines.push("");
  lines.push(`duty — one of: ${selected.join(", ")}`);
  lines.push("Pick the duty by what the work IS, then the level by how deep it goes:");
  for (const id of selected) {
    const spec = dutySpec(model, id);
    if (!spec) continue;
    lines.push(`  ${id} — ${spec.description}`);
    spec.levels.forEach((level, index) => {
      lines.push(`    level ${index + 1}: ${level.description}`);
    });
  }
  lines.push("level — the 1-based level number within the chosen duty.");
  lines.push("confidence — one of: low, medium, high.");
  // clarity is ORTHOGONAL to the duty (what the work is): it judges whether the
  // ASK is specified enough to plan against. needs-discuss detours the card
  // through a scope discussion first, keeping its real duty/level on the card.
  lines.push(`clarity - one of: clear, needs-discuss. ${rubric}`);
  lines.push("reason — a short phrase (<= 120 chars) justifying the choice.");
  lines.push("");
  lines.push('Respond exactly like: {"duty":"code","level":2,"confidence":"high","clarity":"clear","reason":"bounded bug fix"}');
  lines.push("");
  lines.push(`Task: """${String(userPrompt ?? "").slice(0, 4000)}"""`);
  return lines.join("\n");
}

// The JSON schema handed to garrison-call for STRUCTURED output. `duty` is left
// as an open string (not an enum) so an out-of-vocab pick returns a parseable
// object that parseDispatch then CLAMPS — matching the classifier's clamp
// semantics rather than a hard schema rejection. `clarity` is OPTIONAL (never
// required) so a model that omits it still returns a parseable object that
// parseDispatch defaults to "clear".
export function dispatchSchema() {
  return {
    type: "object",
    required: ["duty", "level"],
    properties: {
      duty: { type: "string" },
      level: { type: "integer" },
      confidence: { type: "string" },
      clarity: { type: "string" },
      reason: { type: "string" }
    }
  };
}

// ── Parse + clamp (mirrors routing-core.parseClassification) ─────────────────

const CONFIDENCE = new Set(["low", "medium", "high"]);
// S3d (D9b): the two clarity verdicts. Anything else parses back to "clear" (the
// safe default - a card only detours through Discuss on an explicit needs-discuss).
export const CLARITY_VALUES = new Set(["clear", "needs-discuss"]);

// PHRASING OVERRIDE for clarity (mirrors the S3c steering short-circuits + the
// level override): an explicit instruction in the operator's words wins over the
// model's clarity judgment, both directions. Returns { clarity, overrideSource } or
// null (no explicit phrasing → the model / default decides). "let's discuss first"
// forces needs-discuss; "just do it" / "no questions" / "skip discussion" force clear.
export function clarityShortCircuit(message) {
  const text = String(message ?? "");
  // needs-discuss: the operator explicitly wants to talk scope through first.
  if (
    /\b(?:let'?s\s+(?:discuss|talk\s+it\s+through)|discuss\s+(?:this\s+)?first|discuss\s+before\s+building|talk\s+it\s+through\s+first)\b/i.test(
      text
    )
  ) {
    return { clarity: "needs-discuss", overrideSource: "message" };
  }
  // clear: the operator explicitly wants no discussion - proceed straight to work.
  if (/\b(?:just\s+do\s+it|no\s+questions|skip\s+(?:the\s+)?discussion)\b/i.test(text)) {
    return { clarity: "clear", overrideSource: "message" };
  }
  return null;
}

function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* fall through */
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Normalize a raw reply into a candidate object. Accepts: a garrison-call result
// ({ ok, structured|text }), an already-parsed object, or a raw string.
function toCandidate(reply) {
  if (reply == null) return null;
  if (typeof reply === "string") return extractJsonObject(reply);
  if (typeof reply === "object") {
    if (reply.structured && typeof reply.structured === "object") return reply.structured;
    if (typeof reply.text === "string") return extractJsonObject(reply.text);
    // A bare classification-shaped object.
    if ("duty" in reply || "level" in reply) return reply;
  }
  return null;
}

// Parse + clamp a dispatch reply to { duty, level, confidence, reason }. Clamps
// an out-of-vocab duty to the default duty and an out-of-range level to the
// duty's standard level; defaults confidence to "low" when absent/invalid.
// Returns null ONLY when there is no usable JSON object (total failure → the
// caller applies fallbackDispatch), exactly like parseClassification returning
// null so the gateway routed a default.
export function parseDispatch(reply, model) {
  const obj = toCandidate(reply);
  if (!obj || typeof obj !== "object") return null;

  const selected = selectedDutyList(model);
  let duty = typeof obj.duty === "string" && selected.includes(obj.duty) ? obj.duty : defaultDutyFor(model);
  const spec = dutySpec(model, duty);
  const maxLevel = Array.isArray(spec?.levels) ? spec.levels.length : 1;

  const rawLevel = Number(obj.level);
  const level =
    Number.isInteger(rawLevel) && rawLevel >= 1 && rawLevel <= maxLevel
      ? rawLevel
      : defaultLevelFor(spec);

  const confidence = typeof obj.confidence === "string" && CONFIDENCE.has(obj.confidence.toLowerCase())
    ? obj.confidence.toLowerCase()
    : "low";
  // clarity (S3d): the model's specification-clarity judgment, clamped to the two
  // verdicts; an absent/out-of-vocab value defaults to "clear" (never blocks work).
  const clarity =
    typeof obj.clarity === "string" && CLARITY_VALUES.has(obj.clarity.toLowerCase())
      ? obj.clarity.toLowerCase()
      : "clear";
  const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 240) : "";

  return { duty, level, confidence, clarity, reason };
}

// The documented fallback when the model produced nothing usable — the (other,
// standard) slot, parity with the classifier's {taskType:"other", tier:"T1-standard"}.
// clarity defaults to "clear" (a parse failure never detours a card through Discuss).
export function fallbackDispatch(model, reason = "dispatch parse failed; defaulted to standard") {
  const duty = defaultDutyFor(model);
  const spec = dutySpec(model, duty);
  return { duty, level: defaultLevelFor(spec), confidence: "low", clarity: "clear", reason };
}

// Production-safe deterministic fallback used when the configured single-shot
// target is unavailable or unauthenticated. It is intentionally conservative and
// vocabulary-driven: choose only a selected duty, then clamp depth to that duty's
// real levels. In particular, ordinary coding work prefers the composite
// `develop` duty at its standard level, so a medium web task still enters the
// configured end-to-end sequence instead of collapsing to legacy `other`.
export function deterministicFallbackDispatch(model, message) {
  const selected = selectedDutyList(model);
  const lower = String(message ?? "").toLowerCase();
  const has = (id) => selected.includes(id);
  let duty = null;
  const coding = /\b(code|implement|fix|bug|refactor|typescript|javascript|python|api|feature|test|build|change|update|repository|codebase)\b/.test(lower);
  if (coding && has("develop")) duty = "develop";
  else if (coding && has("code")) duty = "code";
  else if (/\b(research|investigate|find|source|compare|learn)\b/.test(lower) && has("research")) duty = "research";
  else if (/\b(image|photo|illustration|render)\b/.test(lower) && has("image")) duty = "image";
  else if (/\b(video|walkthrough|recording)\b/.test(lower) && has("video")) duty = "video";
  else if (/\b(write|draft|document|copy|email)\b/.test(lower) && has("writing")) duty = "writing";
  else if (/\b(deploy|incident|server|cron|operations|ops)\b/.test(lower) && has("ops")) duty = "ops";
  else duty = has("other") ? "other" : selected[0] ?? null;

  const spec = dutySpec(model, duty);
  const count = Math.max(1, Array.isArray(spec?.levels) ? spec.levels.length : 1);
  const deep = /\b(deep|architecture|migration|security|critical|wide[- ]blast|end[- ]to[- ]end|e2e)\b/.test(lower);
  const trivial = String(message ?? "").length < 90 && /\b(typo|rename|one[- ]line|tiny|trivial)\b/.test(lower);
  const level = trivial ? 1 : deep && count >= 3 ? 3 : Math.min(2, count);
  return {
    duty,
    level,
    confidence: "low",
    reason: "configured dispatch call unavailable; deterministic duty fallback"
  };
}

// ── Human override (an explicit "run at level N" or a card field wins) ────────

// Extract an explicit level instruction from the message text. Ordered patterns,
// most-explicit first; returns the integer or null. Kept conservative so an
// incidental "level 3" only fires with a routing verb/preposition in front.
export function parseLevelOverride(message) {
  const text = String(message ?? "");
  // Each pattern requires an EXPLICIT routing directive — a routing verb, an
  // assignment, or a leading "level N" — never a bare "at level N" in prose
  // (codex S3d finding: "the crash happens at level 3 of the menu" must NOT be a
  // routing override). An out-of-range value is returned as-is so applyOverride
  // clamps it (an explicit human override always wins — codex S3d finding: a
  // "level 0" override must clamp to 1, not be ignored).
  const patterns = [
    /\b(?:run|dispatch|do|use|set|force)\b[^\n]{0,24}?\blevel\s+(\d+)\b/i,
    /\blevel\s*[:=]\s*(\d+)\b/i,
    /^\s*level\s+(\d+)\b/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n)) return n; // out-of-range clamped by applyOverride
    }
  }
  return null;
}

// Apply a human override to a dispatch pick. An explicit message instruction or
// a card-level field ALWAYS wins over the Dispatcher's chosen level (the duty is
// kept — the human is overriding depth, not what the work is). The message
// instruction is the freshest intent, so it beats the card field when both are
// present. The override level is clamped into the chosen duty's real range.
export function applyOverride(dispatch, opts = {}, model) {
  const messageLevel = parseLevelOverride(opts.message);
  // An explicit card level wins even when out of range — it is clamped below,
  // not ignored (codex S3d finding: an out-of-range-low card level must clamp).
  const cardLevel = Number.isInteger(opts.cardLevel) ? opts.cardLevel : null;
  const picked =
    messageLevel != null ? { level: messageLevel, source: "message" }
      : cardLevel != null ? { level: cardLevel, source: "card" }
        : null;

  if (!picked) return { ...dispatch, overridden: false, overrideSource: null };

  const spec = dutySpec(model, dispatch.duty);
  const maxLevel = Array.isArray(spec?.levels) ? spec.levels.length : 1;
  const level = Math.min(Math.max(picked.level, 1), maxLevel);
  return {
    ...dispatch,
    level,
    overridden: true,
    overrideSource: picked.source,
    reason: appendReason(dispatch.reason, `overridden to level ${level} by ${picked.source}`)
  };
}

function appendReason(reason, note) {
  const base = typeof reason === "string" ? reason.trim() : "";
  return base ? `${base} (${note})` : note;
}

// ── Routing evidence (never the raw message) ─────────────────────────────────

// SHA-256 digest of the message (first 16 hex chars) — the same shape as
// routing-telemetry.promptDigest. The RAW message is NEVER logged; only its
// digest, so the decisions log carries no user content.
export function messageDigest(message) {
  return createHash("sha256").update(String(message ?? "")).digest("hex").slice(0, 16);
}

// The routing-evidence record for one dispatch — { at, messageDigest, duty,
// level, confidence, overrideSource }. Deliberately carries the digest, NOT the
// message. CRITICAL (codex S3d finding): the model's free-text `reason` saw the
// raw message and can echo it, so it is NEVER persisted here — the durable log
// carries no user content. The persisted `reason` is CODE-COMPOSED from
// non-message fields (duty/level/confidence/override) so the Decisions panel
// stays useful without a leak. The model's free-text reason remains in the live
// dispatch return for immediate debugging, never on disk.
export function routingEvidence({ message, duty, level, confidence, clarity, clarityOverrideSource, overrideSource, at }) {
  const parts = [`→ ${duty ?? "?"} L${level ?? "?"}`];
  if (confidence) parts.push(`confidence ${confidence}`);
  // S3d: the clarity verdict + whether a phrasing override set it (never the raw
  // message - the digest is the only message trace on disk).
  if (clarity) parts.push(`clarity ${clarity}${clarityOverrideSource ? ` (${clarityOverrideSource})` : ""}`);
  if (overrideSource) parts.push(`overridden by ${overrideSource}`);
  return {
    kind: "dispatch",
    at: at ?? null,
    messageDigest: messageDigest(message),
    duty: duty ?? null,
    level: level ?? null,
    confidence: confidence ?? null,
    clarity: clarity ?? null,
    clarityOverrideSource: clarityOverrideSource ?? null,
    overrideSource: overrideSource ?? null,
    reason: parts.join(", ")
  };
}

// Append one evidence record as a JSON line (mirrors routing-telemetry.appendDecision).
export async function appendEvidence(filePath, record) {
  await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
}

// ── Orchestration ────────────────────────────────────────────────────────────

// dispatch(model, message, opts) → the full dispatch decision.
//   opts.call         REQUIRED garrison-call invoker: (spec) => Promise<{ok, structured|text|error}>
//   opts.shape/provider/model/maxTokens/timeoutMs   the default cell (a small fast model)
//   opts.cardLevel    a card-level explicit level field (human override)
//   opts.now          () => ISO string (injectable clock)
//   opts.evidenceFile path to append the routing-evidence JSONL line (optional)
// Never throws for an operational failure (a failed/thrown call → the documented
// fallback); the returned record always carries a (duty, level) + evidence.
export async function dispatch(model, message, opts = {}) {
  if (typeof opts.call !== "function") {
    throw new Error("dispatch: opts.call (the garrison-call invoker) is required");
  }
  const now = typeof opts.now === "function" ? opts.now : () => new Date().toISOString();

  const spec = {
    shape: opts.shape ?? "ollama",
    provider: opts.provider ?? "ollama-local",
    model: opts.model ?? "qwen2.5:3b",
    prompt: buildDispatchPrompt(model, message, { clarityRubric: opts.clarityRubric }),
    schema: dispatchSchema(),
    maxTokens: Number.isFinite(opts.maxTokens) ? opts.maxTokens : 256,
    timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000
  };

  let result;
  try {
    result = await opts.call(spec);
  } catch (err) {
    result = { ok: false, error: `dispatch call threw: ${err?.message || String(err)}` };
  }

  const ok = !!(result && result.ok);
  const parsed = ok ? parseDispatch(result, model) : null;
  const base = parsed ?? (
    typeof opts.fallback === "function"
      ? opts.fallback(model, message)
      : fallbackDispatch(model)
  );
  const chosen = applyOverride(base, { message, cardLevel: opts.cardLevel }, model);

  // clarity (S3d D9b): the model's parsed verdict, then a PHRASING OVERRIDE wins
  // (both directions) - an explicit "just do it" / "let's discuss first" beats the
  // model, same discipline as the level override. Default "clear" (from base) when
  // neither the model nor a phrasing hint decided.
  let clarity = chosen.clarity ?? "clear";
  let clarityOverrideSource = null;
  const claritySc = clarityShortCircuit(message);
  if (claritySc) {
    clarity = claritySc.clarity;
    clarityOverrideSource = claritySc.overrideSource;
  }

  const evidence = routingEvidence({
    message,
    duty: chosen.duty,
    level: chosen.level,
    // NOT chosen.reason — that is model free text that saw the message. Persist
    // only non-message-derived fields (codex S3d finding).
    confidence: chosen.confidence,
    clarity,
    clarityOverrideSource,
    overrideSource: chosen.overridden ? chosen.overrideSource : null,
    at: now()
  });
  if (opts.evidenceFile) {
    try {
      await appendEvidence(opts.evidenceFile, evidence);
    } catch {
      /* evidence logging is best-effort; a dispatch decision is never lost to a log write */
    }
  }

  return {
    duty: chosen.duty,
    level: chosen.level,
    confidence: chosen.confidence,
    // S3d: the specification-clarity verdict (clear | needs-discuss) + whether a
    // phrasing override set it - the gateway carding step reads clarity to pick the
    // card's first list (plan vs the interactive discuss).
    clarity,
    clarityOverrideSource,
    reason: chosen.reason,
    overridden: chosen.overridden,
    overrideSource: chosen.overrideSource ?? null,
    dispatchOk: ok && parsed != null,
    callError: ok ? null : result?.error ?? "dispatch call failed",
    evidence
  };
}

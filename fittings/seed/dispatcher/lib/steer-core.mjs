// steer-core.mjs — the pure heart of mid-run STEERING (S3c, D9).
//
// A run is a card mid-flight. When the user sends a message on its thread, this
// classifies how the run should respond: absorb (fold into the current duty's
// work), revisit (go BACK to an earlier phase), or acknowledge (reply, no change).
//
// Mirrors dispatch-core.mjs conventions exactly: ONE single-shot STRUCTURED
// garrison-call on a small fast model (no tool loop, no session), code does the
// clamping, EXPLICIT phrasing short-circuits before the model call, and routing
// evidence carries a message DIGEST only (never the raw message or the model's
// free-text reason). Pure + injectable: classifySteering takes opts.call.

import { messageDigest, appendEvidence } from "./dispatch-core.mjs";

export const STEER_ACTIONS = ["absorb", "revisit", "acknowledge"];
const CONFIDENCE = new Set(["low", "medium", "high"]);

// The current phase index within the card's ordered sequence.
function currentPhaseIndex(card) {
  const seq = Array.isArray(card?.sequence) ? card.sequence : [];
  const idx = seq.indexOf(card?.list);
  return { seq, idx };
}

// Resolve a named duty to a sequence phase strictly EARLIER than the current one,
// or null. Case-insensitive exact match against the earlier slice.
export function resolveEarlierPhase(card, dutyName) {
  const { seq, idx } = currentPhaseIndex(card);
  if (!dutyName || idx < 0) return null;
  const target = String(dutyName).toLowerCase().trim();
  for (let i = 0; i < idx; i++) {
    if (String(seq[i]).toLowerCase() === target) return seq[i];
  }
  return null;
}

// ── Short-circuit (explicit phrasing wins before the model call) ─────────────
// Returns a decision when the message is unambiguous, else null (→ model call).
export function steeringShortCircuit(message, card) {
  const text = String(message ?? "").trim();
  if (!text) return null;
  // Pure-FYI / context markers -> absorb.
  if (/^\s*(fyi\b|note:|for\s+context\b|for\s+your\s+info)/i.test(text)) {
    return { action: "absorb", reason: "explicit FYI/context marker", confidence: "high" };
  }
  // Explicit revisit phrasing: "re-plan" / "go back to <duty>" / "redo <duty>" /
  // "restart from <duty>" / "revisit <duty>".
  let dutyName = null;
  if (/\bre-?plan\b/i.test(text)) dutyName = "plan";
  else {
    const m = text.match(/\b(?:go back to|redo|restart from|revisit)\s+(?:the\s+)?([a-z][a-z0-9-]*)/i);
    if (m) dutyName = m[1];
  }
  if (dutyName) {
    const phase = resolveEarlierPhase(card, dutyName);
    if (phase) return { action: "revisit", revisitDuty: phase, reason: `explicit request to revisit ${phase}`, confidence: "high" };
    // Explicit revisit, but the target is not an earlier phase → fold in (clamp).
    return { action: "absorb", reason: "explicit revisit target is not an earlier phase; folding into current work", confidence: "medium" };
  }
  return null;
}

// ── Prompt + schema (mirror buildDispatchPrompt / dispatchSchema) ────────────
export function buildSteeringPrompt(message, card, dutyVocab = null) {
  const { seq, idx } = currentPhaseIndex(card);
  const earlier = idx > 0 ? seq.slice(0, idx) : [];
  const lines = [];
  lines.push(
    "A run is mid-flight and the user just sent a message about it. Classify how the run should respond. Respond with ONLY a single-line JSON object — no prose, no code fence."
  );
  lines.push("");
  lines.push(`Run: "${String(card?.title ?? "").slice(0, 200)}" — currently on the "${card?.list ?? "?"}" duty.`);
  lines.push(`Pipeline (in order): ${seq.length ? seq.join(" → ") : "(unknown)"}.`);
  lines.push(`Earlier phases it could go BACK to: ${earlier.length ? earlier.join(", ") : "(none)"}.`);
  if (dutyVocab && typeof dutyVocab === "object") {
    const notes = Object.entries(dutyVocab)
      .filter(([, v]) => typeof v === "string" && v)
      .map(([k, v]) => `  ${k}: ${v}`);
    if (notes.length) {
      lines.push("Duty meanings:");
      lines.push(...notes);
    }
  }
  lines.push("");
  lines.push("action — one of:");
  lines.push("  absorb — guidance/context to fold into the CURRENT duty's work; no re-stage.");
  lines.push("  revisit — the run must go BACK to an earlier phase to incorporate this.");
  lines.push("  acknowledge — needs a reply but changes nothing about the run.");
  lines.push("revisit_duty — REQUIRED for revisit: one of the earlier phases listed above.");
  lines.push("confidence — one of: low, medium, high.");
  lines.push("reason — a short phrase (<= 120 chars).");
  lines.push("");
  lines.push('Respond exactly like: {"action":"absorb","confidence":"high","reason":"folds into current work"}');
  lines.push("");
  lines.push(`Message: """${String(message ?? "").slice(0, 2000)}"""`);
  return lines.join("\n");
}

export function steeringSchema() {
  return {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string" },
      revisit_duty: { type: "string" },
      confidence: { type: "string" },
      reason: { type: "string" }
    }
  };
}

// ── Parse + clamp ────────────────────────────────────────────────────────────
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

function toCandidate(reply) {
  if (reply == null) return null;
  if (typeof reply === "string") return extractJsonObject(reply);
  if (typeof reply === "object") {
    if (reply.structured && typeof reply.structured === "object") return reply.structured;
    if (typeof reply.text === "string") return extractJsonObject(reply.text);
    if ("action" in reply) return reply;
  }
  return null;
}

// Parse + clamp a steering reply. Null ONLY on total failure (no JSON object) —
// the caller then defaults to acknowledge/unclassifiable. An unknown action ->
// acknowledge; a revisit whose revisit_duty is not an earlier phase -> absorb.
export function parseSteering(reply, card) {
  const obj = toCandidate(reply);
  if (!obj || typeof obj !== "object") return null;
  const confidence =
    typeof obj.confidence === "string" && CONFIDENCE.has(obj.confidence.toLowerCase()) ? obj.confidence.toLowerCase() : "low";
  const action = typeof obj.action === "string" ? obj.action.toLowerCase().trim() : "";
  if (!STEER_ACTIONS.includes(action)) {
    return { action: "acknowledge", reason: "unclassifiable", confidence };
  }
  if (action === "revisit") {
    const phase = resolveEarlierPhase(card, obj.revisit_duty);
    if (!phase) return { action: "absorb", reason: "revisit target not an earlier phase; folding into current work", confidence };
    return { action: "revisit", revisitDuty: phase, reason: `revisit ${phase}`, confidence };
  }
  return { action, reason: action === "absorb" ? "folds into current work" : "reply only", confidence };
}

// ── Routing evidence (digest only, never the raw message / model free text) ──
export function steeringEvidence({ message, action, revisitDuty, confidence, at }) {
  const parts = [`steering: ${action ?? "?"}`];
  if (revisitDuty) parts.push(`revisit ${revisitDuty}`);
  if (confidence) parts.push(`confidence ${confidence}`);
  return {
    kind: "steering",
    at: at ?? null,
    messageDigest: messageDigest(message),
    action: action ?? null,
    revisitDuty: revisitDuty ?? null,
    confidence: confidence ?? null,
    reason: parts.join(", ")
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────
// classifySteering({ message, card, dutyVocab, call, evidenceFile, now, ...spec })
//   -> { action, revisitDuty?, reason, confidence, shortCircuit, evidence }
// Explicit phrasing short-circuits before the model call; otherwise ONE single-shot
// garrison-call (opts.call). No call + no short-circuit -> acknowledge (default).
export async function classifySteering(opts = {}) {
  const { message, card } = opts;
  const now = typeof opts.now === "function" ? opts.now : () => new Date().toISOString();

  let decision;
  const sc = steeringShortCircuit(message, card);
  if (sc) {
    decision = { ...sc, shortCircuit: true };
  } else if (typeof opts.call === "function") {
    const spec = {
      shape: opts.shape ?? "ollama",
      provider: opts.provider ?? "ollama-local",
      model: opts.model ?? "qwen2.5:3b",
      prompt: buildSteeringPrompt(message, card, opts.dutyVocab ?? null),
      schema: steeringSchema(),
      maxTokens: Number.isFinite(opts.maxTokens) ? opts.maxTokens : 256,
      timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 30000
    };
    let result;
    try {
      result = await opts.call(spec);
    } catch (err) {
      result = { ok: false, error: `steering call threw: ${err?.message || String(err)}` };
    }
    const ok = !!(result && result.ok);
    decision = { ...(ok ? parseSteering(result, card) : null) ?? { action: "acknowledge", reason: "unclassifiable", confidence: "low" }, shortCircuit: false };
  } else {
    decision = { action: "acknowledge", reason: "no steering classifier available", confidence: "low", shortCircuit: false };
  }

  const evidence = steeringEvidence({
    message,
    action: decision.action,
    revisitDuty: decision.revisitDuty ?? null,
    confidence: decision.confidence,
    at: now()
  });
  if (opts.evidenceFile) {
    try {
      await appendEvidence(opts.evidenceFile, evidence);
    } catch {
      /* evidence logging is best-effort */
    }
  }

  return { ...decision, evidence };
}

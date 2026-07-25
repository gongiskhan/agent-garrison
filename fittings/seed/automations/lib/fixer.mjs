// Self-healing fixer (ported from ekoa's rehearsal.ts). On a recoverable browser
// step failure, an LLM fixer (routed through the Model Router) proposes ONE patch
// — insert_before / replace_current / skip_current / pause_for_user / abort —
// applied + retried at the same index, budget-capped. A regex fast-path pauses
// immediately for CAPTCHA/MFA/payment/identity without a fixer round-trip.

import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

export const REHEARSAL_BUDGET = {
  maxFixerCalls: 25,
  maxWallClockMs: 4 * 60 * 1000,
  maxPatchesPerIndex: 5,
  maxNormalPauses: 5
};

function internalToken() {
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    return readFileSync(process.env.GARRISON_INTERNAL_TOKEN_PATH || path.join(home, "internal-token"), "utf8").trim();
  } catch {
    return "";
  }
}

// Cheap pattern check on a failure message: pause immediately for an obvious
// human-action case rather than waiting on the fixer.
export function detectHumanActionable(failureMessage) {
  if (!failureMessage) return null;
  const RULES = [
    {
      pattern: /(re-?capt?cha|cap?tcha|i'?m not a robot|não sou um robô|i am not a robot|hcaptcha|cloudflare.*(challenge|verify)|are you a robot|bot[- ]?check|bot[- ]?detection|\/sorry\/|unusual (traffic|activity)|automated (traffic|requests|queries)|verify (you are |that you are |you'?re )?(a )?human|prove (you'?re|you are) (a )?human|are you (a )?human)/i,
      out: { reasoning: "Detected a CAPTCHA / bot-check page", userInstructions: "Solve the bot-check / CAPTCHA in the browser, then click Continue." }
    },
    {
      pattern: /(two[- ]?factor|2[- ]?factor|2fa|mfa|authenticator (app|code)|6[- ]?digit code|enter (the|your) code|security code|one[- ]?time (passcode|password)|otp\b|verification code)/i,
      out: { reasoning: "Detected a multi-factor authentication step", userInstructions: "Enter the code from your authenticator/phone in the browser, then click Continue." }
    },
    {
      pattern: /(3-?d secure|3ds|sca challenge|step[- ]?up authentication|confirm.*payment|confirm.*purchase|confirm.*transaction|approve.*payment)/i,
      out: { reasoning: "Detected a payment confirmation prompt", userInstructions: "Confirm the payment in the browser, then click Continue." }
    },
    {
      pattern: /(verify (your|it'?s) (you|identity)|confirm (your|it'?s) (you|identity)|trusted device|unusual sign[- ]?in|let'?s make sure it'?s you)/i,
      out: { reasoning: "Detected an identity-verification prompt", userInstructions: "Complete the identity check in the browser, then click Continue." }
    }
  ];
  for (const r of RULES) if (r.pattern.test(failureMessage)) return r.out;
  return null;
}

// Apply a patch to the working steps at currentIndex (returns a new array).
export function applyPatch(steps, currentIndex, patch) {
  const out = steps.slice();
  switch (patch.kind) {
    case "insert_before":
      // Pass the ids already in play: the fix prompt shows the model the
      // failing step's full JSON (id included), so it can echo that id back in
      // newStep. That would put TWO steps with the same id in one run, which
      // breaks the step-id uniqueness invariant validateAutomation enforces at
      // authoring time — the caches are keyed (automationId, stepId,
      // fingerprint), so the inserted step would write its action/assertion
      // into the real check's cache slot and be replayed AS that check on the
      // next run, and per-step result lookups would resolve ambiguously.
      out.splice(currentIndex, 0, normaliseInserted(patch.newStep, new Set(out.map((s) => s?.id).filter(Boolean))));
      return out;
    case "replace_current": {
      // A replacement still fulfills the same logical plan item. Preserve the
      // original id so run consumers (including Drill) can correlate the
      // repaired result instead of reporting an invented "step missing"
      // infrastructure incident after a successful recovery.
      const replacement = normaliseInserted(patch.newStep);
      out.splice(currentIndex, 1, {
        ...replacement,
        id: out[currentIndex]?.id || replacement.id
      });
      return out;
    }
    case "skip_current":
      out.splice(currentIndex, 1);
      return out;
    case "pause_for_user":
    case "abort":
      return out; // plan unchanged
    default:
      throw new Error(`unknown patch kind: ${patch.kind}`);
  }
}

// `takenIds` (insert paths only) forces a fresh id when the model echoes one
// that is already in the run. replace_current deliberately does NOT pass it —
// it replaces in place, so reusing the id is correct and creates no duplicate.
function normaliseInserted(step, takenIds) {
  if (!step || typeof step !== "object") throw new Error("patch newStep must be a step object");
  const mint = () => `fix-${Math.random().toString(36).slice(2, 8)}`;
  const proposed = step.id && String(step.id).trim() ? String(step.id) : null;
  let id = proposed && !(takenIds && takenIds.has(proposed)) ? proposed : mint();
  while (takenIds && takenIds.has(id)) id = mint();
  return { ...step, id };
}

// The fixer is a MODEL proposing recovery steps — it may ONLY introduce
// page-repair steps. It must NOT be able to inject local_command / connector /
// api_call / sub_automation (that would turn a model patch into shell / network /
// connector execution authority). Enforced here at the single validation
// chokepoint every patch passes through.
export const FIXER_ALLOWED_STEP_TYPES = ["browser", "verify", "navigate", "wait"];

export function validatePatch(value) {
  if (!value || typeof value !== "object") throw new Error("patch must be an object");
  const kind = value.patch ?? value.kind;
  const reasoning = typeof value.reasoning === "string" ? value.reasoning : "";
  if (kind === "skip_current") return { kind: "skip_current", reasoning };
  if (kind === "abort") {
    // Two very different situations end in abort, and conflating them is how a
    // check that was never actually exercised gets reported as an app defect.
    // Default to the conservative reading (a real product failure) so a model
    // that omits the field can never silently downgrade a genuine defect.
    const cause = value.cause === "check-unrunnable" ? "check-unrunnable" : "outcome-not-met";
    return { kind: "abort", reasoning, cause };
  }
  if (kind === "pause_for_user") {
    return { kind: "pause_for_user", reasoning, userInstructions: value.userInstructions ?? "Act on the page, then Continue." };
  }
  if (kind === "insert_before" || kind === "replace_current") {
    if (!value.newStep || typeof value.newStep !== "object") throw new Error(`${kind} requires newStep`);
    if (!FIXER_ALLOWED_STEP_TYPES.includes(value.newStep.type)) {
      throw new Error(`fixer may only introduce ${FIXER_ALLOWED_STEP_TYPES.join("/")} steps, not "${value.newStep.type}"`);
    }
    return { kind, reasoning, newStep: value.newStep };
  }
  throw new Error(`unknown patch kind: ${kind}`);
}

// Ask the fixer (Router-routed by default) for ONE patch. `invoke(failureKind,
// step, error, observation) -> rawPatch` is injectable.
export async function proposePatch({ step, error, observation = {}, failureKind = "other", invoke, fetchImpl = globalThis.fetch }) {
  const run = invoke || (async () => {
    const base = process.env.GARRISON_BASE_URL || "http://127.0.0.1:27777";
    let res;
    try {
      res = await fetchImpl(`${base}/api/automations/vision`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-garrison-internal": internalToken() },
        body: JSON.stringify({ observation, step: { ...step, __fix: { error, failureKind } }, mode: "fix" })
      });
    } catch (cause) {
      const failure = new Error(`fixer connection failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      failure.failure = { class: "infrastructure", component: "fixer", code: "fixer-transport", retryable: true };
      throw failure;
    }
    if (!res.ok) {
      const failure = new Error(`fixer ${res.status}`);
      failure.failure = { class: "infrastructure", component: "fixer", code: `fixer-http-${res.status}`, retryable: res.status >= 500 };
      throw failure;
    }
    return (await res.json()).result;
  });
  try {
    const raw = await run(failureKind, step, error, observation);
    return validatePatch(raw);
  } catch (cause) {
    if (cause?.failure) throw cause;
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    failure.failure = { class: "infrastructure", component: "fixer", code: "fixer-invalid-response", retryable: true };
    throw failure;
  }
}

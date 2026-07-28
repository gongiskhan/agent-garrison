// The cache -> vision -> execute orchestration for browser/verify/navigate steps
// (decision F2: lives INSIDE the Automations fitting; the Browser fitting stays a
// pure service). Ported from ekoa's tier model:
//   - navigate: deterministic (no vision).
//   - browser:  planner cachedAction / action cache -> replay it (tier "cached");
//               on miss OR a deterministic-action failure -> vision-resolve via
//               the Router, execute, write the cache (tier "vision", or
//               "recovered" if a deterministic action had failed first).
//   - verify:   planner cachedAssertion / assertion cache (deterministic) else
//               vision verify; write the assertion cache on pass.
// All model + browser I/O is injected via `deps` so the tier logic is unit-tested
// deterministically; the live deps (Browser fitting client + Router vision) are
// wired by the engine host.

import { fingerprintFromParts } from "./fingerprint.mjs";
import { lookupActionCache, writeActionCache, evictAction, lookupAssertionCache, writeAssertionCache } from "./cache.mjs";

// bypassCache (engine delta 2, R12): the blind adversarial pass runs vision-
// forced with the cache ignored — no lookup, no write, so it neither reuses a
// prior (possibly implementer-biased) resolution nor pollutes the shared cache
// with an adversarial run's actions/assertions.
export async function runBrowserStep({ automationId, step, deps, bypassCache = false }) {
  const observe = deps.observe;
  if (step.type === "navigate") {
    try {
      await deps.navigate(step.url);
    } catch (err) {
      // A page-level navigation failure can be repaired, but a Browser fitting
      // transport/outage cannot. Preserve the client's structured
      // infrastructure classification so the engine fails fast instead of
      // feeding infra noise into the fixer.
      if (err.failure?.class === "infrastructure") err.recoverable = false;
      else if (err.recoverable === undefined) err.recoverable = true;
      throw err;
    }
    return { tier: "execute", url: step.url };
  }

  // Observe the page first. An observe failure is INFRASTRUCTURE (Browser Fitting
  // down) — left non-recoverable so the engine fails fast rather than fixer-loop.
  const obs = await observe();
  const fp = fingerprintFromParts(obs);

  // Page-level failures below ARE recoverable — the fixer can dismiss an overlay,
  // replace the action, etc.
  try {
    return await resolvePageStep({ automationId, step, deps, obs, fp, bypassCache });
  } catch (err) {
    if (err.failure?.class === "infrastructure") err.recoverable = false;
    else if (err.recoverable === undefined) err.recoverable = true;
    if (obs?.screenshotB64 && !err.evidenceScreenshotB64) {
      err.evidenceScreenshotB64 = obs.screenshotB64;
    }
    throw err;
  }
}

// Evidence (engine delta 7): every resolved step carries back the screenshot
// already fetched by observe({screenshot:true}) — no extra round trip. The
// engine writes it to a plain file and drops the base64 before persisting/
// emitting the step result (R13 — no artifact store, just a file + a link).
const VISIBLE_ERROR_FAMILIES = [
  {
    code: "visible-timeout",
    visible: /\b(?:request\s+)?timed?\s*out\b|\btimeout\b/i,
    expected: /\btimed?\s*out\b|\btimeout\b/i
  },
  {
    code: "visible-network-error",
    visible: /failed to fetch|network error|connection refused|econnrefused|não foi possível ligar/i,
    expected: /failed to fetch|network error|connection refused|econnrefused|não foi possível ligar/i
  },
  {
    code: "visible-invalid-credentials",
    visible: /invalid credentials|invalid username or password|credenciais inválidas/i,
    expected: /invalid credentials|invalid username or password|credenciais inválidas/i
  },
  {
    code: "visible-service-error",
    visible: /internal server error|service unavailable|serviço indisponível|\bhttp\s*50[0-9]\b/i,
    expected: /internal server error|service unavailable|serviço indisponível|\bhttp\s*50[0-9]\b/i
  },
  {
    code: "visible-unexpected-error",
    visible: /something went wrong|unexpected error|erro inesperado|ocorreu um erro/i,
    expected: /something went wrong|unexpected error|erro inesperado|ocorreu um erro/i
  }
];

function unexpectedReferenceWarnings(obs, step) {
  const expectation = String(step?.description ?? step?.expectedOutcome ?? "");
  const names = [...new Set(
    (obs?.a11y ?? [])
      .map((node) => String(node?.name ?? "").trim())
      .filter(Boolean)
  )];
  const warnings = [];
  for (const family of VISIBLE_ERROR_FAMILIES) {
    if (family.expected.test(expectation)) continue;
    const visible = names.find((name) => family.visible.test(name));
    if (visible) warnings.push({ code: family.code, text: visible.slice(0, 300) });
  }
  return warnings;
}

function withEvidence(result, obs, step) {
  const referenceWarnings = unexpectedReferenceWarnings(obs, step);
  return {
    ...result,
    ...(referenceWarnings.length ? { referenceWarnings } : {}),
    ...(obs?.screenshotB64 ? { evidence: { screenshotB64: obs.screenshotB64 } } : {})
  };
}

async function resolvePageStep({ automationId, step, deps, obs, fp, bypassCache }) {
  if (step.type === "verify") {
    // Deterministic assertion first (planner-authored or cached), else vision.
    // bypassCache (R12) ignores BOTH the shared cache store and any planner-
    // authored cachedAssertion on the step — the blind pass is blind to specs too.
    const cached = !bypassCache && (step.cachedAssertion || (await lookupAssertionCache(automationId, step.id, fp))?.assertion);
    if (cached) {
      const passed = await deps.executeAssertion(cached);
      if (passed) return withEvidence({ tier: "cached", passed: true, assertion: cached }, obs, step);
      // fall through to vision on a failed deterministic assertion
    }
    const verdict = await deps.verifyViaVision({ observation: obs, step });
    // Honesty gate: the model reports when the expected outcome cannot exist
    // without an interaction that plainly has not happened. Such a verdict is
    // not evidence either way, so it must never be cached — caching it is how
    // one unobservable pass becomes a permanent deterministic answer that no
    // future run ever re-examines.
    const requiresInteraction = verdict.requiresInteraction === true;
    if (verdict.passed && verdict.assertion && !bypassCache && !requiresInteraction) {
      await writeAssertionCache({ automationId, stepId: step.id, fingerprint: fp, assertion: verdict.assertion });
    }
    if (!verdict.passed) {
      const err = new Error(`verify failed: ${verdict.reasoning ?? "outcome not met"}`);
      err.recoverable = true;
      throw err;
    }
    // Surface the model-discovered assertion on the result too (not just the
    // cache write above) — a consumer that graduates vision to a committed
    // spec (Drill's B8) needs to know WHAT was verified, not just that it was.
    // This object hand-builds its keys, so the flag must be carried explicitly
    // or it is dropped before any consumer sees it.
    return withEvidence({
      tier: cached ? "recovered" : "vision",
      passed: true,
      reasoning: verdict.reasoning,
      assertion: verdict.assertion,
      ...(requiresInteraction
        ? {
            requiresInteraction: true,
            ...(verdict.missingInteraction
              ? { missingInteraction: String(verdict.missingInteraction).slice(0, 300) }
              : {})
          }
        : {})
    }, obs, step);
  }

  // browser action step. Two sources of a deterministic action, in order:
  //
  //   1. step.cachedAction — PINNED by the caller's plan, exactly the role
  //      cachedAssertion plays for verify. This exists because the
  //      fingerprint below is a content hash (pathname + title/heading/DOM-
  //      shape digests): an app whose URL carries a session id, or whose node
  //      counts move as content loads, fingerprints differently on EVERY run,
  //      so the store alone can never make a real app's interactions
  //      deterministic — it just accumulates one entry per run and re-resolves
  //      through vision anyway. A pin is keyed to the step, not to what the
  //      page happened to look like when it was learned.
  //   2. the fingerprint-keyed store — still worth consulting for steps the
  //      caller has no pin for (an ad-hoc automation, a repaired step).
  //
  // Both are withheld when bypassCache is set, same as cachedAssertion.
  const pinned = bypassCache ? null : step.cachedAction ?? null;
  const cached = pinned || bypassCache ? null : await lookupActionCache(automationId, step.id, fp);
  const deterministic = pinned ?? cached?.action ?? null;
  if (deterministic) {
    try {
      await deps.executeAction(deterministic);
      return withEvidence({ tier: "cached", action: deterministic }, obs, step);
    } catch {
      // Stale selector. Only the fingerprint entry is ours to evict — a pin
      // lives in the caller's plan, and "recovered" below is how the caller
      // learns the pin no longer matches and re-pins the healed action.
      if (cached) await evictAction(automationId, step.id, fp);
    }
  }
  const action = await deps.resolveViaVision({ observation: obs, step });
  await deps.executeAction(action);
  if (!bypassCache) {
    await writeActionCache({ automationId, stepId: step.id, fingerprint: fp, action, confidence: deterministic ? "medium" : "high" });
  }
  return withEvidence({ tier: deterministic ? "recovered" : "vision", action }, obs, step);
}

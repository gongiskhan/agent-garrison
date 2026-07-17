// The cache -> vision -> execute orchestration for browser/verify/navigate steps
// (decision F2: lives INSIDE the Automations fitting; the Browser fitting stays a
// pure service). Ported from ekoa's tier model:
//   - navigate: deterministic (no vision).
//   - browser:  cache hit -> replay cached action (tier "cached"); on miss OR a
//               cache-action failure -> vision-resolve via the Router, execute,
//               write the cache (tier "vision", or "recovered" if a cached action
//               had failed first).
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
      err.recoverable = true; // navigate_failed -> fixer can retry/replace
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
    if (err.recoverable === undefined) err.recoverable = true;
    throw err;
  }
}

// Evidence (engine delta 7): every resolved step carries back the screenshot
// already fetched by observe({screenshot:true}) — no extra round trip. The
// engine writes it to a plain file and drops the base64 before persisting/
// emitting the step result (R13 — no artifact store, just a file + a link).
function withEvidence(result, obs) {
  return obs?.screenshotB64 ? { ...result, evidence: { screenshotB64: obs.screenshotB64 } } : result;
}

async function resolvePageStep({ automationId, step, deps, obs, fp, bypassCache }) {
  if (step.type === "verify") {
    // Deterministic assertion first (planner-authored or cached), else vision.
    // bypassCache (R12) ignores BOTH the shared cache store and any planner-
    // authored cachedAssertion on the step — the blind pass is blind to specs too.
    const cached = !bypassCache && (step.cachedAssertion || (await lookupAssertionCache(automationId, step.id, fp))?.assertion);
    if (cached) {
      const passed = await deps.executeAssertion(cached);
      if (passed) return withEvidence({ tier: "cached", passed: true, assertion: cached }, obs);
      // fall through to vision on a failed deterministic assertion
    }
    const verdict = await deps.verifyViaVision({ observation: obs, step });
    if (verdict.passed && verdict.assertion && !bypassCache) {
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
    return withEvidence({ tier: cached ? "recovered" : "vision", passed: true, reasoning: verdict.reasoning, assertion: verdict.assertion }, obs);
  }

  // browser action step
  const cached = !bypassCache && (await lookupActionCache(automationId, step.id, fp));
  if (cached) {
    try {
      await deps.executeAction(cached.action);
      return withEvidence({ tier: "cached", action: cached.action }, obs);
    } catch {
      // cached selector stale — evict and recover via vision
      await evictAction(automationId, step.id, fp);
    }
  }
  const action = await deps.resolveViaVision({ observation: obs, step });
  await deps.executeAction(action);
  if (!bypassCache) {
    await writeActionCache({ automationId, stepId: step.id, fingerprint: fp, action, confidence: cached ? "medium" : "high" });
  }
  return withEvidence({ tier: cached ? "recovered" : "vision", action }, obs);
}

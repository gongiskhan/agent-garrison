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

export async function runBrowserStep({ automationId, step, deps }) {
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
    return await resolvePageStep({ automationId, step, deps, obs, fp });
  } catch (err) {
    if (err.recoverable === undefined) err.recoverable = true;
    throw err;
  }
}

async function resolvePageStep({ automationId, step, deps, obs, fp }) {
  if (step.type === "verify") {
    // Deterministic assertion first (planner-authored or cached), else vision.
    const cached = step.cachedAssertion || (await lookupAssertionCache(automationId, step.id, fp))?.assertion;
    if (cached) {
      const passed = await deps.executeAssertion(cached);
      if (passed) return { tier: "cached", passed: true, assertion: cached };
      // fall through to vision on a failed deterministic assertion
    }
    const verdict = await deps.verifyViaVision({ observation: obs, step });
    if (verdict.passed && verdict.assertion) {
      await writeAssertionCache({ automationId, stepId: step.id, fingerprint: fp, assertion: verdict.assertion });
    }
    if (!verdict.passed) {
      const err = new Error(`verify failed: ${verdict.reasoning ?? "outcome not met"}`);
      err.recoverable = true;
      throw err;
    }
    return { tier: cached ? "recovered" : "vision", passed: true, reasoning: verdict.reasoning };
  }

  // browser action step
  const cached = await lookupActionCache(automationId, step.id, fp);
  if (cached) {
    try {
      await deps.executeAction(cached.action);
      return { tier: "cached", action: cached.action };
    } catch {
      // cached selector stale — evict and recover via vision
      await evictAction(automationId, step.id, fp);
    }
  }
  const action = await deps.resolveViaVision({ observation: obs, step });
  await deps.executeAction(action);
  await writeActionCache({ automationId, stepId: step.id, fingerprint: fp, action, confidence: cached ? "medium" : "high" });
  return { tier: cached ? "recovered" : "vision", action };
}

// Thin client to the Automations engine's HTTP API (D1: Drill consumes engine
// deltas over HTTP, no shared library). Status-file discovery, same
// convention as browser-fitting-client.mjs.

import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

export function automationsBaseUrl() {
  if (process.env.GARRISON_AUTOMATIONS_URL) return process.env.GARRISON_AUTOMATIONS_URL;
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const status = JSON.parse(readFileSync(path.join(home, "ui-fittings", "automations.json"), "utf8"));
    return status.url || null;
  } catch {
    return null;
  }
}

function requireBase() {
  const base = automationsBaseUrl();
  if (!base) throw new Error("automations fitting not running (no GARRISON_AUTOMATIONS_URL / status file)");
  return base;
}

async function json(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `automations ${res.status}`);
  return body;
}

// Inline ephemeral run (engine delta 1) — contextTag identifies the caller
// (e.g. "drill" / "drill-adversarial") with no drill-specific naming inside
// the engine itself. captureSession (delta 8) groups the run's tab into a
// recorded browser capture context for evidence; opaque to the engine.
export async function runInline({ automation, inputs, contextTag, bypassCache, viewport, captureSession, sync = true, fetchImpl = globalThis.fetch }) {
  const base = requireBase();
  const qs = sync ? "?sync=1" : "";
  const res = await fetchImpl(`${base}/api/automations/run-inline${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ automation, inputs, contextTag, bypassCache, viewport, captureSession })
  });
  return json(res);
}

// Run matrix (engine delta 6) — the same automation once per named viewport.
export async function runMatrix({ automation, viewports, inputs, contextTag, bypassCache, fetchImpl = globalThis.fetch }) {
  const base = requireBase();
  const res = await fetchImpl(`${base}/api/automations/run-matrix`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ automation, viewports, inputs, contextTag, bypassCache })
  });
  return json(res);
}

export async function getRun(runId, { fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  const res = await fetchImpl(`${base}/api/runs/${encodeURIComponent(runId)}`);
  if (res.status === 404) return null;
  return (await json(res)).run;
}

export async function getStepEvidence(runId, stepId, { fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  const res = await fetchImpl(
    `${base}/api/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/evidence`
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`automations ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function checkAutomationsHealth({ fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  const res = await fetchImpl(`${base}/health`);
  if (!res.ok) throw new Error(`automations ${res.status}`);
  return true;
}

// Run-entry self-heal: the engine is a non-eager own-port fitting, so every
// redeploy's down() kills it and the next drill run used to die instantly with
// one automations-unavailable incident per planned check. Before giving up,
// ask Garrison for the same on-demand lifecycle start the Views UI performs
// (env injected server-side by operativeEnvForFitting), then wait for /health.
// Without GARRISON_BASE_URL there is nothing to start against — fail as before.
export async function ensureAutomationsUp({ timeoutMs = 25000, pollMs = 500, fetchImpl = globalThis.fetch } = {}) {
  let downErr;
  try {
    return await checkAutomationsHealth({ fetchImpl });
  } catch (err) {
    downErr = err;
  }
  const garrison = (process.env.GARRISON_BASE_URL || "").replace(/\/+$/, "");
  if (!garrison) throw downErr;
  let failure = null;
  try {
    // requireCompositionEnv: refuse (409) instead of spawning an env-less
    // engine when no composition is running (the redeploy window) - a bare
    // spawn would come up healthy on default instance ports and poison every
    // later run with wrong-instance failures nothing self-repairs.
    const res = await fetchImpl(`${garrison}/api/fittings/automations/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requireCompositionEnv: true })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) failure = new Error(body.error || `garrison ${res.status}`);
  } catch (err) {
    failure = err;
  }
  if (!failure) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      try {
        // Re-resolves the base each poll — the fresh spawn's status file is
        // what makes discovery succeed.
        return await checkAutomationsHealth({ fetchImpl });
      } catch {
        // not up yet
      }
    }
    failure = new Error(`engine not healthy within ${Math.round(timeoutMs / 1000)}s of start`);
  }
  // Keep the "automations fitting not running" prefix — the infra classifiers
  // in runs-store.mjs / run-outcome.mjs key automations-unavailable off it.
  throw new Error(`automations fitting not running (auto-start failed: ${failure.message})`);
}

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
// the engine itself.
export async function runInline({ automation, inputs, contextTag, bypassCache, viewport, sync = true, fetchImpl = globalThis.fetch }) {
  const base = requireBase();
  const qs = sync ? "?sync=1" : "";
  const res = await fetchImpl(`${base}/api/automations/run-inline${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ automation, inputs, contextTag, bypassCache, viewport })
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

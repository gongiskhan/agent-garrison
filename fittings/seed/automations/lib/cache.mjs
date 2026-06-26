// Fingerprint-keyed action/assertion cache (ported from ekoa's cache.ts; storage
// adapted to a machine-local JSON file per automation). On a cache hit a browser
// step replays the remembered Playwright action WITHOUT a vision call; on a miss
// or a cache-action failure it falls through to vision and writes the result
// back. Keyed by (stepId, fingerprintKey) so the same step on a structurally
// identical page reuses the action.

import fs from "node:fs/promises";
import path from "node:path";
import { automationsDir } from "./store.mjs";
import { fingerprintKey } from "./fingerprint.mjs";

function cacheFile(automationId) {
  const safe = String(automationId).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safe || safe !== String(automationId)) throw new Error(`invalid automation id: ${automationId}`);
  return path.join(automationsDir(), "cache", `${safe}.json`);
}

async function load(automationId) {
  try {
    return JSON.parse(await fs.readFile(cacheFile(automationId), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { actions: {}, assertions: {} };
    throw err;
  }
}

async function save(automationId, data) {
  const file = cacheFile(automationId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

const keyOf = (stepId, fp) => `${stepId}|${fingerprintKey(fp)}`;

export async function lookupActionCache(automationId, stepId, fingerprint) {
  const data = await load(automationId);
  return data.actions[keyOf(stepId, fingerprint)] ?? null;
}

export async function writeActionCache({ automationId, stepId, fingerprint, action, confidence = "high" }) {
  const data = await load(automationId);
  const key = keyOf(stepId, fingerprint);
  const prev = data.actions[key];
  data.actions[key] = {
    kind: "action-cache",
    fingerprintKey: fingerprintKey(fingerprint),
    action,
    successCount: (prev?.successCount ?? 0) + 1,
    lastUsedAt: new Date().toISOString(),
    confidence
  };
  await save(automationId, data);
  return data.actions[key];
}

export async function evictAction(automationId, stepId, fingerprint) {
  const data = await load(automationId);
  const key = keyOf(stepId, fingerprint);
  const had = key in data.actions;
  delete data.actions[key];
  await save(automationId, data);
  return had;
}

export async function lookupAssertionCache(automationId, stepId, fingerprint) {
  const data = await load(automationId);
  return data.assertions[keyOf(stepId, fingerprint)] ?? null;
}

export async function writeAssertionCache({ automationId, stepId, fingerprint, assertion }) {
  const data = await load(automationId);
  const key = keyOf(stepId, fingerprint);
  const prev = data.assertions[key];
  data.assertions[key] = {
    kind: "assertion-cache",
    fingerprintKey: fingerprintKey(fingerprint),
    assertion,
    successCount: (prev?.successCount ?? 0) + 1,
    lastUsedAt: new Date().toISOString()
  };
  await save(automationId, data);
  return data.assertions[key];
}

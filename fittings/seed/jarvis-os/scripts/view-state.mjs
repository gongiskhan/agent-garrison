// View-state persistence helper — the own-port-fitting side of Garrison's
// generic view-state contract (src/lib/view-state.ts). Same on-disk grain:
//   ~/.garrison/view-state/<fittingId>/<instanceId>.json
//   { fittingId, instanceId, updatedAt, state }
// Fittings are standalone packages, so this mirrors the convention directly
// (copied from fittings/seed/dev-env/scripts/view-state.mjs, the reference
// implementation) instead of importing Garrison. Writes are debounced +
// atomic (sibling tmp + rename); there is no save action anywhere — state
// flows continuously. jarvis-os only ever has one instance ("default" — the
// HUD is a single always-mounted surface, not per-session like dev-env's
// PTY tabs), but the helper stays generic on (fittingId, instanceId) so it's
// a straight copy, not a fork.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const DEBOUNCE_MS = 500;

function garrisonHome() {
  const override = process.env.GARRISON_HOME?.trim();
  return override || path.join(os.homedir(), ".garrison");
}

function assertSlug(value, label) {
  if (typeof value !== "string" || !SLUG_RE.test(value) || value.includes("..")) {
    throw new Error(`invalid ${label} for view-state path: ${JSON.stringify(value)}`);
  }
}

export function instanceFile(fittingId, instanceId) {
  assertSlug(fittingId, "fitting id");
  assertSlug(instanceId, "instance id");
  return path.join(garrisonHome(), "view-state", fittingId, `${instanceId}.json`);
}

export async function writeInstanceState(fittingId, instanceId, state) {
  const file = instanceFile(fittingId, instanceId);
  await mkdir(path.dirname(file), { recursive: true });
  const envelope = {
    fittingId,
    instanceId,
    updatedAt: new Date().toISOString(),
    state
  };
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  return envelope;
}

export async function readInstanceState(fittingId, instanceId) {
  try {
    const raw = await readFile(instanceFile(fittingId, instanceId), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "state" in parsed) {
      return { exists: true, state: parsed.state, updatedAt: parsed.updatedAt ?? "" };
    }
  } catch {}
  return { exists: false };
}

// Debounced continuous persistence. The state factory is evaluated at fire
// time (not schedule time) so the freshest value lands on disk. Trailing
// debounce with a max-latency backstop: a burst of changes inside 500ms of
// each other would otherwise push the write out forever.
const pending = new Map(); // key -> { timer, factory, firstScheduledAt }
const MAX_DELAY_MS = 5000;

export function scheduleInstanceWrite(fittingId, instanceId, stateFactory, delayMs = DEBOUNCE_MS) {
  instanceFile(fittingId, instanceId); // validate ids at schedule time
  const key = `${fittingId}/${instanceId}`;
  const existing = pending.get(key);
  const firstScheduledAt = existing?.firstScheduledAt ?? Date.now();
  if (existing) clearTimeout(existing.timer);
  const overdue = Date.now() - firstScheduledAt >= MAX_DELAY_MS;
  const timer = setTimeout(() => {
    pending.delete(key);
    Promise.resolve()
      .then(stateFactory)
      .then((state) => writeInstanceState(fittingId, instanceId, state))
      .catch((err) => console.error(`[view-state] write failed for ${key}:`, err));
  }, overdue ? 0 : delayMs);
  timer.unref?.();
  pending.set(key, { timer, factory: stateFactory, firstScheduledAt });
}

// Flush every pending debounced write now (shutdown path).
export async function flushInstanceWrites() {
  const entries = [...pending.entries()];
  pending.clear();
  await Promise.all(
    entries.map(([key, { timer, factory }]) => {
      clearTimeout(timer);
      const [fittingId, instanceId] = key.split("/");
      return Promise.resolve()
        .then(factory)
        .then((state) => writeInstanceState(fittingId, instanceId, state))
        .catch((err) => console.error(`[view-state] flush failed for ${key}:`, err));
    })
  );
}

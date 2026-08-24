// The scheduler daemon's git event pump — the DOWN-SURVIVAL floor under the
// file-browser fitting's richer pump. Division of labour is by liveness, not
// preference: when the file-browser fitting is RUNNING it owns
// git.commit-push.request handling (its status file is the single source of
// truth for that, as always); when the operative is down and the fitting died
// with it, THIS pump answers, calling the Next app's internal-token-guarded
// /api/mesh/git/commit-push over loopback. That is exactly the moment a node
// is "behind" and most needs its work reachable by the nightly card.

import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createStateClient } from "./state-client.mjs";

const POLL_MS = 10_000;
const MAX_AGE_MS = 5 * 60_000;

let warned = false;
let cursor = 0;

function home() {
  return process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
}

function fittingAlive() {
  try {
    const status = JSON.parse(readFileSync(path.join(home(), "ui-fittings", "file-browser.json"), "utf8"));
    return Boolean(status?.pid);
  } catch {
    return false;
  }
}

function appUrl() {
  const explicit = process.env.GARRISON_APP_URL?.trim();
  if (explicit) return explicit;
  const port = process.env.GARRISON_APP_PORT?.trim() || process.env.PORT?.trim();
  return port ? `http://127.0.0.1:${port}` : null;
}

function internalToken() {
  try {
    return readFileSync(path.join(home(), "internal-token"), "utf8").trim();
  } catch {
    return null;
  }
}

function client() {
  try {
    return createStateClient({
      env: { GARRISON_HOME: home(), ...process.env },
      readFileSync: (p, enc) => readFileSync(p, enc)
    });
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`[git-pump] not enrolled in the mesh; pump idle (${err?.message ?? err})`);
    }
    return null;
  }
}

export function startGitPump({ log = console } = {}) {
  if (process.env.GARRISON_DISABLE_GIT_PUMP === "1") return null;
  const timer = setInterval(async () => {
    try {
      // The fitting owns the lane while it lives.
      if (fittingAlive()) return;
      const c = client();
      if (!c) return;
      const self = c.node ?? process.env.GARRISON_NODE_NAME ?? null;
      const events = await c.listEvents({ kind: "git.commit-push.request", sinceSeq: cursor, limit: 50 });
      for (const ev of events) {
        cursor = Math.max(cursor, ev.seq);
        if (Date.now() - Date.parse(ev.at) > MAX_AGE_MS) continue;
        if (ev.payload?.requestedBy === self) continue;
        // Someone (this node's fitting pre-down, or an earlier tick) may have
        // replied already — a restart must not produce a duplicate commit.
        const replies = await c.listEvents({ kind: "git.commit-push.reply", sinceSeq: Math.max(0, ev.seq - 1), limit: 100 });
        const reqId = ev.payload?.requestId ?? null;
        if (replies.some((r) => (r.payload?.requestId ?? null) === reqId && (r.payload?.node ?? r.node) === self)) continue;
        const url = appUrl();
        const token = internalToken();
        if (!url || !token) {
          log.warn?.("[git-pump] app url or internal token unavailable; cannot execute");
          continue;
        }
        const res = await fetch(`${url}/api/mesh/git/commit-push`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-garrison-internal": token },
          body: JSON.stringify({ project: ev.payload?.project }),
          signal: AbortSignal.timeout(90_000)
        });
        const result = await res.json().catch(() => ({}));
        await c.appendEvent({
          kind: "git.commit-push.reply",
          subjectType: "project",
          subjectId: String(ev.payload?.project ?? ""),
          payload: {
            // The fitting protocol's correlation keys FIRST — a reply the
            // requester cannot match is a reply that never happened (proven
            // live on the first cross-node pull).
            requestId: ev.payload?.requestId ?? null,
            node: self,
            requestSeq: ev.seq,
            project: ev.payload?.project,
            via: "scheduler-daemon",
            ...(res.ok ? result : { result: "error", detail: result?.detail ?? `http ${res.status}` })
          }
        });
        log.log?.(`[git-pump] answered commit-push for ${ev.payload?.project} (${res.ok ? result.result : "error"})`);
      }
    } catch (err) {
      // A pump error is a log line, never a crash — the scheduler must tick on.
      log.warn?.(`[git-pump] tick failed: ${err?.message ?? err}`);
    }
  }, POLL_MS);
  timer.unref?.();
  return timer;
}

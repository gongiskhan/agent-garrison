// Best-effort Beads readers for the read-bundle + digest. All functions return
// empty/[] on ANY failure (bd absent, no .beads graph, parse error) — coordination
// is advisory and must never error a session.
import { execFileSync } from "node:child_process";

function bdJson(repo, args) {
  try {
    const out = execFileSync("bd", [...args, "--json"], {
      cwd: repo,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000
    }).toString();
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : parsed.issues || parsed.items || [];
  } catch {
    return [];
  }
}

// Liveness for the unified state / observability view: is the bd CLI reachable,
// with latency. (Beads' Claude Code integration is the CLI + a SessionStart hook,
// not a server — so liveness == the CLI responding.)
export function beadsLiveness() {
  const start = Date.now();
  try {
    execFileSync("bd", ["version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 4000 });
    return { up: true, latencyMs: Date.now() - start };
  } catch {
    return { up: false };
  }
}

export function beadsAvailable() {
  try {
    execFileSync("bd", ["version"], { stdio: ["ignore", "ignore", "ignore"], timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// In-progress work in this repo (intents/decisions currently in flight).
export function readBeadsInflight(repo) {
  const items = bdJson(repo, ["list", "--status", "in_progress"]);
  return items.slice(0, 25).map((i) => ({
    id: i.id,
    title: i.title,
    assignee: i.assignee,
    status: i.status,
    updated: i.updated_at || i.updatedAt
  }));
}

// Recent decisions/issues for context (best-effort).
export function readBeadsRecent(repo) {
  const items = bdJson(repo, ["list", "--status", "open"]);
  return items.slice(0, 25).map((i) => ({ id: i.id, title: i.title, status: i.status }));
}

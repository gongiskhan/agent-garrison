// Per-repo plan ledger — records each released plan so the NEXT planner inherits
// it. This sidesteps the unreliable global-plans association problem (Claude Code
// plans live in ~/.claude/plans with random, non-repo-keyed names): coord-mcp owns
// a repo-keyed record of what each planning session declared.
//
// Ledger: ~/.garrison/coord/plans/<repoSlug>.jsonl (append-only)
//   { repo, session, summary, startedAt, releasedAt }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoSlug } from "./repo.mjs";
import { withinLookback } from "./lookback.mjs";

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".garrison");
}
function planDir() {
  return path.join(garrisonHome(), "coord", "plans");
}
function planPath(repo) {
  return path.join(planDir(), `${repoSlug(repo)}.jsonl`);
}

export function recordPlan(repo, entry) {
  fs.mkdirSync(planDir(), { recursive: true });
  fs.appendFileSync(planPath(repo), JSON.stringify({ repo, ...entry }) + "\n");
}

// Defensive parse: skip blank + partial trailing lines (the file may be appended
// to while we read).
export function readPlans(repo) {
  let txt = "";
  try {
    txt = fs.readFileSync(planPath(repo), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* partial trailing line — skip */
    }
  }
  return out;
}

export function lastReleasedPlan(repo) {
  const released = readPlans(repo).filter((p) => p.releasedAt);
  return released.length ? released[released.length - 1] : null;
}

export function recentPlans(repo, now = new Date()) {
  return readPlans(repo).filter((p) => withinLookback(p.releasedAt || p.startedAt, now));
}

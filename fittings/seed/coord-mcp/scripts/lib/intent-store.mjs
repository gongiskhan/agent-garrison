// Per-repo intent store — sessions declare an intent ("I'm about to touch <area>
// for <reason>") so overlapping work by other sessions surfaces as a conflict in
// the digest. Repo-scoped: a session only ever sees its own repo's intents.
//
// Ledger: ~/.garrison/coord/intents/<repoSlug>.jsonl (append-only)
//   { repo, session, area, files, reason, ts }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoSlug } from "./repo.mjs";
import { withinLookback } from "./lookback.mjs";

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".garrison");
}
function intentDir() {
  return path.join(garrisonHome(), "coord", "intents");
}
function intentPath(repo) {
  return path.join(intentDir(), `${repoSlug(repo)}.jsonl`);
}

export function declareIntent(repo, entry) {
  fs.mkdirSync(intentDir(), { recursive: true });
  const row = {
    repo,
    session: entry.session || "unknown",
    area: entry.area || "",
    files: Array.isArray(entry.files) ? entry.files : [],
    reason: entry.reason || "",
    ts: entry.ts || new Date().toISOString()
  };
  fs.appendFileSync(intentPath(repo), JSON.stringify(row) + "\n");
  return row;
}

export function readIntents(repo) {
  let txt = "";
  try {
    txt = fs.readFileSync(intentPath(repo), "utf8");
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

export function recentIntents(repo, now = new Date()) {
  return readIntents(repo).filter((i) => withinLookback(i.ts, now));
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// Two intents overlap if they name the same area, if one area contains the other
// (so a free-text prompt mentioning another session's specific area/path counts —
// length-guarded to avoid trivial false positives), if an area mentions a file, or
// if any file paths share/prefix.
export function intentsOverlap(a, b) {
  const aArea = norm(a.area);
  const bArea = norm(b.area);
  const SPECIFIC = 4; // min length for a containment match (avoids "x" matching everything)
  if (aArea && bArea) {
    if (aArea === bArea) return true;
    if (bArea.length >= SPECIFIC && aArea.includes(bArea)) return true;
    if (aArea.length >= SPECIFIC && bArea.includes(aArea)) return true;
  }
  const fa = a.files || [];
  const fb = b.files || [];
  if (aArea && fb.some((f) => f && f.length >= SPECIFIC && aArea.includes(norm(f)))) return true;
  if (bArea && fa.some((f) => f && f.length >= SPECIFIC && bArea.includes(norm(f)))) return true;
  return fa.some((x) => fb.some((y) => x === y || x.startsWith(y + "/") || y.startsWith(x + "/")));
}

// Recent intents by OTHER sessions whose area/files overlap the given intent —
// i.e. potential conflicts the caller should know about before proceeding.
export function conflictsFor(repo, mine, now = new Date()) {
  return recentIntents(repo, now).filter((i) => i.session !== mine.session && intentsOverlap(i, mine));
}

// Cleanup (used by the canary to remove its synthetic intents).
export function removeIntentsBySession(repo, session) {
  const kept = readIntents(repo).filter((i) => i.session !== session);
  fs.mkdirSync(intentDir(), { recursive: true });
  fs.writeFileSync(intentPath(repo), kept.map((i) => JSON.stringify(i)).join("\n") + (kept.length ? "\n" : ""));
}

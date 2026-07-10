// fences.mjs — git commit fences, breakage attribution, and abandonment revert
// for same-branch multi-run coordination (GARRISON-FLOW-V2 S2, Q5/Q6/Q7).
//
// The load-bearing idea: on every successful advance out of an agent phase, a run
// commits ONLY its own touch-set paths (scoped `git add`, never `-A`), tagging the
// commit with Garrison-Card / Garrison-Run / Garrison-Phase trailers. Those
// trailers make git the source of truth for WHO changed WHAT on the shared branch,
// so when a downstream gate fails we can walk `<victim's last fence>..HEAD`, find
// the foreign commits whose files intersect the victim's claims, and blame the
// card that actually caused the breakage instead of looping the victim.
//
// All git runs through execFileSync arg-vectors (no shell). Every git failure
// degrades VISIBLY (a fenceError/attribution event), never throwing out of the
// engine seam and never blaming without trailer + file-intersection evidence.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { claimCovers } from "./coordination.mjs";

// Arg-vector git. Returns trimmed stdout; throws on non-zero (caller decides).
function git(repoPath, args) {
  return execFileSync("git", args, {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
}

function headSha(repoPath) {
  try {
    return git(repoPath, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null; // no commits yet
  }
}

// Files touched by a single commit (name-only, no rename detection so a path that
// moved is reported under both names — conservative for intersection).
function commitFiles(repoPath, sha) {
  try {
    return git(repoPath, ["show", "--name-only", "--no-renames", "--format=", sha])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Working-tree paths still dirty (modified or untracked) per `git status
// --porcelain`. Rename entries ("old -> new") report the new path.
function dirtyPaths(repoPath) {
  let out = "";
  try {
    out = git(repoPath, ["status", "--porcelain"]);
  } catch {
    return [];
  }
  const paths = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4).trim();
    p = p.replace(/^"|"$/g, "");
    if (p) paths.push(p);
  }
  return paths;
}

function fenceMessage(card, phase) {
  const title = String(card.title || "(untitled)").replace(/\s+/g, " ").trim().slice(0, 50);
  return (
    `garrison(${card.project || "no-project"}): ${phase} fence — ${title}\n\n` +
    `Garrison-Card: ${card.id}\n` +
    `Garrison-Run: ${card.runId || ""}\n` +
    `Garrison-Phase: ${phase}`
  );
}

// Commit a fence for a card's phase advance. Scoped staging of the touch-set's
// files + dirs that exist on disk; nothing staged -> an EMPTY fence anchoring the
// current HEAD (so the attribution chain never has a gap). Returns:
//   { record: {phase, sha, at, empty} | null, events: [...] }
// A null record means the fence was skipped (unresolved repo) or failed (git
// error) — both recorded as an honest event; the caller advances regardless.
export function commitFence({ repoPath, card, phase, touchSet, otherClaims = [], now = () => new Date().toISOString() }) {
  const at = typeof now === "function" ? now() : now;
  if (!repoPath) {
    return {
      record: null,
      events: [{ at, kind: "fence", message: `Fence skipped for ${phase}: could not resolve a repo path for project ${card.project || "(none)"} — changes on this branch stay unattributable.` }]
    };
  }
  const events = [];
  try {
    const claims = [...(touchSet?.files || []), ...(touchSet?.dirs || [])];
    const present = claims.filter((p) => {
      try { return existsSync(path.join(repoPath, p)); } catch { return false; }
    });

    let staged = false;
    if (present.length) {
      git(repoPath, ["add", "--", ...present]);
      // `git diff --cached --quiet` exits 1 when there ARE staged changes.
      try {
        git(repoPath, ["diff", "--cached", "--quiet"]);
        staged = false;
      } catch (e) {
        if (e && e.status === 1) staged = true;
        else throw e;
      }
    }

    let record;
    if (staged) {
      git(repoPath, ["commit", "-m", fenceMessage(card, phase)]);
      const sha = headSha(repoPath);
      record = { phase, sha, at, empty: false };
      events.push({ at, kind: "fence", message: `Fenced ${phase}: committed touch-set (${sha ? sha.slice(0, 10) : "?"})` });
    } else {
      // Empty fence: anchor the current HEAD so `anchor..HEAD` stays gapless.
      const sha = headSha(repoPath);
      record = { phase, sha, at, empty: true };
      events.push({ at, kind: "fence", message: `Fence anchor for ${phase} at ${sha ? sha.slice(0, 10) : "HEAD"} (no touch-set changes to commit)` });
    }

    // Dirty-tree honesty: anything still modified that is outside THIS card's
    // touch-set AND outside every other live card's claims is unattributable.
    const covered = (f) => claimCovers(touchSet, f) || (otherClaims || []).some((ts) => claimCovers(ts, f));
    const orphaned = dirtyPaths(repoPath).filter((f) => !covered(f));
    if (orphaned.length) {
      events.push({
        at,
        kind: "fence",
        message: `Out-of-touch-set changes present, not fenced, unattributable: ${orphaned.slice(0, 20).join(", ")}${orphaned.length > 20 ? " …" : ""}`
      });
    }
    return { record, events };
  } catch (err) {
    return {
      record: null,
      events: [{ at, kind: "fence", message: `Fence failed for ${phase} (git error) — advancing without a fence; the gap will read as unattributable.`, detail: String(err?.stderr || err?.message || err) }]
    };
  }
}

// Attribute a gate failure to the card that caused it (Q6). Walk the victim's last
// fence sha ..HEAD, partition commits by Garrison-Card trailer, and for each
// FOREIGN commit test whether its files intersect the victim's touch-set claims.
//   { verdict: "foreign"|"own"|"mixed"|"unknown", offenderCardId, commits, overlapFiles }
// "foreign" (and only foreign) triggers the interference wait; own/mixed/unknown
// fall through to today's normal loop-back — we never blame without both a trailer
// AND a file intersection.
export function attributeBreakage({ repoPath, victimCard, victimTouchSet, liveCards = [] }) {
  const empty = { verdict: "unknown", offenderCardId: null, commits: [], overlapFiles: [] };
  const fences = Array.isArray(victimCard?.fences) ? victimCard.fences : [];
  const anchor = fences.length ? fences[fences.length - 1].sha : null;
  if (!anchor || !repoPath) return empty;

  let raw;
  try {
    // %H then NUL then body then RS between commits.
    raw = git(repoPath, ["log", `${anchor}..HEAD`, "--format=%H%x00%B%x1e"]);
  } catch {
    return empty;
  }
  const commits = raw
    .split("\x1e")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const nul = block.indexOf("\x00");
      const sha = (nul === -1 ? block : block.slice(0, nul)).trim();
      const body = nul === -1 ? "" : block.slice(nul + 1);
      const m = body.match(/^Garrison-Card:\s*(\S+)\s*$/m);
      return { sha, cardId: m ? m[1] : null };
    })
    .filter((c) => c.sha);

  const claims = victimTouchSet || { files: [], dirs: [] };
  const liveIds = new Set((liveCards || []).map((c) => c.id));
  let ownInRange = false;
  const interfering = [];
  const overlap = new Set();
  let offenderCardId = null;
  for (const c of commits) {
    if (!c.cardId) continue; // unattributed — cannot blame
    if (c.cardId === victimCard.id) {
      ownInRange = true;
      continue;
    }
    // foreign commit: does it touch the victim's claims?
    const hit = commitFiles(repoPath, c.sha).filter((f) => claimCovers(claims, f));
    if (hit.length) {
      interfering.push(c.sha);
      hit.forEach((f) => overlap.add(f));
      // Prefer an offender that is still a live card (its fence can release us).
      if (!offenderCardId || (!liveIds.has(offenderCardId) && liveIds.has(c.cardId))) offenderCardId = c.cardId;
    }
  }

  if (interfering.length && ownInRange) return { verdict: "mixed", offenderCardId, commits: interfering, overlapFiles: [...overlap] };
  if (interfering.length) return { verdict: "foreign", offenderCardId, commits: interfering, overlapFiles: [...overlap] };
  if (ownInRange) return { verdict: "own", offenderCardId: null, commits: [], overlapFiles: [] };
  return empty;
}

// ── Q7 abandonment revert (engine side) ─────────────────────────────────────

// Build the prepared-revert descriptor for an abandoned card: the trailer-attributed
// commits (newest first) + a conflictRisk list (each such commit's files that a
// LATER commit by another card also touched). Read-only on git; the caller (the
// server /abandon handler) persists it and parks the card. Returns the descriptor,
// or null when the repo is unresolvable.
export function prepareRevert({ repoPath, card, now = () => new Date().toISOString() }) {
  if (!repoPath) return null;
  const preparedAt = typeof now === "function" ? now() : now;
  let commits = [];
  try {
    commits = git(repoPath, ["log", "--format=%H", `--grep=Garrison-Card: ${card.id}`])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    commits = [];
  }
  const mine = new Set(commits);
  const conflictRisk = [];
  for (const sha of commits) {
    const files = new Set(commitFiles(repoPath, sha));
    if (files.size === 0) continue;
    // commits AFTER this one, by ANOTHER card, touching the same files
    let later = [];
    try {
      later = git(repoPath, ["log", "--format=%H", `${sha}..HEAD`]).split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      later = [];
    }
    const risky = new Set();
    for (const l of later) {
      if (mine.has(l)) continue;
      for (const f of commitFiles(repoPath, l)) if (files.has(f)) risky.add(f);
    }
    if (risky.size) conflictRisk.push({ sha, files: [...risky] });
  }
  return {
    cardId: card.id,
    project: card.project || null,
    repoPath,
    commits, // newest first (git log default)
    preparedAt,
    conflictRisk,
    state: "prepared"
  };
}

// Execute a prepared revert (Q7 confirm). Reverts the commits newest-first, each as
// its own commit carrying Garrison-Card + Garrison-Revert trailers. On ANY conflict
// it aborts cleanly and returns state "conflict" (never auto-retries, never leaves
// the tree half-reverted). Returns { state: "applied"|"conflict"|"noop", revertCommits, error? }.
export function executeRevert({ repoPath, cardId, commits, now = () => new Date().toISOString() }) {
  const at = typeof now === "function" ? now() : now;
  if (!repoPath) return { state: "conflict", error: "no repo path", revertCommits: [] };
  const list = (commits || []).filter(Boolean);
  if (list.length === 0) return { state: "noop", revertCommits: [] };
  const revertCommits = [];
  for (const sha of list) {
    try {
      git(repoPath, ["revert", "--no-commit", sha]);
    } catch (err) {
      // conflict or bad sha — clean up so the tree is never left half-reverted
      try { git(repoPath, ["revert", "--abort"]); } catch { /* no sequencer */ }
      try { git(repoPath, ["reset", "--hard", "HEAD"]); } catch { /* best-effort */ }
      try { git(repoPath, ["checkout", "--", "."]); } catch { /* best-effort */ }
      return { state: "conflict", error: String(err?.stderr || err?.message || err), sha, revertCommits, at };
    }
    const msg = `Revert of ${sha.slice(0, 12)} (garrison abandon ${cardId})\n\nGarrison-Card: ${cardId}\nGarrison-Revert: true`;
    try {
      git(repoPath, ["commit", "-m", msg]);
    } catch (err) {
      // nothing to commit (already reverted) — treat as a no-op step, keep going
      const already = /nothing to commit/i.test(String(err?.stderr || err?.message || ""));
      if (!already) {
        try { git(repoPath, ["reset", "--hard", "HEAD"]); } catch { /* best-effort */ }
        return { state: "conflict", error: String(err?.stderr || err?.message || err), sha, revertCommits, at };
      }
      continue;
    }
    revertCommits.push(headSha(repoPath));
  }
  return { state: "applied", revertCommits, at };
}

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
    return git(repoPath, ["show", "--name-only", "--no-renames", "--format=", "--end-of-options", sha])
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

// Collapse ALL whitespace (incl. newlines) so no interpolated field can inject a
// second line — a project/title/id containing "\nGarrison-Card: <victim>" must not
// forge a trailer that attribution/revert would read.
function clean(s, max) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return max ? t.slice(0, max) : t;
}
function fenceMessage(card, phase) {
  const project = clean(card.project || "no-project");
  const title = clean(card.title || "(untitled)", 50);
  const cardId = clean(card.id || "");
  const runId = clean(card.runId || "");
  const ph = clean(phase);
  return (
    `garrison(${project}): ${ph} fence - ${title}\n\n` +
    `Garrison-Card: ${cardId}\n` +
    `Garrison-Run: ${runId}\n` +
    `Garrison-Phase: ${ph}`
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
      events: [{ at, kind: "fence", message: `Fence skipped for ${phase}: could not resolve a repo path for project ${card.project || "(none)"} - changes on this branch stay unattributable.` }]
    };
  }
  const events = [];
  try {
    const claims = [...(touchSet?.files || []), ...(touchSet?.dirs || [])];
    const present = claims.filter((p) => {
      try { return existsSync(path.join(repoPath, p)); } catch { return false; }
    });

    // Detection is SCOPED to this card's paths (`status --porcelain -- <paths>`),
    // so a foreign file staged by a concurrent card on the shared branch never
    // makes us think we have something to commit.
    let hasChanges = false;
    if (present.length) {
      const st = git(repoPath, ["status", "--porcelain", "--", ...present]);
      hasChanges = st.split("\n").some((l) => l.trim());
    }

    let record;
    if (hasChanges) {
      // Stage + commit ONLY this card's paths. `git commit --only -- <paths>`
      // commits exactly those paths even when OTHER files are already staged in
      // the index (another live card's `git add`), so a foreign staged file can
      // never ride into THIS card's fence under THIS card's trailer — it stays
      // staged, untouched.
      git(repoPath, ["add", "--", ...present]);
      git(repoPath, ["commit", "--only", "-m", fenceMessage(card, phase), "--", ...present]);
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
      events: [{ at, kind: "fence", message: `Fence failed for ${phase} (git error) - advancing without a fence; the gap will read as unattributable.`, detail: String(err?.stderr || err?.message || err) }]
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
    raw = git(repoPath, ["log", "--format=%H%x00%B%x1e", "--end-of-options", `${anchor}..HEAD`]);
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
      // Take the LAST Garrison-Card line, not the first — a spoofed trailer
      // injected earlier in the body (via a hostile interpolated field) cannot
      // win over the real trailer git appends at the end of the message.
      const all = [...body.matchAll(/^Garrison-Card:[ \t]*(\S+)[ \t]*$/gm)];
      return { sha, cardId: all.length ? all[all.length - 1][1] : null };
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
      later = git(repoPath, ["log", "--format=%H", "--end-of-options", `${sha}..HEAD`]).split("\n").map((s) => s.trim()).filter(Boolean);
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
    state: "prepared",
    // Honesty (D8): the revert only covers COMMITTED fences. Abandoning does not
    // stop a still-running live session (a stale advance is CAS-dropped) and
    // uncommitted working-tree edits are NOT in these commits, so they are not
    // covered by the prepared revert.
    note: "Prepared from committed fences only; a running live session and uncommitted working-tree edits are not covered by this revert."
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
      git(repoPath, ["revert", "--no-commit", "--end-of-options", sha]);
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

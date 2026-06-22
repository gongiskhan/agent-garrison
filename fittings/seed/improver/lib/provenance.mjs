// provenance.mjs — standalone APM-lock + pinned-list reader for the Improver
// skills rule (v1). A minimal re-implementation of the owned/loose distinction
// that src/lib/* computes in TypeScript (unimportable from a .mjs fitting).
// Reads the composition lockfile to learn which skills APM deployed (= owned);
// reads a pinned list (file + env) for skills the human froze. classifySkill is
// the provenance gate BOTH phases consult: a skill is eligible only when owned
// and not pinned.
//
// FAIL-SAFE: a missing/unparseable lock yields an EMPTY owned set, so the
// Improver treats everything as loose and acts on nothing human-authored.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

// Default composition lockfile (env IMPROVER_LOCK overrides). Honors GARRISON_HOME.
// The Garrison-owned APM project that drives the real ~/.claude lives at
// <garrison>/global-composition/ (see src/lib/claude-home.ts globalCompositionDir),
// so `apm install` writes apm.lock.yaml there — that is the real path. We prefer
// it, then fall back to <garrison>/composition/apm.lock.yaml (whichever exists);
// the latter is also the returned default when neither is present (fail-safe →
// empty owned set).
export function defaultLockPath() {
  if (process.env.IMPROVER_LOCK) return process.env.IMPROVER_LOCK;
  const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  const candidates = [
    path.join(home, "global-composition", "apm.lock.yaml"),
    path.join(home, "composition", "apm.lock.yaml"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[candidates.length - 1];
}

// Extract a skill name from an apm.lock deployed_files entry. Real entries are
// `.claude/skills/<name>` (directory, no trailing slash) — verified against a
// live lock — but we also accept `skills/<name>` and `skills/<name>/SKILL.md`
// (the brief's "exact dir OR /-prefix" requirement).
export function skillNameFromDeployedPath(p) {
  if (typeof p !== "string") return null;
  const norm = p.replace(/^\.?\//, ""); // strip leading ./ or /
  const m = norm.match(/(?:^|\/)skills\/([^/]+)(?:\/.*)?$/);
  return m ? m[1] : null;
}

// Read the lockfile -> Set of owned skill names. Fail-safe to empty.
export function readLock(lockPath) {
  const owned = new Set();
  const file = lockPath || defaultLockPath();
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return owned;
  }
  let doc;
  try {
    doc = yaml.load(raw);
  } catch {
    return owned;
  }
  const deps = doc && Array.isArray(doc.dependencies) ? doc.dependencies : [];
  for (const dep of deps) {
    const files = dep && Array.isArray(dep.deployed_files) ? dep.deployed_files : [];
    for (const f of files) {
      const name = skillNameFromDeployedPath(f);
      if (name) owned.add(name);
    }
  }
  return owned;
}

// Read pinned skills from a JSON file (array or {pinned:[...]}) plus a CSV env
// (default IMPROVER_PINNED). Both are unioned; either may be absent.
export function readPinned(pinnedPath, pinnedEnv) {
  const pinned = new Set();
  if (pinnedPath) {
    try {
      const parsed = JSON.parse(readFileSync(pinnedPath, "utf8"));
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.pinned) ? parsed.pinned : [];
      for (const n of arr) if (typeof n === "string" && n.trim()) pinned.add(n.trim());
    } catch {
      /* missing/invalid → no pins from file */
    }
  }
  const env = (pinnedEnv ?? process.env.IMPROVER_PINNED ?? "").trim();
  if (env) for (const n of env.split(",").map((s) => s.trim()).filter(Boolean)) pinned.add(n);
  return pinned;
}

// classifySkill(name) -> { owned, pinned, eligible: owned && !pinned }.
export function makeClassifier(ownedSet, pinnedSet) {
  const owned = ownedSet || new Set();
  const pinned = pinnedSet || new Set();
  return function classifySkill(name) {
    const isOwned = owned.has(name);
    const isPinned = pinned.has(name);
    return { owned: isOwned, pinned: isPinned, eligible: isOwned && !isPinned };
  };
}

// One-shot loader: read lock + pinned, return { owned, pinned, classify }.
export function loadProvenance({ lockPath, pinnedPath, pinnedEnv } = {}) {
  const owned = readLock(lockPath);
  const pinned = readPinned(pinnedPath, pinnedEnv);
  return { owned, pinned, classify: makeClassifier(owned, pinned) };
}

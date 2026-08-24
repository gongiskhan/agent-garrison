// Repo identity — the scoping key for the planning lease, plan ledger, intents
// and digest. A session only ever sees coordination state for its own repo.
//
// The KEY is the normalized origin URL (lib/repo-key.mjs, shared byte-identical
// with the state service), NOT a hash of the absolute path. On a mesh a path
// hash is doubly wrong: the same path on two machines is two different
// checkouts that would share a lock, and the same repo at two paths gets two
// locks. A checkout with no origin falls back to `local:<node>:<hash16>`, which
// is explicitly node-scoped and therefore still cannot collide across machines.
//
// A "repo ref" carries both halves, because two systems key differently:
//   .key  — the mesh coordination key (state service)
//   .path — the local checkout root, or null (agent_mail's project slug)
import { execFileSync } from "node:child_process";
import path from "node:path";
import { repoKeyForOrigin } from "./repo-key.mjs";
import { nodeName } from "./state.mjs";

// Resolve the git toplevel for a cwd; fall back to the cwd itself when not a git
// repo (a non-git dir still gets its own isolated coordination scope).
export function repoRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim();
  } catch {
    return path.resolve(cwd);
  }
}

// The checkout's origin URL, or "" when there is no remote (or no git at all).
export function originUrl(root) {
  try {
    return execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// Does this string already look like a normalized key rather than a path?
// `local:<node>:<hash>` or `host.tld/owner/repo`. Absolute paths never match.
function looksLikeKey(s) {
  if (s.startsWith("local:")) return true;
  if (path.isAbsolute(s)) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+\/.+$/i.test(s);
}

export function repoKeyForRoot(root, env = process.env) {
  return repoKeyForOrigin(originUrl(root), { node: nodeName(env), fallbackPath: root });
}

// Normalise whatever a caller supplied into { key, path }.
//   undefined / ""      -> the cwd's checkout
//   absolute path       -> that checkout (git toplevel + origin)
//   normalized key      -> passed through untouched (the web view round-trips
//                          the key it was shown back into release-lock)
//   any other name      -> an opaque, node-scoped local key
export function repoRef(repo, cwd = process.cwd(), env = process.env) {
  const raw = String(repo ?? "").trim();
  if (!raw) {
    const root = repoRoot(cwd);
    return { key: repoKeyForRoot(root, env), path: root };
  }
  if (looksLikeKey(raw)) return { key: raw, path: null };
  if (path.isAbsolute(raw)) {
    const root = repoRoot(raw);
    return { key: repoKeyForRoot(root, env), path: root };
  }
  return { key: repoKeyForOrigin(null, { node: nodeName(env), fallbackPath: raw }), path: raw };
}

// Tolerant coercion for the readers that accept either form.
export function asRef(repo) {
  if (repo && typeof repo === "object") return { key: repo.key, path: repo.path ?? null };
  return { key: String(repo ?? ""), path: null };
}

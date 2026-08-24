// Where the file browser can browse.
//
// There are three kinds of source and the browser treats them identically:
//
//   local          - the scoped workspace root this fitting has always served,
//                    read/write.
//   project:<name> - a git repository under this node's dev-root. Browsable and
//                    git-aware (status/diff/log/fetch), but READ-ONLY on the file
//                    API: an agent is working in that tree, and a file write from
//                    a browser tab would race work you cannot see. Edits go
//                    through git, which is the whole point of the git endpoints.
//   remote:<t>     - a machine the remote-shell runtime holds a transport to,
//                    read-only. That is the project an agent is actually working
//                    in on a non-node box, which is why you can review the work
//                    instead of only reading a report about it.
//
// PEER ADDRESS, NOT PORT LITERAL. The remote-shell fitting's port belongs to the
// composition and shifts per instance, so guessing it would pin one instance and
// silently talk to another's machine. This asks the shell (GARRISON_BASE_URL,
// projected by the runner) which URL that fitting is on, and caches the answer
// briefly so a browse does not become two round trips.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DISCOVERY_TTL_MS = 30_000;

let cached = { at: 0, url: null };

function baseUrl(env) {
  const raw = String(env.GARRISON_BASE_URL || "").trim();
  return raw.replace(/\/+$/, "");
}

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The remote-shell fitting's own-port URL, or null when it is not running. */
export async function remoteShellUrl(env = process.env, { now = Date.now() } = {}) {
  const shell = baseUrl(env);
  if (!shell) return null;
  if (cached.url && now - cached.at < DISCOVERY_TTL_MS) return cached.url;
  try {
    const data = await fetchJson(`${shell}/api/fittings/views`);
    const view = (data.views ?? []).find((v) => v.fittingId === "remote-shell-runtime");
    const url = view?.url ? String(view.url).replace(/\/+$/, "") : null;
    cached = { at: now, url };
    return url;
  } catch {
    // A shell that is down is not an error here - the local source still works,
    // and the UI shows remote sources as unavailable rather than failing to load.
    return null;
  }
}

/** Test seam: forget the discovered peer address. */
export function resetSourceCache() {
  cached = { at: 0, url: null };
}

// ── dev-root projects ────────────────────────────────────────────────────────
//
// The name discipline below is COPIED, deliberately and without softening, from
// the gateway's resolveProjectName (fittings/seed/http-gateway/scripts/lib/
// project-source.mjs). It is the only resolver in the repo safe for a value that
// came off the wire: the accepted vocabulary is "a dev-root child name", never a
// path. Keeping the two identical is the point - a browser tab and a channel
// body must not be able to reach different sets of directories.

export function expandHome(p, home = os.homedir()) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export function garrisonHome(env = process.env) {
  const explicit = String(env.GARRISON_HOME || "").trim();
  return explicit || path.join(os.homedir(), ".garrison");
}

/** The dev-root the user configured ($GARRISON_HOME/dev-root), default ~/dev. */
export function readDevRoot(env = process.env) {
  try {
    const raw = readFileSync(path.join(garrisonHome(env), "dev-root"), "utf8").trim();
    if (raw) return expandHome(raw);
  } catch {
    /* no file → default */
  }
  return path.join(os.homedir(), "dev");
}

function isStrictlyInside(root, target) {
  const rel = path.relative(root, target);
  if (!rel) return false;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve a dev-root CHILD NAME to its absolute repo root, or null.
 *
 * Rejected, in order: non-strings and blanks; anything carrying a path separator
 * or ".."; absolute paths (win32 "C:\x" survives the separator checks); dotfiles;
 * a candidate whose realpath leaves the dev-root (a symlinked child pointing at
 * another checkout would sail past a name-only check); non-directories; and
 * directories with no ".git" entry.
 *
 * Returns the REALPATH, which is both the path already proven contained and the
 * same canonical identity the repo's other dev-root scanners hand out - so the
 * ~/dev vs ~/Projects symlink pair cannot produce two spellings of one repo.
 */
export function resolveProjectName(label, { devRoot } = {}) {
  if (typeof label !== "string") return null;
  const name = label.trim();
  if (!name) return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (name.includes("..")) return null;
  if (path.isAbsolute(name)) return null;
  if (name.startsWith(".")) return null;

  const root = expandHome(devRoot ?? readDevRoot());
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null; // no dev-root → no projects
  }
  let real;
  try {
    real = realpathSync(path.join(realRoot, name));
  } catch {
    return null;
  }
  if (!isStrictlyInside(realRoot, real)) return null;
  try {
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  if (!existsSync(path.join(real, ".git"))) return null;
  return real;
}

/** The dev-root child names resolveProjectName would accept, sorted. Never throws. */
export function listProjectNames({ devRoot } = {}) {
  const root = expandHome(devRoot ?? readDevRoot());
  if (!existsSync(root)) return [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (resolveProjectName(e.name, { devRoot: root })) names.push(e.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

/**
 * Every source the browser can offer right now. The local one always exists;
 * project sources come off this node's dev-root; the remote ones depend on the
 * remote-shell fitting being up and having transports.
 */
export async function listSources(env = process.env, localRoot = "") {
  const sources = [
    {
      id: "local",
      kind: "local",
      label: "Garrison files",
      root: localRoot,
      writable: true,
      git: false,
      available: true
    }
  ];
  const devRoot = readDevRoot(env);
  for (const name of listProjectNames({ devRoot })) {
    sources.push({
      id: `project:${name}`,
      kind: "project",
      project: name,
      label: name,
      root: resolveProjectName(name, { devRoot }),
      // Read-only day one: the tree may have an agent running in it, and the
      // useful edit path here is git, not a file PUT.
      writable: false,
      git: true,
      available: true
    });
  }
  const shell = await remoteShellUrl(env);
  if (!shell) return sources;
  try {
    const data = await fetchJson(`${shell}/transports`);
    for (const t of data.transports ?? []) {
      sources.push({
        id: `remote:${t.name}`,
        kind: "remote",
        transport: t.name,
        label: t.label || t.name,
        root: t.cwd || "~",
        // Read-only by design: an agent is running in there, and editing under it
        // would race with work you cannot see.
        writable: false,
        git: false,
        available: true
      });
    }
  } catch {
    /* transports unreadable - offer local only, rather than a broken picker */
  }
  return sources;
}

/** Split a source id into its kind. */
export function parseSourceId(id) {
  const raw = String(id || "local");
  if (raw === "local") return { kind: "local" };
  const remote = /^remote:(.+)$/.exec(raw);
  if (remote) return { kind: "remote", transport: remote[1] };
  const project = /^project:(.+)$/.exec(raw);
  if (project) return { kind: "project", project: project[1] };
  return { kind: "unknown", raw };
}

/** Proxy a directory listing for a remote source. */
export async function remoteList(transport, relPath, env = process.env) {
  const shell = await remoteShellUrl(env);
  if (!shell) throw new Error("the remote-shell fitting is not running, so remote sources are unavailable");
  const url = `${shell}/transports/${encodeURIComponent(transport)}/files?path=${encodeURIComponent(relPath || "")}`;
  const data = await fetchJson(url, 25_000);
  if (data.error) throw new Error(data.error);
  return data;
}

/** Proxy a file read for a remote source. */
export async function remoteRead(transport, relPath, env = process.env) {
  const shell = await remoteShellUrl(env);
  if (!shell) throw new Error("the remote-shell fitting is not running, so remote sources are unavailable");
  const url = `${shell}/transports/${encodeURIComponent(transport)}/file?path=${encodeURIComponent(relPath || "")}`;
  const data = await fetchJson(url, 35_000);
  if (data.error) throw new Error(data.error);
  return data;
}

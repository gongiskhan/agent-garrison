// Which project the viewer is looking at, and how a reader changes it.
//
// The composition configures ONE repo. Until now that was also the ceiling: seeing a
// second project meant editing a manifest and restarting a fitting. That is the wrong
// shape for a navigator — the whole point is to arrive at an unfamiliar codebase and
// be able to read it, and an unfamiliar codebase is rarely the one already named in
// the manifest.
//
// So the configured repo becomes the DEFAULT rather than the only option. It can
// never be removed, because it is the one entry the machine can always fall back to.
// Everything else lives in a run-scoped registry beside the captures (D19: which
// repos this machine has looked at is a fact about the machine, not about any repo,
// so it is never committed into one of them).
//
// A reader picks a project by KEY, never by path. The key is the store's project key
// and it is resolved server-side against this registry. A cookie carrying a path
// would be a read-anything primitive: the browser would name a directory and the
// server would open it. Paths enter only through an explicit add, which validates
// that the target exists and is a git repository — the same bar the boot path holds
// the configured repo to, since every sample is anchored to a commit.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { projectKey, storeRoot } from "./store.mjs";

export const REGISTRY_VERSION = 1;

export function registryPath(env = process.env) {
  return path.join(storeRoot(env), "projects.json");
}

export function expandHome(p) {
  const s = String(p ?? "").trim();
  if (!s) return "";
  return s.startsWith("~") ? path.join(os.homedir(), s.slice(1)) : s;
}

/** Absolute, symlink-preserving, trailing-slash-free. The form every key is built from. */
export function normalisePath(p) {
  const expanded = expandHome(p);
  return expanded ? path.resolve(expanded) : "";
}

/**
 * Read the registry, tolerating every shape a broken or hand-edited file can take.
 *
 * A malformed registry must not take the viewer down: the configured repo alone is a
 * perfectly usable viewer, and losing the extra entries is a smaller failure than a
 * 500 on every page.
 */
export async function readRegistry(env = process.env) {
  try {
    const raw = await readFile(registryPath(env), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.projects) ? parsed.projects : [];
    const seen = new Set();
    const projects = [];
    for (const entry of list) {
      const p = normalisePath(typeof entry === "string" ? entry : entry?.path);
      if (!p || seen.has(p)) continue;
      seen.add(p);
      projects.push(p);
    }
    return { projects };
  } catch {
    return { projects: [] };
  }
}

async function writeRegistry(projects, env = process.env) {
  const file = registryPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const payload = `${JSON.stringify({ version: REGISTRY_VERSION, projects }, null, 2)}\n`;
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, file);
  return file;
}

/**
 * Two projects can share a basename (`~/dev/foo` and `~/work/foo`), and a picker that
 * shows the same word twice is worse than no picker. Disambiguate only the entries
 * that actually collide — qualifying every row would make the common case noisier to
 * fix a case that usually is not there.
 */
export function labelsFor(paths) {
  const counts = new Map();
  for (const p of paths) {
    const base = path.basename(p);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return paths.map((p) => {
    const base = path.basename(p);
    if ((counts.get(base) ?? 0) < 2) return base;
    const parent = path.basename(path.dirname(p));
    return parent ? `${parent}/${base}` : base;
  });
}

/**
 * Every project this viewer can show: the configured one first, then the registry in
 * the order it was added. The configured repo is marked and de-duplicated, so adding
 * it by hand cannot produce two rows for one directory.
 */
export async function listProjects({ configured = null, env = process.env } = {}) {
  const { projects } = await readRegistry(env);
  const paths = [];
  const seen = new Set();
  const defaultPath = configured ? normalisePath(configured) : "";
  if (defaultPath) {
    paths.push(defaultPath);
    seen.add(defaultPath);
  }
  for (const p of projects) {
    if (seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
  }
  const labels = labelsFor(paths);
  return paths.map((p, i) => ({
    key: projectKey(p),
    path: p,
    label: labels[i],
    isDefault: p === defaultPath,
  }));
}

/** Key -> path, or null. The only way a browser-supplied value becomes a directory. */
export async function resolveKey(key, { configured = null, env = process.env } = {}) {
  const wanted = String(key ?? "").trim();
  if (!/^[a-f0-9]{6,64}$/.test(wanted)) return null;
  const list = await listProjects({ configured, env });
  return list.find((entry) => entry.key === wanted)?.path ?? null;
}

/**
 * Add a project. `isRepo` is injected so this module stays testable without a git
 * binary, and so the caller decides what "a repository" means.
 *
 * Both checks are refusals rather than warnings. A path that does not exist is
 * almost always a typo, and a directory that is not a repository cannot be shown at
 * all: samples are extracted at a SHA, so without a commit there is nothing to
 * anchor to and every page would be an error.
 */
export async function addProject(input, { isRepo, env = process.env } = {}) {
  const target = normalisePath(input);
  if (!target) return { ok: false, code: "empty", error: "no path given" };
  if (!path.isAbsolute(target)) {
    return { ok: false, code: "notAbsolute", error: `${target} is not an absolute path` };
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    return { ok: false, code: "missing", error: `${target} does not exist` };
  }
  if (!info.isDirectory()) {
    return { ok: false, code: "notDirectory", error: `${target} is not a directory` };
  }
  if (typeof isRepo === "function" && !(await isRepo(target))) {
    return { ok: false, code: "notRepo", error: `${target} is not a git repository` };
  }
  const { projects } = await readRegistry(env);
  if (!projects.includes(target)) {
    projects.push(target);
    await writeRegistry(projects, env);
  }
  return { ok: true, path: target, key: projectKey(target) };
}

/**
 * Forget a project. The configured default is not removable — it is the fallback the
 * cookie resolves to, and a viewer with no projects at all has nothing to render.
 */
export async function removeProject(key, { configured = null, env = process.env } = {}) {
  const target = await resolveKey(key, { configured, env });
  if (!target) return { ok: false, code: "unknown", error: "no such project" };
  if (configured && target === normalisePath(configured)) {
    return { ok: false, code: "isDefault", error: "the configured project cannot be removed" };
  }
  const { projects } = await readRegistry(env);
  const next = projects.filter((p) => p !== target);
  if (next.length !== projects.length) await writeRegistry(next, env);
  return { ok: true, path: target };
}

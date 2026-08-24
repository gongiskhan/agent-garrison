#!/usr/bin/env node
// File Browser own-port server. Serves a mobile-first UI + a SCOPED, path-
// traversal-safe file API, plus the git surface the merge system runs on.
//
// CONFINEMENT IS PER SCOPE, NOT PER PROCESS. The browser now serves more than
// one root — the artifact workspace (read/write) and each dev-root project
// (read-only, git-aware) — so `resolveInRoot` / `assertRealInRoot` /
// `assertWriteInRoot` all take the root they are confining to. Every guard the
// single-root version had still applies, once per root: resolve-and-compare,
// realpath after symlinks, deepest-existing-ancestor on writes, O_NOFOLLOW on
// reads, rename-into-place on writes, and the credential refusal list. The
// invariant that matters most is the new one: a path inside project A can
// never reach project B, because A's checks run against A's root only.
//
// Same-origin CSRF guard, like the automations fitting.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, readdir, stat, lstat, mkdir, realpath, rename, open, unlink } from "node:fs/promises";
import { constants as FS } from "node:fs";

const FITTING_ID = "file-browser";
const DEFAULT_PORT = 7091;
const GARRISON_DIR = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
const STATUS_ROOT = path.join(GARRISON_DIR, "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, `${FITTING_ID}.json`);
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

import { listSources, parseSourceId, readDevRoot, remoteList, remoteRead, resolveProjectName } from "./sources.mjs";
import { DIFF_CAP_BYTES, GitError, gitDiff, gitFetch, gitLog, gitStatus } from "./git.mjs";

function expandHome(p) {
  return p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
const ROOT = path.resolve(expandHome(process.env.GARRISON_FILEBROWSER_ROOT || path.join(GARRISON_DIR, "files")));
// First-level namespace folders seeded on boot (mkdir -p, never overwritten).
// This is the shared artifact workspace: the Operative writes here, the user reads here.
const NAMESPACES = ["documents", "recordings", "runs", "uploads"];

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB cap for in-browser editing
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
// Never serve credential-bearing files even within a root (defense in depth).
// `.git` joined the list when project sources did: a repository's own config and
// object store carry remote credentials and history that has nothing to do with
// browsing the working tree.
const SENSITIVE = [
  /(^|\/)vault\.json$/i,
  /(^|\/)internal-token$/i,
  /(^|\/)\.env(\.|$)/i,
  /\.(key|pem|crt|p12|pfx)$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)\.git(\/|$)/i
];

function isSensitive(rel) {
  return SENSITIVE.some((re) => re.test(rel));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── scopes: one browsable root each ──────────────────────────────────────────

/** The artifact workspace. The only writable scope. */
const LOCAL_SCOPE = { id: "local", kind: "local", root: ROOT, writable: true, git: false, label: path.basename(ROOT) };

/**
 * Resolve a source id to the scope it names. Project sources go through the
 * dev-root name discipline in sources.mjs — the same resolver the gateway uses
 * for a channel-supplied project — so a source id can only ever name a git
 * repository directly under this node's dev-root.
 */
function scopeFor(sourceId) {
  const parsed = parseSourceId(sourceId);
  if (parsed.kind === "local") return LOCAL_SCOPE;
  if (parsed.kind === "project") {
    const root = resolveProjectName(parsed.project, { devRoot: readDevRoot() });
    if (!root) throw new HttpError(404, `no git project named "${parsed.project}" under this node's dev-root`);
    return {
      id: `project:${parsed.project}`,
      kind: "project",
      project: parsed.project,
      root,
      // Read-only day one: an agent may be running in that tree, and the useful
      // edit path for a repository is git, not a file PUT from a browser tab.
      writable: false,
      git: true,
      label: parsed.project
    };
  }
  return parsed; // remote / unknown — the caller decides what to do with it
}

/** A git-aware scope, or a 400 naming why not. */
function gitScopeFor(sourceId) {
  const scope = scopeFor(sourceId);
  if (!scope.git) throw new HttpError(400, `source "${scope.id ?? sourceId}" is not a git repository`);
  return scope;
}

// ── confinement, parameterised by root ───────────────────────────────────────

// Resolve a client-supplied relative path inside `root` — reject any escape.
function resolveInRoot(root, rel) {
  const clean = String(rel ?? "").replace(/^\/+/, "");
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("path escapes workspace root");
  if (isSensitive(path.relative(root, abs))) throw new Error("file not browsable");
  return abs;
}

function assertContained(rootReal, real) {
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error("path escapes workspace root");
}

// Read guard: the (existing) target, with symlinks followed, must stay in root.
async function assertRealInRoot(root, abs) {
  const rootReal = await realpath(root);
  let real;
  try {
    real = await realpath(abs);
  } catch {
    throw new Error("not found");
  }
  assertContained(rootReal, real);
}

// Write guard (stronger): walk to the DEEPEST EXISTING ancestor and realpath it
// — so a symlinked dir anywhere on the path (e.g. root/link -> /outside) is
// caught — and refuse to overwrite THROUGH an existing symlink at the target.
async function assertWriteInRoot(root, abs) {
  const rootReal = await realpath(root);
  let anchor = abs;
  for (;;) {
    try {
      await stat(anchor);
      break;
    } catch {
      const parent = path.dirname(anchor);
      if (parent === anchor) break;
      anchor = parent;
    }
  }
  assertContained(rootReal, await realpath(anchor));
  // Never write through an existing symlink at the final path.
  try {
    if ((await lstat(abs)).isSymbolicLink()) throw new Error("path escapes workspace root");
  } catch (e) {
    if (e instanceof Error && e.message.includes("escapes")) throw e; // not-found is fine (new file)
  }
}

function kindFor(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return "text";
}

function send(res, code, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { "content-type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json" : "text/html; charset=utf-8", ...headers });
  res.end(data);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

async function handleTree(res, scope, rel) {
  const abs = resolveInRoot(scope.root, rel);
  await assertRealInRoot(scope.root, abs);
  const entries = await readdir(abs, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (isSensitive(e.name)) continue;
    const childRel = path.posix.join(String(rel ?? "").replace(/^\/+/, ""), e.name);
    let size = 0;
    try { if (e.isFile()) size = (await stat(path.join(abs, e.name))).size; } catch {}
    items.push({ name: e.name, path: childRel, type: e.isDirectory() ? "dir" : "file", size });
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  send(res, 200, { root: path.basename(scope.root), source: scope.id, path: String(rel ?? ""), writable: scope.writable, items });
}

async function handleReadFile(res, scope, rel) {
  const abs = resolveInRoot(scope.root, rel);
  await assertRealInRoot(scope.root, abs);
  // Open with O_NOFOLLOW so the FINAL component is never followed as a symlink —
  // closes the check->use race on the target itself (a symlink swapped in after
  // the realpath check makes open() fail ELOOP rather than escaping the root).
  let fh;
  try {
    fh = await open(abs, FS.O_RDONLY | FS.O_NOFOLLOW);
  } catch (e) {
    if (e && (e.code === "ELOOP" || e.code === "EMLINK")) throw new Error("path escapes workspace root");
    throw e;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return send(res, 400, { error: "not a file" });
    const kind = kindFor(abs);
    if (kind === "image") {
      const buf = await fh.readFile();
      return send(res, 200, { path: rel, kind, encoding: "base64", content: buf.toString("base64"), ext: path.extname(abs).slice(1), readOnly: !scope.writable });
    }
    if (st.size > MAX_TEXT_BYTES) return send(res, 413, { error: "file too large to open in the browser", size: st.size });
    return send(res, 200, { path: rel, kind, encoding: "utf8", content: await fh.readFile("utf8"), readOnly: !scope.writable });
  } finally {
    await fh.close();
  }
}

async function handleWriteFile(res, scope, rel, content, encoding) {
  if (!scope.writable) return send(res, 403, { error: `source "${scope.id}" is read-only` });
  const abs = resolveInRoot(scope.root, rel);
  await assertWriteInRoot(scope.root, abs);
  if (typeof content !== "string") return send(res, 400, { error: "content must be a string" });
  const data = encoding === "base64" ? Buffer.from(content, "base64") : content;
  const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, "utf8");
  if (bytes > MAX_TEXT_BYTES) return send(res, 413, { error: "content too large" });
  const dir = path.dirname(abs);
  await mkdir(dir, { recursive: true });
  // Write to a temp file in the (realpath-validated) parent, then rename into
  // place. rename(2) REPLACES a symlink at the destination atomically WITHOUT
  // following it — so even a symlink swapped onto the target can't redirect the
  // write outside the root.
  const tmp = path.join(dir, `.garrison-fb-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, abs);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  send(res, 200, { ok: true, path: rel });
}

async function handleMkdir(res, scope, rel) {
  if (!scope.writable) return send(res, 403, { error: `source "${scope.id}" is read-only` });
  const clean = String(rel ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return send(res, 400, { error: "path required" });
  const abs = resolveInRoot(scope.root, clean);
  await assertWriteInRoot(scope.root, abs);
  await mkdir(abs, { recursive: true });
  send(res, 200, { ok: true, path: clean });
}

// ── the merge actions ────────────────────────────────────────────────────────
// Imported lazily: they construct a state client, and a node that is not
// enrolled in the mesh must still browse files perfectly well.

async function mergeActions() {
  return import("./merge-actions.mjs");
}

/** Which project a mesh action names: an explicit `project`, or a `project:<name>` source. */
function projectFromBody(body) {
  const direct = typeof body?.project === "string" ? body.project.trim() : "";
  if (direct) return direct;
  const parsed = parseSourceId(body?.source);
  if (parsed.kind === "project") return parsed.project;
  throw new HttpError(400, "project required");
}

/** Returns true when it answered the request, false when the path is not a git route. */
async function handleGit(req, res, url) {
  const { pathname } = url;

  if (pathname === "/api/git/status" && req.method === "GET") {
    const scope = gitScopeFor(url.searchParams.get("source"));
    send(res, 200, { source: scope.id, project: scope.project, root: scope.root, ...(await gitStatus(scope.root)) });
    return true;
  }

  if (pathname === "/api/git/diff" && req.method === "GET") {
    const scope = gitScopeFor(url.searchParams.get("source"));
    const rel = url.searchParams.get("path");
    const staged = url.searchParams.get("staged") === "1" || url.searchParams.get("staged") === "true";
    send(res, 200, { source: scope.id, ...(await gitDiff(scope.root, { relPath: rel || null, staged })) });
    return true;
  }

  if (pathname === "/api/git/log" && req.method === "GET") {
    const scope = gitScopeFor(url.searchParams.get("source"));
    send(res, 200, { source: scope.id, ...(await gitLog(scope.root, { limit: url.searchParams.get("limit") })) });
    return true;
  }

  if (pathname === "/api/git/fetch" && req.method === "POST") {
    const body = await readJsonBody(req);
    const scope = gitScopeFor(body.source ?? url.searchParams.get("source"));
    send(res, 200, { source: scope.id, ...(await gitFetch(scope.root)) });
    return true;
  }

  // ── state-mediated, cross-node ──
  if (pathname === "/api/git/commit-push" && req.method === "POST") {
    const body = await readJsonBody(req);
    const project = projectFromBody(body);
    const { commitPushProject } = await mergeActions();
    send(res, 200, await commitPushProject(project, { force: body.force === true }));
    return true;
  }

  if (pathname === "/api/git/pull-from-others" && req.method === "POST") {
    const body = await readJsonBody(req);
    const project = projectFromBody(body);
    const { pullFromOthers } = await mergeActions();
    send(res, 200, await pullFromOthers(project, {}));
    return true;
  }

  if (pathname === "/api/git/push-to-others" && req.method === "POST") {
    const body = await readJsonBody(req);
    const project = projectFromBody(body);
    const { pushToOthers } = await mergeActions();
    send(res, 200, await pushToOthers(project, {}));
    return true;
  }

  return false;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const { pathname } = url;
  // Same-origin CSRF guard (this service reads+writes files): reject a cross-origin Origin.
  const origin = req.headers.origin;
  if (origin) {
    let same = false;
    try { same = new URL(origin).host === req.headers.host; } catch { same = false; }
    if (!same) return send(res, 403, { error: "cross-origin forbidden" });
  }
  if (req.method === "OPTIONS") return send(res, 204, "");

  try {
    if (pathname === "/health" || pathname === "/api/health") return send(res, 200, { ok: true, root: ROOT });
    if (pathname === "/api/sources" && req.method === "GET") {
      return send(res, 200, { sources: await listSources(process.env, ROOT) });
    }
    if (pathname.startsWith("/api/git/")) {
      if (await handleGit(req, res, url)) return;
      return send(res, 404, { error: "not found" });
    }
    // One tree/file contract for every source: the UI must not know which side of
    // an ssh channel a path lives on, or every view grows two code paths.
    if (pathname === "/api/tree" && req.method === "GET") {
      const source = scopeFor(url.searchParams.get("source"));
      const rel = url.searchParams.get("path") || "";
      if (source.kind === "remote") {
        try {
          const listing = await remoteList(source.transport, rel);
          return send(res, 200, {
            root: listing.root,
            path: listing.path,
            truncated: Boolean(listing.truncated),
            items: (listing.entries ?? []).map((e) => ({
              name: e.name,
              path: e.path,
              type: e.type === "dir" ? "dir" : "file",
              size: e.size ?? 0,
              modified: e.modified ?? null
            }))
          });
        } catch (err) {
          return send(res, 502, { error: String(err?.message || err) });
        }
      }
      if (source.kind === "unknown") return send(res, 400, { error: `unknown source "${source.raw}"` });
      return await handleTree(res, source, rel);
    }
    if (pathname === "/api/file" && req.method === "GET") {
      const source = scopeFor(url.searchParams.get("source"));
      const rel = url.searchParams.get("path") || "";
      if (source.kind === "remote") {
        try {
          const file = await remoteRead(source.transport, rel);
          const buf = Buffer.from(file.base64 || "", "base64");
          const kind = kindFor(rel);
          if (kind === "image") {
            return send(res, 200, { path: rel, kind, encoding: "base64", content: buf.toString("base64"), ext: path.extname(rel).slice(1) });
          }
          return send(res, 200, {
            path: rel,
            kind,
            encoding: "utf8",
            content: buf.toString("utf8"),
            truncated: Boolean(file.truncated),
            size: file.size ?? buf.length,
            readOnly: true
          });
        } catch (err) {
          return send(res, 502, { error: String(err?.message || err) });
        }
      }
      if (source.kind === "unknown") return send(res, 400, { error: `unknown source "${source.raw}"` });
      return await handleReadFile(res, source, rel);
    }
    if (pathname === "/api/file" && req.method === "PUT") {
      const body = await readJsonBody(req);
      const source = scopeFor(body.source);
      if (source.kind !== "local" && source.kind !== "project") {
        return send(res, 403, { error: `source "${body.source ?? "?"}" is read-only` });
      }
      return await handleWriteFile(res, source, body.path, body.content, body.encoding);
    }
    if (pathname === "/api/mkdir" && req.method === "POST") {
      const body = await readJsonBody(req);
      const source = scopeFor(body.source);
      if (source.kind !== "local" && source.kind !== "project") {
        return send(res, 403, { error: `source "${body.source ?? "?"}" is read-only` });
      }
      return await handleMkdir(res, source, body.path);
    }
    // Static UI.
    if (req.method === "GET") {
      const file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      if (file.includes("..")) return send(res, 400, "bad path");
      try {
        const buf = await readFile(path.join(DIST, file));
        const ct = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html; charset=utf-8";
        return send(res, 200, buf, { "content-type": ct });
      } catch {
        return send(res, 404, "not found");
      }
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const explicit = err instanceof HttpError || err instanceof GitError ? err.status : Number(err?.status) || null;
    const code = explicit ?? (/escapes|not browsable/.test(msg) ? 403 : /not found/.test(msg) ? 404 : 400);
    send(res, code, { error: msg });
  }
}

async function writeStatusFile(port, host) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(
    STATUS_FILE,
    JSON.stringify(
      { fittingId: FITTING_ID, port, url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`, pid: process.pid, startedAt: new Date().toISOString(), route: "/", views: [{ id: "file-browser", title: "Files", route: "/" }] },
      null,
      2
    )
  );
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

// The status file is the single source of truth for the canonical instance.
// Never steal the slot from a live sibling: leave the file (and its shutdown
// unlink) alone when the tracked pid is alive and is not this process.
async function claimStatusFile(port, host) {
  try {
    const tracked = JSON.parse(await readFile(STATUS_FILE, "utf8"));
    const pid = Number(tracked?.pid);
    if (pid !== process.pid && pidAlive(pid)) {
      console.error(`[file-browser] ${STATUS_FILE} tracks live pid ${pid}; refusing to overwrite it (this instance runs untracked)`);
      return false;
    }
  } catch { /* absent or unreadable status file is claimable */ }
  await writeStatusFile(port, host);
  return true;
}

export function createServer() {
  return http.createServer((req, res) => void handle(req, res));
}

export async function startServer() {
  const host = process.env.GARRISON_FILEBROWSER_BIND_HOST || process.env.FILEBROWSER_UI_HOST || process.env.GARRISON_BIND_HOST || "127.0.0.1";
  const port = Number(process.env.GARRISON_FILEBROWSER_PORT || process.env.FILEBROWSER_UI_PORT || DEFAULT_PORT);
  await mkdir(ROOT, { recursive: true }).catch(() => {});
  for (const ns of NAMESPACES) await mkdir(path.join(ROOT, ns), { recursive: true }).catch(() => {});
  const server = createServer();
  // Bind the configured port only - no auto-shift. A busy port is a lifecycle
  // conflict the runner must surface, not a signal to silently split brain.
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    if (err && err.code === "EADDRINUSE") {
      throw new Error(`port ${port} is already in use; refusing to auto-shift (free the port or change FILEBROWSER_UI_PORT)`);
    }
    throw err;
  }
  const ownsStatusFile = await claimStatusFile(port, host);

  // The commit-push pump: this node's answer to a peer's pull-from-others. It
  // runs here rather than in a card because it has to work when the operative is
  // DOWN, which is exactly when a node is behind and someone wants its work.
  // Off (with one honest log line) when this node is not enrolled in the mesh.
  let stopPump = null;
  if (process.env.GARRISON_FILEBROWSER_NO_PUMP !== "1") {
    try {
      const { startCommitPushPump } = await mergeActions();
      stopPump = startCommitPushPump({});
    } catch (err) {
      console.error("[file-browser] merge pump unavailable:", err?.message || err);
    }
  }

  const shutdown = async () => {
    if (stopPump) stopPump();
    if (ownsStatusFile) { try { await unlink(STATUS_FILE); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  console.log(`file-browser server on http://${host}:${port} (root ${ROOT}, diff cap ${DIFF_CAP_BYTES} bytes)`);
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--probe")) {
    console.log("ok");
    process.exit(0);
  }
  startServer().catch((err) => {
    console.error("[file-browser] start failed:", err);
    process.exit(1);
  });
}

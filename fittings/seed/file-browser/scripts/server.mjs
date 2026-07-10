#!/usr/bin/env node
// File Browser own-port server. Serves a mobile-first UI + a SCOPED, path-
// traversal-safe file API confined to a workspace root (default ~/.garrison/files).
// It can never escape the root (resolve + realpath checks, incl. symlink escape)
// and refuses to serve credential files. Same-origin CSRF guard, like the
// automations fitting.

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

function expandHome(p) {
  return p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
const ROOT = path.resolve(expandHome(process.env.GARRISON_FILEBROWSER_ROOT || path.join(GARRISON_DIR, "files")));
// First-level namespace folders seeded on boot (mkdir -p, never overwritten).
// This is the shared artifact workspace: the Operative writes here, the user reads here.
const NAMESPACES = ["documents", "recordings", "runs", "uploads"];

const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB cap for in-browser editing
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
// Never serve credential-bearing files even within the root (defense in depth).
const SENSITIVE = [/(^|\/)vault\.json$/i, /(^|\/)internal-token$/i, /(^|\/)\.env(\.|$)/i, /\.(key|pem|crt|p12|pfx)$/i, /(^|\/)id_rsa/i];

function isSensitive(rel) {
  return SENSITIVE.some((re) => re.test(rel));
}

// Resolve a client-supplied relative path inside ROOT — reject any escape.
function resolveInRoot(rel) {
  const clean = String(rel ?? "").replace(/^\/+/, "");
  const abs = path.resolve(ROOT, clean);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error("path escapes workspace root");
  if (isSensitive(path.relative(ROOT, abs))) throw new Error("file not browsable");
  return abs;
}

function assertContained(rootReal, real) {
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error("path escapes workspace root");
}

// Read guard: the (existing) target, with symlinks followed, must stay in root.
async function assertRealInRoot(abs) {
  const rootReal = await realpath(ROOT);
  let real;
  try {
    real = await realpath(abs);
  } catch {
    throw new Error("not found");
  }
  assertContained(rootReal, real);
}

// Write guard (stronger): walk to the DEEPEST EXISTING ancestor and realpath it
// — so a symlinked dir anywhere on the path (e.g. ROOT/link -> /outside) is
// caught — and refuse to overwrite THROUGH an existing symlink at the target.
async function assertWriteInRoot(abs) {
  const rootReal = await realpath(ROOT);
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

async function handleTree(res, rel) {
  const abs = resolveInRoot(rel);
  await assertRealInRoot(abs);
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
  send(res, 200, { root: path.basename(ROOT), path: String(rel ?? ""), items });
}

async function handleReadFile(res, rel) {
  const abs = resolveInRoot(rel);
  await assertRealInRoot(abs);
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
      return send(res, 200, { path: rel, kind, encoding: "base64", content: buf.toString("base64"), ext: path.extname(abs).slice(1) });
    }
    if (st.size > MAX_TEXT_BYTES) return send(res, 413, { error: "file too large to open in the browser", size: st.size });
    return send(res, 200, { path: rel, kind, encoding: "utf8", content: await fh.readFile("utf8") });
  } finally {
    await fh.close();
  }
}

async function handleWriteFile(res, rel, content, encoding) {
  const abs = resolveInRoot(rel);
  await assertWriteInRoot(abs);
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

async function handleMkdir(res, rel) {
  const clean = String(rel ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return send(res, 400, { error: "path required" });
  const abs = resolveInRoot(clean);
  await assertWriteInRoot(abs);
  await mkdir(abs, { recursive: true });
  send(res, 200, { ok: true, path: clean });
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
    if (pathname === "/api/tree" && req.method === "GET") return await handleTree(res, url.searchParams.get("path") || "");
    if (pathname === "/api/file" && req.method === "GET") return await handleReadFile(res, url.searchParams.get("path") || "");
    if (pathname === "/api/file" && req.method === "PUT") {
      const body = await readJsonBody(req);
      return await handleWriteFile(res, body.path, body.content, body.encoding);
    }
    if (pathname === "/api/mkdir" && req.method === "POST") {
      const body = await readJsonBody(req);
      return await handleMkdir(res, body.path);
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
    const code = /escapes|not browsable/.test(msg) ? 403 : /not found/.test(msg) ? 404 : 400;
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
  const host = process.env.FILEBROWSER_UI_HOST || "127.0.0.1";
  const port = Number(process.env.FILEBROWSER_UI_PORT || DEFAULT_PORT);
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
  const shutdown = async () => {
    if (ownsStatusFile) { try { await unlink(STATUS_FILE); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  console.log(`file-browser server on http://${host}:${port} (root ${ROOT})`);
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

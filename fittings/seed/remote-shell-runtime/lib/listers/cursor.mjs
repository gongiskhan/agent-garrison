// Cursor sessions on this node: `~/.cursor/projects/<slug>/agent-transcripts/
// <id>/<id>.jsonl` holds BOTH desktop composer sessions and CLI chats, live-
// updating; `~/.cursor/chats/<ws>/<id>/meta.json` names which ids are CLI
// chats (and their real cwd - the transcript's own slug is lossy, since both
// "/" and "." fold to "-"). No hooks yet on this box's own node profile (the
// fitting's install-hooks.mjs installs them locally); status is the
// transcript-mtime baseline, layered over by the state doc publisher when a
// hook event exists. `GARRISON_CURSOR_HOME` overrides the root for tests -
// the same override name Quarters uses.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectName, transcriptStatus, readJsonlSlice } from "./common.mjs";

const SNIPPET_MAX = 80;
const TITLE_CACHE_MS = 5000;

function cursorHome(env = process.env) {
  return env.GARRISON_CURSOR_HOME?.trim() || path.join(os.homedir(), ".cursor");
}

function slugFor(cwd) {
  return String(cwd).replace(/[/.]/g, "-").replace(/^-+/, "");
}

function listDirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function readChatsMeta(home) {
  const out = new Map(); // id -> {cwd, createdAtMs, updatedAtMs, hasConversation}
  const chatsRoot = path.join(home, "chats");
  for (const ws of listDirs(chatsRoot)) {
    for (const id of listDirs(path.join(chatsRoot, ws))) {
      try {
        out.set(id, JSON.parse(fs.readFileSync(path.join(chatsRoot, ws, id, "meta.json"), "utf8")));
      } catch { /* skip */ }
    }
  }
  return out;
}

/** cwds a desktop transcript's slug might match: every chats cwd, plus real
 *  directories under ~/dev and ~/Projects. Best-effort - a desktop session in
 *  neither set gets no cwd, not a wrong one. */
function candidateCwds(chatsCwds, env) {
  const home = env.HOME?.trim() || os.homedir();
  const out = new Set(chatsCwds);
  for (const base of [path.join(home, "dev"), path.join(home, "Projects")]) {
    for (const name of listDirs(base)) out.add(path.join(base, name));
  }
  return [...out];
}

let desktopCache = { file: null, at: 0, rows: new Map(), error: null };

function desktopReadError(err) {
  if (err?.code === "ETIMEDOUT") return "timeout";
  if (err?.code === "ENOBUFS") return "output-limit";
  if (err?.code === "ENOENT") return "sqlite-unavailable";
  if (["EACCES", "EPERM"].includes(err?.code)) return "permission-denied";
  if (/database is (?:locked|busy)/i.test(String(err?.stderr ?? ""))) return "database-locked";
  if (err instanceof SyntaxError) return "invalid-json";
  return Number.isInteger(err?.status) ? `sqlite-exit-${err.status}` : "read-failed";
}

/** Read only composer metadata from Cursor's own database. Selecting the full
 * values also pulled message bodies and hit sqlite3's output cap on busy IDEs. */
function readDesktopMetadata(env) {
  const home = env.HOME?.trim() || os.homedir();
  const dbPath = env.GARRISON_CURSOR_STATE_DB || path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  if (desktopCache.file === dbPath && Date.now() - desktopCache.at < TITLE_CACHE_MS) return desktopCache.rows;
  // Only a successful read can replace the last snapshot. A locked or slow
  // IDE database is not evidence that its recent sessions were deleted.
  desktopCache = desktopCache.file === dbPath
    ? { ...desktopCache, at: Date.now() }
    : { file: dbPath, at: Date.now(), rows: new Map(), error: null };
  try {
    try { fs.statSync(dbPath); } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      desktopCache.rows = new Map();
      desktopCache.error = null;
      return desktopCache.rows;
    }
    const sql = `select substr(key, 14) as id,
      json_extract(value, '$.name') as title,
      json_extract(value, '$.status') as status,
      json_extract(value, '$.createdAt') as createdAt,
      coalesce(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.updatedAt'), json_extract(value, '$.createdAt')) as updatedAt,
      json_extract(value, '$.cwd') as cwd
      from cursorDiskKV where key like 'composerData:%' and json_valid(value)`;
    const out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql],
      { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    // sqlite3 emits no bytes for zero rows. That is a successful deletion,
    // unlike malformed/partial JSON from a failed metadata read.
    const parsed = out.trim() ? JSON.parse(out) : [];
    if (!Array.isArray(parsed)) throw new SyntaxError("invalid metadata result");
    const rows = new Map();
    for (const row of parsed) if (row?.id) rows.set(row.id, { ...row, dbPath });
    desktopCache.rows = rows;
    desktopCache.error = null;
  } catch (err) {
    const reason = desktopReadError(err);
    if (desktopCache.error !== reason) {
      console.warn(`[shells-cursor-lister] desktop metadata read failed (${reason}); retaining ${desktopCache.rows.size} cached rows`);
    }
    desktopCache.error = reason;
  }
  // list() still applies the five-day cutoff to original activity timestamps;
  // failed refreshes never make an old session recent again.
  return desktopCache.rows;
}

/** The first user turn's text, snippeted - the fallback title when there is
 *  no desktop composer name (every CLI chat, and Linux boxes with no
 *  sqlite3). Cursor wraps a CLI prompt in <user_query> tags; unwrap it. */
function firstUserLine(file) {
  for (const rec of readJsonlSlice(file, { maxBytes: 64 * 1024 })) {
    if (rec?.role !== "user") continue;
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    const part = content.find((p) => p?.type === "text" && typeof p.text === "string");
    if (!part) continue;
    const inner = /<user_query>([\s\S]*?)<\/user_query>/.exec(part.text)?.[1] ?? part.text;
    const oneLine = inner.replace(/\s+/g, " ").trim();
    if (!oneLine) continue;
    return oneLine.length > SNIPPET_MAX ? `${oneLine.slice(0, SNIPPET_MAX - 1)}…` : oneLine;
  }
  return null;
}

export function list({ windowDays = 5, now = Date.now(), env = process.env } = {}) {
  const home = cursorHome(env);
  const rows = [];
  const projectsRoot = path.join(home, "projects");
  const chatsMeta = readChatsMeta(home);
  const chatsCwds = [...chatsMeta.values()].map((m) => m?.cwd).filter((c) => typeof c === "string" && c);
  const slugToCwd = new Map(candidateCwds(chatsCwds, env).map((c) => [slugFor(c), c]));
  const cutoff = now - windowDays * 86_400_000;
  const desktop = readDesktopMetadata(env);

  for (const slug of listDirs(projectsRoot)) {
    const guessedCwd = slugToCwd.get(slug.replace(/^-+/, "")) ?? null;
    const transcriptsRoot = path.join(projectsRoot, slug, "agent-transcripts");
    let entries = [];
    try { entries = fs.readdirSync(transcriptsRoot, { withFileTypes: true }); } catch { /* no transcripts */ }
    for (const entry of entries) {
      const id = entry.isDirectory() ? entry.name : entry.name.replace(/\.(jsonl|txt)$/, "");
      if (!entry.isDirectory() && !/\.(jsonl|txt)$/.test(entry.name)) continue;
      const file = entry.isDirectory() ? path.join(transcriptsRoot, id, `${id}.jsonl`) : path.join(transcriptsRoot, entry.name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
      const meta = chatsMeta.get(id);
      const cwd = meta?.cwd ?? guessedCwd;
      const kind = meta ? "cli" : "desktop";
      const base = transcriptStatus(stat.mtimeMs, now);
      const title = desktop.get(id)?.title ?? meta?.name ?? meta?.title ?? firstUserLine(file);
      rows.push({
        id,
        runtime: "cursor",
        kind,
        cwd,
        project: projectName(cwd) ?? slug.split("-").pop(),
        title,
        status: base.status,
        statusSource: base.statusSource,
        startedAt: Number.isFinite(meta?.createdAtMs) ? new Date(meta.createdAtMs).toISOString() : null,
        lastActivityAt: new Date(stat.mtimeMs).toISOString(),
        // Only a CLI chat has a proven cursor-agent resume target. IDE
        // journals remain live observers owned by the original editor.
        resumable: kind === "cli",
        attachable: false,
        resumeRef: id,
        transcript: { format: file.endsWith(".txt") ? "cursor-agent-text" : "cursor-agent-jsonl", path: file }
      });
    }
  }
  const seen = new Set(rows.map((r) => r.id));
  for (const [id, meta] of chatsMeta) {
    const ts = meta.updatedAtMs ?? meta.createdAtMs;
    if (seen.has(id) || !Number.isFinite(ts) || ts < cutoff) continue;
    rows.push({ id, runtime: "cursor", kind: "cli", cwd: meta.cwd ?? null,
      project: projectName(meta.cwd), title: meta.name ?? meta.title ?? null,
      status: "unknown", statusSource: "metadata",
      startedAt: Number.isFinite(meta.createdAtMs) ? new Date(meta.createdAtMs).toISOString() : null,
      lastActivityAt: new Date(ts).toISOString(), resumable: true, attachable: false,
      resumeRef: id, transcript: null });
  }
  const listed = new Set(rows.map((r) => r.id));
  for (const [id, meta] of desktop) {
    const ts = typeof meta.updatedAt === "number" ? meta.updatedAt : Date.parse(meta.updatedAt);
    if (listed.has(id) || !Number.isFinite(ts) || ts < cutoff) continue;
    const created = typeof meta.createdAt === "number" ? meta.createdAt : Date.parse(meta.createdAt);
    rows.push({ id, runtime: "cursor", kind: "desktop", cwd: meta.cwd ?? null,
      project: projectName(meta.cwd), title: meta.title ?? null,
      status: meta.status === "completed" ? "idle" : "unknown", statusSource: "metadata",
      startedAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
      lastActivityAt: new Date(ts).toISOString(), resumable: false, attachable: false,
      resumeRef: id, transcript: { format: "cursor-desktop-db", path: meta.dbPath } });
  }
  return rows;
}

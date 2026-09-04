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
import { projectName, transcriptStatus } from "./common.mjs";

const SNIPPET_MAX = 80;
const TITLE_CACHE_MS = 60_000;

function cursorHome(env = process.env) {
  return env.GARRISON_CURSOR_HOME?.trim() || path.join(os.homedir(), ".cursor");
}

function slugFor(cwd) {
  return String(cwd).replace(/[/.]/g, "-");
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
function candidateCwds(chatsCwds) {
  const home = os.homedir();
  const out = new Set(chatsCwds);
  for (const base of [path.join(home, "dev"), path.join(home, "Projects")]) {
    for (const name of listDirs(base)) out.add(path.join(base, name));
  }
  return [...out];
}

let titleCacheAt = 0;
let titleCache = new Map();

/** Cursor desktop composer titles, read once per TITLE_CACHE_MS from the
 *  macOS app's own sqlite store when the `sqlite3` CLI is on PATH. Absent on
 *  Linux (no desktop app) and on any box without sqlite3 - never throws, and
 *  a missing title falls back to the transcript's own first user line. */
function readDesktopTitles() {
  if (Date.now() - titleCacheAt < TITLE_CACHE_MS) return titleCache;
  titleCacheAt = Date.now();
  titleCache = new Map();
  const dbPath = path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  try {
    const out = execFileSync(
      "sqlite3",
      ["-json", dbPath, "select key, value from cursorDiskKV where key like 'composerData:%'"],
      { encoding: "utf8", timeout: 5000 }
    );
    for (const row of JSON.parse(out)) {
      const id = String(row.key).slice("composerData:".length);
      try {
        const v = JSON.parse(row.value);
        if (typeof v?.name === "string" && v.name.trim()) titleCache.set(id, v.name.trim());
      } catch { /* one bad row does not spoil the rest */ }
    }
  } catch { /* sqlite3 absent, db absent/locked, or not macOS - fine */ }
  return titleCache;
}

/** The first user turn's text, snippeted - the fallback title when there is
 *  no desktop composer name (every CLI chat, and Linux boxes with no
 *  sqlite3). Cursor wraps a CLI prompt in <user_query> tags; unwrap it. */
function firstUserLine(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
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
  const slugToCwd = new Map(candidateCwds(chatsCwds).map((c) => [slugFor(c), c]));
  const cutoff = now - windowDays * 86_400_000;
  const titles = readDesktopTitles();

  for (const slug of listDirs(projectsRoot)) {
    const guessedCwd = slugToCwd.get(slug) ?? null;
    const transcriptsRoot = path.join(projectsRoot, slug, "agent-transcripts");
    for (const id of listDirs(transcriptsRoot)) {
      const file = path.join(transcriptsRoot, id, `${id}.jsonl`);
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
      const title = titles.get(id) ?? firstUserLine(file);
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
        // Availability of `cursor-agent` on the transport that would run the
        // resume is decided by session-index.mjs, which knows the transports;
        // this is the structural claim "a resume ref exists for this id".
        resumable: true,
        attachable: false,
        resumeRef: id,
        transcript: { format: "cursor-agent-jsonl", path: file }
      });
    }
  }
  return rows;
}

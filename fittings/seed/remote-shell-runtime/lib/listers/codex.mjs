// Codex sessions across every home this box might run one from: the native
// `$CODEX_HOME` (default ~/.codex) AND Garrison's own per-instance runtime
// homes (each `provision-home.mjs` symlinks its own credential, so a session
// started under a sandbox instance lands under its own homes/codex, not the
// real ~/.codex). No hooks here yet (Codex hook trust is a one-time
// interactive step, see the fitting's install-hooks.mjs) - status is the
// transcript-mtime baseline; the state doc publisher layers hook events over
// it when they exist.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { projectName, codexTranscriptStatus, readJsonlSlice } from "./common.mjs";

/** Day directories under sessions/, newest first, bounded - mirrors
 *  codex-runtime's own adapter (a different fitting; duplicated rather than
 *  cross-imported, per this repo's one-fitting-one-package convention). */
function sessionDayDirs(root) {
  const dirs = [];
  const listNumeric = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => e.name).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of listNumeric(root)) {
    for (const m of listNumeric(path.join(root, y))) {
      for (const d of listNumeric(path.join(root, y, m))) {
        dirs.push(path.join(root, y, m, d));
      }
    }
  }
  return dirs;
}

function codexHomes(env = process.env) {
  const homeDir = env.HOME?.trim() || os.homedir();
  const garrisonHome = env.GARRISON_HOME?.trim() || path.join(homeDir, ".garrison");
  const candidates = [
    path.join(homeDir, ".codex"),
    env.CODEX_HOME?.trim(),
    path.join(garrisonHome, "runtime-homes", "codex"),
    path.join(garrisonHome, "marathon", "codex-home")
  ];
  const seen = new Set();
  const homes = [];
  for (const c of candidates.filter(Boolean)) {
    const abs = path.resolve(c);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      if (fs.statSync(abs).isDirectory()) homes.push(abs);
    } catch { /* home does not exist on this box - fine */ }
  }
  return homes;
}

function readSessionIndex(home) {
  const map = new Map();
  let text;
  try {
    text = fs.readFileSync(path.join(home, "session_index.jsonl"), "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r?.id) map.set(r.id, r);
    } catch { /* skip */ }
  }
  return map;
}

const titleCaches = new Map();
function readStateTitles(home) {
  const cached = titleCaches.get(home);
  if (cached && Date.now() - cached.at < 5000) return cached.titles;
  const titles = new Map();
  titleCaches.set(home, { at: Date.now(), titles });
  let files;
  try { files = fs.readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0])); }
  catch { return titles; }
  for (const name of files) {
    try {
      const file = path.join(home, name);
      const query = (sql) => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", file, sql],
        { encoding: "utf8", timeout: 3000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }) || "[]");
      const columns = new Set(query("pragma table_info(threads)").map((column) => column.name));
      if (!columns.has("id") || !columns.has("title")) continue;
      // Newer clients store a user's explicit rename in name. Read metadata
      // only, never first_user_message, preview, or the whole thread record.
      const title = columns.has("name") ? "coalesce(nullif(name, ''), title)" : "title";
      const order = columns.has("updated_at") ? "order by updated_at desc" : "";
      for (const row of query(`select id, substr(${title}, 1, 200) as title from threads ${order} limit 10000`)) {
        if (typeof row.id === "string" && typeof row.title === "string" && row.title.trim()) titles.set(row.id, row.title.trim());
      }
      break;
    } catch { /* absent sqlite3, migrations, or locks leave journal discovery usable */ }
  }
  return titles;
}

export function list({ windowDays = 5, now = Date.now(), env = process.env } = {}) {
  const rows = [];
  const seen = new Set();
  const cutoff = now - windowDays * 86_400_000;

  for (const home of codexHomes(env)) {
    const index = readSessionIndex(home);
    const titles = readStateTitles(home);
    const root = path.join(home, "sessions");
    for (const dir of sessionDayDirs(root)) {
      let entries;
      try {
        entries = fs.readdirSync(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const name of entries) {
        const file = path.join(dir, name);
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.mtimeMs < cutoff) continue;
        // Only the FIRST record is read to test identity/membership - forks
        // replay the parent's whole history, so reading further would just
        // re-derive the same session_meta anyway.
        let meta = null;
        for (const rec of readJsonlSlice(file, { maxBytes: 64 * 1024 })) {
          if (rec?.type === "session_meta") meta = rec.payload;
          break;
        }
        if (!meta?.id || seen.has(meta.id)) continue;
        // Subagent threads are not top-level sessions worth listing on their
        // own - their content already belongs to the parent thread.
        if (meta.thread_source === "subagent" || meta.source?.subagent) continue;
        seen.add(meta.id);
        const indexed = index.get(meta.id);
        const base = codexTranscriptStatus(file, stat.mtimeMs, now);
        rows.push({
          id: meta.id,
          runtime: "codex",
          kind: "cli",
          cwd: typeof meta.cwd === "string" ? meta.cwd : null,
          project: projectName(meta.cwd),
          title: [titles.get(meta.id), indexed?.thread_name, meta.title, meta.thread_name]
            .find((value) => typeof value === "string" && value.trim()) ?? null,
          ...base,
          startedAt: typeof meta.timestamp === "string" ? meta.timestamp : null,
          lastActivityAt: new Date(stat.mtimeMs).toISOString(),
          resumable: true,
          attachable: false,
          resumeRef: meta.id,
          transcript: { format: "codex-rollout", path: file }
        });
      }
    }
  }
  return rows;
}

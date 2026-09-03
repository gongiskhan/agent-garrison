// Gemini CLI sessions on this node: `~/.gemini/projects.json` maps a cwd to
// its chat-history directory name, and `~/.gemini/tmp/<name>/chats/
// session-<ts>-<id>.jsonl` holds one file per chat, header line first
// ({sessionId, projectHash, startTime, lastUpdated}) followed by `$set`
// patches. `gemini --resume` takes "latest" or a 1-based INDEX; this fitting
// only knows the ordering it can compute itself (startTime ascending within a
// project), so "latest" is always correct and any other index is best-effort
// (see the plan's risk note - unverifiable without an authenticated CLI).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectName, transcriptStatus } from "./common.mjs";

const SNIPPET_MAX = 80;

function geminiHomes(env = process.env) {
  const homeDir = os.homedir();
  const garrisonHome = env.GARRISON_HOME?.trim() || path.join(homeDir, ".garrison");
  const candidates = [
    env.GEMINI_CLI_HOME?.trim() || path.join(homeDir, ".gemini"),
    path.join(garrisonHome, "runtime-homes", "gemini")
  ];
  const seen = new Set();
  const homes = [];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      if (fs.statSync(abs).isDirectory()) homes.push(abs);
    } catch { /* home does not exist on this box - fine */ }
  }
  return homes;
}

function readProjects(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf8"));
    return j?.projects && typeof j.projects === "object" ? j.projects : {};
  } catch {
    return {};
  }
}

function readHeader(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const first = text.split("\n").find((l) => l.trim());
  if (!first) return null;
  try {
    return JSON.parse(first);
  } catch {
    return null;
  }
}

/** The first user turn's text across every `$set.messages` patch, snippeted -
 *  a nicer title than the bare project name, when one is findable. */
function firstUserText(file) {
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
    const messages = rec?.$set?.messages;
    if (!Array.isArray(messages)) continue;
    for (const m of messages) {
      if (m?.type !== "user") continue;
      const parts = Array.isArray(m.content) ? m.content : [];
      const txt = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join(" ").trim();
      if (!txt) continue;
      const oneLine = txt.replace(/\s+/g, " ").trim();
      return oneLine.length > SNIPPET_MAX ? `${oneLine.slice(0, SNIPPET_MAX - 1)}…` : oneLine;
    }
  }
  return null;
}

export function list({ windowDays = 5, now = Date.now(), env = process.env } = {}) {
  const rows = [];
  const cutoff = now - windowDays * 86_400_000;

  for (const home of geminiHomes(env)) {
    const projects = readProjects(home);
    for (const [cwd, name] of Object.entries(projects)) {
      const chatsDir = path.join(home, "tmp", name, "chats");
      let files;
      try {
        files = fs.readdirSync(chatsDir).filter((f) => f.startsWith("session-") && f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      const parsed = [];
      for (const f of files) {
        const file = path.join(chatsDir, f);
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.mtimeMs < cutoff) continue;
        const header = readHeader(file);
        if (!header?.sessionId) continue;
        parsed.push({ file, stat, header });
      }
      // Ascending by startTime, so `latest` is unambiguously the last one -
      // the one ordering fact this module can verify without an authenticated
      // `gemini --list-sessions`.
      parsed.sort((a, b) => (Date.parse(a.header.startTime) || 0) - (Date.parse(b.header.startTime) || 0));
      parsed.forEach((p, i) => {
        const lastMs = Math.max(p.stat.mtimeMs, Date.parse(p.header.lastUpdated) || 0);
        const base = transcriptStatus(lastMs, now);
        rows.push({
          id: p.header.sessionId,
          runtime: "gemini",
          kind: "cli",
          cwd,
          project: projectName(cwd) ?? name,
          title: firstUserText(p.file) ?? name,
          status: base.status,
          statusSource: base.statusSource,
          startedAt: typeof p.header.startTime === "string" ? p.header.startTime : null,
          lastActivityAt: new Date(lastMs).toISOString(),
          resumable: true,
          attachable: false,
          resumeRef: i === parsed.length - 1 ? "latest" : String(i + 1),
          transcript: { format: "gemini-chat-jsonl", path: p.file }
        });
      });
    }
  }
  return rows;
}

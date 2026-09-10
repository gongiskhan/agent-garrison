import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFeedbackQueue } from "../probes/feedback-signals.mjs";
import { hash } from "./contracts.mjs";

function entries(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return []; throw e; } }
function readBounded(file, cap = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r"); const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - cap); const buffer = Buffer.alloc(Math.min(size, cap));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8"); return start ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function redact(text) {
  return String(text).replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{25,})\b/g, "[credential redacted]")
    .replace(/((?:token|password|secret|api[_ -]?key)\s*[=:]\s*)[^\s,;"']{12,}/gi, "$1[redacted]");
}
function textOf(content) {
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((p) => p?.type === "text" || p?.type === "input_text" || p?.type === "output_text").map((p) => p.text).join("\n") : "";
}
function linesFor(file, kind, from, until) {
  const selected = [];
  for (const line of readBounded(file).split("\n")) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const at = row.timestamp ?? row.ts; if (!at || at < from || at >= until) continue;
    let text = "", role = "";
    if (kind === "conversation") {
      if (["user-message", "handoff", "stretch-ended", "escalation", "error", "note"].includes(row.kind)) {
        role = row.kind;
        text = row.payload?.text ?? row.payload?.summary ?? row.payload?.reason ?? JSON.stringify(row.payload ?? {});
      }
    } else if (kind === "claude" && ["user", "assistant"].includes(row.type)) { role = row.type; text = textOf(row.message?.content); }
    else if (kind === "codex") {
      const p = row.payload;
      if (row.type === "event_msg" && p?.type === "user_message") { role = "user"; text = p.message; }
      else if (row.type === "response_item" && p?.type === "message" && p?.role === "assistant" && p?.channel === "final") { role = "assistant"; text = textOf(p.content); }
    }
    if (text?.trim()) selected.push(`${at} ${role}: ${redact(text).slice(0,1600)}`);
  }
  return selected;
}
function walkFiles(dir, depth = 0) {
  if (depth > 4) return [];
  return entries(dir).flatMap((entry) => entry.isSymbolicLink() ? [] : entry.isDirectory()
    ? walkFiles(path.join(dir, entry.name), depth + 1)
    : entry.name.endsWith(".jsonl") ? [path.join(dir, entry.name)] : []);
}

export async function collectDailyEvidence({ day, node, home, env = process.env, client, shared = false, cap = 48 }) {
  const from = `${day}T00:00:00.000Z`, until = new Date(Date.parse(from) + 86400_000).toISOString();
  const sources = [], coverage = [], errors = [];
  const add = (kind, title, ref, at, excerpt, extra = {}) => {
    if (!excerpt || sources.length >= cap) return;
    sources.push({ id: hash(`${node}:${kind}:${ref}:${day}`).slice(0,20), node, kind, title, ref, at, ...extra, excerpt: redact(excerpt).slice(0,2400) });
  };
  const roots = [
    { kind: "conversation", root: path.join(home, "conversations") },
    { kind: "claude", root: path.join(env.GARRISON_CLAUDE_HOME || path.join(os.homedir(), ".claude"), "projects") },
    { kind: "codex", root: path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions", day.slice(0,4), day.slice(5,7), day.slice(8,10)) }
  ];
  for (const { kind, root } of roots) {
    try {
      const files = walkFiles(root).filter((file) => fs.statSync(file).mtimeMs >= Date.parse(from))
        .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0,40);
      let reviewed = 0;
      for (const file of files) {
        const lines = linesFor(file, kind, from, until); if (!lines.length) continue;
        const id = kind === "conversation" ? path.basename(path.dirname(file)) : path.basename(file, ".jsonl");
        const ref = kind === "conversation" ? `/talk/${encodeURIComponent(id)}` : file;
        // Head preserves the objective; tail preserves corrections and outcome.
        add(kind, `${kind === "conversation" ? "Conversation" : kind} ${id}`, ref, day, [...lines.slice(0,2), ...lines.slice(-6)].join("\n")); reviewed++;
      }
      coverage.push({ kind, available: fs.existsSync(root), examined: files.length, reviewed, capped: files.length === 40 });
    } catch (error) { errors.push({ kind, error: error.message }); }
  }
  const reviewDir = path.join(home, "zeca", "reviews");
  for (const entry of entries(reviewDir).filter((e) => e.name.startsWith(day) && e.name.endsWith(".md")).slice(0,8)) {
    const file = path.join(reviewDir, entry.name); add("zeca", "Zeca nightly review", file, day, readBounded(file, 6000));
  }
  if (shared && client) {
    try {
      const rows = (await readFeedbackQueue({client,limit:10000})).entries.map((entry)=>({id:entry.key,...entry.record}));
      const relevant = rows.filter((row) => { const at = row.at ?? row.createdAt ?? row.body?.at; return at && at >= from && at < until; });
      for (const row of relevant.slice(0,15)) add("feedback", "Explicit user feedback", `feedback:${row.id}`, row.at ?? row.createdAt, JSON.stringify(row.body ?? row));
      coverage.push({ kind: "feedback", available: true, reviewed: relevant.length });
    } catch (error) { errors.push({ kind: "feedback", error: error.message }); }
  }
  return { sources, coverage, errors, capped: sources.length >= cap, window: { from, until } };
}

export function localOperationalEvidence({ home, node, day }) {
  const sources = [];
  for (const [name, title] of [["obsidian-vault-sync-status.json", "Vault sync"], ["main-sync.json", "Main deployment sync"]]) {
    let value; try { value = JSON.parse(fs.readFileSync(path.join(home,name), "utf8")); }
    catch (error) { value = { error: error.message }; }
    sources.push({ id: hash(`${node}:${name}:${day}`).slice(0,20), node, kind: "operations", title,
      ref: path.join(home,name), at: value.ts ?? value.at ?? null, value });
  }
  return sources;
}

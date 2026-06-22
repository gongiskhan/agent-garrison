// skill-telemetry.mjs — deterministic, bounded scanner of Claude Code session
// transcripts for Skill tool usage (Improver skills rule, v1).
//
// Mirrors the caps discipline of src/lib/claude-logs.ts: entry/line/byte caps,
// bounded recursion, drops SURFACED (never silent). Walks *.jsonl under the
// projects root (default ~/.claude/projects; env IMPROVER_PROJECTS_DIR) including
// each session's subagents/*.jsonl. For each assistant tool_use {name:"Skill"}
// it accumulates per-skill usage + the latest citation (sessionId + timestamp +
// args excerpt), and captures an adjacent is_error tool_result (correlated by
// tool_use_id) as an optional failure signal. No model, no network — pure FS
// reads, fully deterministic given a fixed projects dir.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_CAPS = Object.freeze({
  maxFiles: 2000, // total transcript files scanned
  maxLinesPerFile: 50_000, // lines parsed per file
  maxBytesPerLine: 256 * 1024, // a single line larger than this is dropped
  walkDepth: 5, // projects/<proj>/<sid>/subagents/<file> is depth 4
  argsExcerptLen: 200, // citation args excerpt cap
});

// Parse ONE transcript line. Returns null for unparseable/irrelevant lines, or
// { uses, results } where uses are Skill tool_use records and results are
// is_error tool_result back-references. Exported standalone for fixture unit
// tests (the brief calls this out explicitly).
export function parseTranscriptLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const msg = obj.message;
  const content = msg && Array.isArray(msg.content) ? msg.content : null;
  if (!content) return null;

  const uses = [];
  const results = [];
  for (const el of content) {
    if (!el || typeof el !== "object") continue;
    if (
      obj.type === "assistant" &&
      el.type === "tool_use" &&
      el.name === "Skill" &&
      el.input &&
      typeof el.input.skill === "string"
    ) {
      uses.push({
        skill: el.input.skill,
        toolUseId: typeof el.id === "string" ? el.id : null,
        argsExcerpt: typeof el.input.args === "string" ? el.input.args : "",
        sessionId: typeof obj.sessionId === "string" ? obj.sessionId : null,
        timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null,
      });
    }
    if (el.type === "tool_result" && el.is_error === true) {
      results.push({ toolUseId: typeof el.tool_use_id === "string" ? el.tool_use_id : null });
    }
  }
  if (!uses.length && !results.length) return null;
  return { uses, results };
}

function collectJsonl(dir, depth, out, caps) {
  if (out.length > caps.maxFiles) return; // overflow detected by caller
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Stable order so the scan is deterministic regardless of FS enumeration order.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (out.length > caps.maxFiles) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth <= 0) continue;
      collectJsonl(abs, depth - 1, out, caps);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(abs);
    }
  }
}

// scanSkillTelemetry({projectsDir, now, caps}) -> { bySkill, scanned }
//   bySkill[skill] = { useCount, lastUsedAt, sessionIds:Set, lastCitation:{sessionId,timestamp,argsExcerpt,error?}, errorCount }
//   scanned = { files, lines, dropped:{files, lines, bytes} }
// `now` is accepted for API symmetry with the rest of the pipeline (recency is
// computed downstream from lastUsedAt); the scan itself records absolute times.
export function scanSkillTelemetry({ projectsDir, now = null, caps = DEFAULT_CAPS } = {}) {
  const root =
    projectsDir ||
    process.env.IMPROVER_PROJECTS_DIR ||
    path.join(os.homedir(), ".claude", "projects");
  const c = { ...DEFAULT_CAPS, ...(caps || {}) };

  const bySkill = {};
  const scanned = { files: 0, lines: 0, dropped: { files: 0, lines: 0, bytes: 0 } };
  const useById = new Map(); // toolUseId -> skill (for is_error correlation)

  const files = [];
  collectJsonl(root, c.walkDepth, files, c);
  if (files.length > c.maxFiles) {
    scanned.dropped.files = files.length - c.maxFiles;
    files.length = c.maxFiles;
  }

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    scanned.files++;
    let parsedLines = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      if (parsedLines >= c.maxLinesPerFile) {
        scanned.dropped.lines++;
        continue;
      }
      if (Buffer.byteLength(line) > c.maxBytesPerLine) {
        scanned.dropped.bytes++;
        continue;
      }
      parsedLines++;
      scanned.lines++;
      const parsed = parseTranscriptLine(line);
      if (parsed === null) continue;
      for (const u of parsed.uses) {
        const rec =
          bySkill[u.skill] ||
          (bySkill[u.skill] = {
            useCount: 0,
            lastUsedAt: null,
            sessionIds: new Set(),
            lastCitation: null,
            errorCount: 0,
          });
        rec.useCount++;
        if (u.sessionId) rec.sessionIds.add(u.sessionId);
        if (u.timestamp && (!rec.lastUsedAt || u.timestamp > rec.lastUsedAt)) {
          rec.lastUsedAt = u.timestamp;
        }
        // Citation = the most recent use seen (by timestamp; ties keep latest).
        const ts = u.timestamp || "";
        if (!rec.lastCitation || ts >= (rec.lastCitation.timestamp || "")) {
          rec.lastCitation = {
            sessionId: u.sessionId,
            timestamp: u.timestamp,
            argsExcerpt: (u.argsExcerpt || "").slice(0, c.argsExcerptLen),
          };
        }
        if (u.toolUseId) useById.set(u.toolUseId, u.skill);
      }
      for (const r of parsed.results) {
        if (!r.toolUseId || !useById.has(r.toolUseId)) continue;
        const skill = useById.get(r.toolUseId);
        const rec = bySkill[skill];
        if (!rec) continue;
        rec.errorCount++;
        if (rec.lastCitation) rec.lastCitation.error = true;
      }
    }
  }

  return { bySkill, scanned };
}

// Serialize a telemetry result for persistence (Set -> array). Reading code uses
// the in-memory Set form for membership checks; this is only for the JSON file.
export function telemetryToJSON(telemetry) {
  const bySkill = {};
  for (const [name, v] of Object.entries(telemetry.bySkill || {})) {
    bySkill[name] = { ...v, sessionIds: [...(v.sessionIds || [])] };
  }
  return { bySkill, scanned: telemetry.scanned };
}

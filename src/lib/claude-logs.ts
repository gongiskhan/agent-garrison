import fs from "node:fs/promises";
import path from "node:path";
import { claudeHome } from "./claude-home";

// Read-only tailing of the real ~/.claude observability surfaces (UI6/UI7).
//
// Two categories, both READ-ONLY — Garrison never writes these records:
//   logs     -> logs/**, debug/**, and top-level *.log (e.g. daemon.log)
//   sessions -> sessions/*.json (per-pid records) + projects/**/*.jsonl
//               (the full Claude Code session transcripts)
//
// Everything routes through claudeHome() so the e2e/walkthrough sandbox seam
// (GARRISON_CLAUDE_HOME) is honoured; automated runs never touch the live
// ~/.claude. The selected-file read is path-traversal guarded: the requested
// relPath must resolve inside claudeHome AND under the category's allowed roots,
// with a realpath containment check defeating symlink escapes.

export type LogCategory = "logs" | "sessions";

export interface LogEntry {
  relPath: string; // claudeHome-relative, posix
  name: string; // display label
  group?: string; // e.g. the project dir for a transcript
  bytes: number;
  mtimeMs: number;
}

export interface LogTail {
  relPath: string;
  lines: string[];
  bytes: number; // bytes read for the tail
  totalBytes: number; // full file size
  truncated: boolean; // true if the head of the file was dropped
}

// Caps — listing and tailing are bounded so a huge projects/ tree or a multi-MB
// transcript can't blow up the request. Drops are surfaced (not silent).
const MAX_ENTRIES = 500;
const WALK_DEPTH = 4;
const DEFAULT_MAX_LINES = 400;
const DEFAULT_MAX_BYTES = 256 * 1024;

interface CategorySpec {
  // allowed top-level directories under claudeHome for this category
  dirs: string[];
  // whether a top-level *.log file (e.g. daemon.log) belongs to this category
  topLevelLogFiles: boolean;
  // predicate for which files to list
  match: (relPath: string) => boolean;
}

const CATEGORIES: Record<LogCategory, CategorySpec> = {
  logs: {
    dirs: ["logs", "debug"],
    topLevelLogFiles: true,
    match: (rel) => /\.(log|txt|jsonl?)$/i.test(rel) || rel.endsWith(".log")
  },
  sessions: {
    dirs: ["sessions", "projects"],
    topLevelLogFiles: false,
    match: (rel) => rel.endsWith(".json") || rel.endsWith(".jsonl")
  }
};

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

async function walk(root: string, home: string, depth: number, out: LogEntry[]): Promise<boolean> {
  // returns false if the MAX_ENTRIES cap was hit (caller surfaces the drop)
  let dirents;
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const e of dirents) {
    if (out.length >= MAX_ENTRIES) return false;
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      if (depth <= 0) continue;
      const ok = await walk(abs, home, depth - 1, out);
      if (!ok) return false;
    } else if (e.isFile()) {
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      out.push({
        relPath: toPosix(path.relative(home, abs)),
        name: e.name,
        group: toPosix(path.relative(home, path.dirname(abs))),
        bytes: st.size,
        mtimeMs: st.mtimeMs
      });
    }
  }
  return true;
}

export interface LogListing {
  entries: LogEntry[];
  capped: boolean; // MAX_ENTRIES reached — more files exist than are listed
}

export async function listLogEntries(category: LogCategory, home: string = claudeHome()): Promise<LogListing> {
  const spec = CATEGORIES[category];
  const collected: LogEntry[] = [];
  let capped = false;

  for (const dir of spec.dirs) {
    const ok = await walk(path.join(home, dir), home, WALK_DEPTH, collected);
    if (!ok) {
      capped = true;
      break;
    }
  }

  if (spec.topLevelLogFiles && !capped) {
    try {
      for (const e of await fs.readdir(home, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith(".log")) {
          const abs = path.join(home, e.name);
          try {
            const st = await fs.stat(abs);
            collected.push({ relPath: e.name, name: e.name, bytes: st.size, mtimeMs: st.mtimeMs });
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* no home listing */
    }
  }

  const entries = collected
    .filter((e) => spec.match(e.relPath))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return { entries, capped };
}

// Resolves+validates a client-supplied relPath for a category. Throws on any
// escape. Returns the real absolute path + its realhome-relative posix path.
async function resolveSafe(
  category: LogCategory,
  relPath: string,
  home: string
): Promise<{ abs: string; rel: string }> {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("path is required");
  }
  if (relPath.includes("\0")) throw new Error("invalid path");

  const abs = path.resolve(home, relPath);
  const rel = path.relative(home, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes the Claude home directory");
  }

  const spec = CATEGORIES[category];
  const top = toPosix(rel).split("/")[0];
  const isTopLevelLog = spec.topLevelLogFiles && !toPosix(rel).includes("/") && rel.endsWith(".log");
  if (!spec.dirs.includes(top) && !isTopLevelLog) {
    throw new Error(`path is not within the ${category} surface`);
  }

  // Symlink-escape guard: the realpath must stay inside the realpath of home.
  const realHome = await fs.realpath(home);
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    throw new Error("file not found");
  }
  if (real !== realHome && !real.startsWith(realHome + path.sep)) {
    throw new Error("path escapes the Claude home directory");
  }

  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error("not a file");
  return { abs: real, rel: toPosix(path.relative(realHome, real)) };
}

export async function tailLogEntry(
  category: LogCategory,
  relPath: string,
  opts: { maxLines?: number; maxBytes?: number } = {},
  home: string = claudeHome()
): Promise<LogTail> {
  const { abs, rel } = await resolveSafe(category, relPath, home);
  const maxLines = Math.max(1, Math.min(opts.maxLines ?? DEFAULT_MAX_LINES, 5000));
  const maxBytes = Math.max(1, Math.min(opts.maxBytes ?? DEFAULT_MAX_BYTES, 2 * 1024 * 1024));

  const handle = await fs.open(abs, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) await handle.read(buf, 0, len, start);
    let text = buf.toString("utf8");
    let headDropped = start > 0;
    let lines = text.split(/\r?\n/);
    // If we started mid-file, the first line is partial — drop it.
    if (headDropped && lines.length > 0) lines = lines.slice(1);
    // Drop a trailing empty line from a final newline.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
    if (lines.length > maxLines) {
      lines = lines.slice(lines.length - maxLines);
      headDropped = true;
    }
    return {
      relPath: rel,
      lines,
      bytes: len,
      totalBytes: size,
      truncated: headDropped
    };
  } finally {
    await handle.close();
  }
}

import { promises as fs } from "node:fs";
import { claudeJsonPath } from "./claude-home";
import { writeFileAtomic, CasMismatchError } from "./atomic-write";

// Reader (and, from HV6, a guarded delta-writer) for Claude Code's user config
// at `~/.claude.json`. This file holds the REAL user-scope `mcpServers` Claude
// Code loads, plus 600+ `projects` entries, oauth tokens, and caches. We only
// ever read/mutate the `mcpServers` subtree; everything else is preserved
// verbatim. The empty in-`~/.claude` `mcp.json` is legacy — see claude-scan.ts.

export type McpServerConfig = Record<string, unknown>;

export interface ClaudeJson {
  // True when the file is present AND parsed to an object — i.e. it is the
  // AUTHORITATIVE source. Callers use this to decide whether to fall back to the
  // legacy ~/.claude/mcp.json (only when false).
  exists: boolean;
  // The whole parsed document (every sibling key preserved for write-back).
  raw: Record<string, unknown>;
  // The `mcpServers` subtree (user scope), or {} when absent/malformed.
  mcpServers: Record<string, McpServerConfig>;
}

function extractMcpServers(raw: unknown): Record<string, McpServerConfig> {
  if (
    raw &&
    typeof raw === "object" &&
    "mcpServers" in raw &&
    (raw as Record<string, unknown>).mcpServers &&
    typeof (raw as Record<string, unknown>).mcpServers === "object" &&
    !Array.isArray((raw as Record<string, unknown>).mcpServers)
  ) {
    return (raw as { mcpServers: Record<string, McpServerConfig> }).mcpServers;
  }
  return {};
}

export async function readClaudeJson(file: string = claudeJsonPath()): Promise<ClaudeJson> {
  try {
    const text = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>;
      return { exists: true, raw, mcpServers: extractMcpServers(raw) };
    }
    // Present but not an object → not authoritative; let callers fall back.
    return { exists: false, raw: {}, mcpServers: {} };
  } catch {
    // Missing / unparseable → no user-scope servers, not authoritative. (Never
    // throws: a corrupt shared file must degrade gracefully, not crash the scan.)
    return { exists: false, raw: {}, mcpServers: {} };
  }
}

// Sorted names of the user-scope MCP servers Claude Code actually loads.
export async function userMcpServerNames(file: string = claudeJsonPath()): Promise<string[]> {
  const { mcpServers } = await readClaudeJson(file);
  return Object.keys(mcpServers).sort();
}

// Full config map for the user-scope servers (name -> config), for the detail/
// CRUD surfaces. Reads the same subtree as userMcpServerNames.
export async function userMcpServers(file: string = claudeJsonPath()): Promise<Record<string, McpServerConfig>> {
  const { mcpServers } = await readClaudeJson(file);
  return mcpServers;
}

// ---- guarded MCP subtree writer (HV6) -------------------------------------
//
// ~/.claude.json is a large SHARED file that a running Claude Code rewrites on
// /model, permission approvals, etc. We mutate ONLY the `mcpServers` subtree and
// preserve every sibling key. The hazard is a lost update: a concurrent Claude
// write landing between our read and our rename. We guard with optimistic
// concurrency (compare-and-swap) + a bounded retry, and on a persistent race we
// ABORT leaving the live file untouched — we NEVER restore a pre-write backup,
// because that would silently revert a legitimate concurrent change (the exact
// silent-failure class the observability rules exist to prevent).

export type McpDelta =
  | { op: "set"; name: string; config: McpServerConfig }
  | { op: "remove"; name: string };

export class McpWriteRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpWriteRaceError";
  }
}

// Thrown when ~/.claude.json is present but NOT a parseable JSON object. We never
// overwrite it in that state — doing so would replace the whole shared file
// (oauth tokens, 600+ projects) with just `{mcpServers}`. A transient corruption
// (e.g. caught mid-write) must abort, not nuke the file.
export class ClaudeJsonCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeJsonCorruptError";
  }
}

async function readRawText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface ApplyMcpMutationOpts {
  file?: string;
  maxAttempts?: number;
  // TEST SEAM: invoked each attempt AFTER we read the file + built the next
  // document, but BEFORE the guarded write — lets a test simulate a concurrent
  // writer landing in the critical window, deterministically.
  beforeWrite?: (attempt: number) => void | Promise<void>;
}

// CORE writer: atomically apply `mutate` to the `mcpServers` subtree of
// ~/.claude.json, PRESERVING every sibling key. Guards:
//  (1) REFUSE to overwrite a present-but-unparseable / non-object file.
//  (2) Optimistic concurrency via writeFileAtomic's `cas` (re-checks the file
//      immediately before rename) + bounded retry. On a persistent race it
//      ABORTS leaving the live file exactly as the concurrent writer left it —
//      it never restores an old backup (that would silently revert a legitimate
//      concurrent Claude write). A single mutate() call = ONE atomic write, so a
//      rename (delete+set) can't half-apply.
export async function applyMcpMutation(
  mutate: (servers: Record<string, McpServerConfig>) => void,
  opts: ApplyMcpMutationOpts = {}
): Promise<Record<string, McpServerConfig>> {
  const file = opts.file ?? claudeJsonPath();
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  let lastErr: McpWriteRaceError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = await readRawText(file);
    let doc: Record<string, unknown> = {};
    if (before !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(before);
      } catch {
        throw new ClaudeJsonCorruptError(`refusing to overwrite unparseable ${file} (mcpServers mutation aborted to protect siblings)`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ClaudeJsonCorruptError(`${file} is not a JSON object — refusing to overwrite`);
      }
      doc = parsed as Record<string, unknown>;
    }
    const servers: Record<string, McpServerConfig> = { ...extractMcpServers(doc) };
    mutate(servers);
    const nextDoc = { ...doc, mcpServers: servers };
    const nextText = `${JSON.stringify(nextDoc, null, 2)}\n`;

    if (opts.beforeWrite) await opts.beforeWrite(attempt);

    try {
      await writeFileAtomic(file, nextText, { cas: { priorContent: before } });
    } catch (e) {
      if (e instanceof CasMismatchError) {
        lastErr = new McpWriteRaceError(
          `~/.claude.json changed concurrently (attempt ${attempt}/${maxAttempts}) — retrying on the new state`
        );
        continue;
      }
      throw e;
    }
    return servers;
  }
  throw lastErr ?? new McpWriteRaceError(`MCP mutation aborted after ${maxAttempts} attempts`);
}

// Thin wrapper: a single add/remove. (Rename = a single applyMcpMutation that
// deletes + sets in one atomic write — see mcp-user.updateUserMcpServer.)
export async function applyMcpDelta(
  delta: McpDelta,
  opts: ApplyMcpMutationOpts = {}
): Promise<Record<string, McpServerConfig>> {
  return applyMcpMutation((servers) => {
    if (delta.op === "set") servers[delta.name] = delta.config;
    else delete servers[delta.name];
  }, opts);
}

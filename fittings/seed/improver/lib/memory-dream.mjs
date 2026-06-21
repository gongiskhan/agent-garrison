// memory-dream.mjs — the Improver's "dream" memory-consolidation rule over the
// Basic Memory Obsidian vault (mimics Claude Code's background `autoDreamEnabled`
// consolidation pass). Pure scan helpers + proposal builders, plus a thin IO
// orchestrator (runDreamPhase) that BOTH the CLI (scripts/improver.mjs, nightly)
// and the own-port server (scripts/server.mjs, UI "Run now") drive.
//
// Two phases, mirroring the skills rule:
//   1. DETERMINISTIC housekeeping (free, auto-applies): archive stale
//      `Memory/session-*.md` capture checkpoints; `basic-memory reindex` +
//      `doctor`. No model, no review.
//   2. ONE capped, evidence-cited PTY model pass (@garrison/claude-pty#oneShotTurn
//      — never the Agent SDK, never the warm pool, same path as skill-proposal.mjs)
//      that proposes durable distillations from checkpoints, note merges,
//      contradiction resolutions, and relative→absolute date fixes. EVERY proposal
//      MUST cite source note path(s) that exist in the vault — a fabricated path is
//      dropped (the anti-hallucination gate, like the skills sessionId gate).
//      These proposals enter the existing review queue under rule `memory-dream`.
//
// The dream phase runs ONLY on the primary machine (memory_primary), so three
// machines sharing one vault don't triple-propose; the skills phase is per-machine.

import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const INVOCATION_PATH = "@garrison/claude-pty#oneShotTurn";
export const DREAM_KINDS = ["distill", "merge", "contradiction", "date-fix", "prune"];

// Relative / non-absolute time references a dream pass should propose pinning to
// absolute dates. Word-boundary anchored; case-insensitive at call time.
export const RELATIVE_DATE_PATTERNS = [
  /\b(today|tonight|yesterday|tomorrow)\b/i,
  /\b(this|last|next)\s+(week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(this|last|next)\s+(morning|afternoon|evening|night)\b/i,
  /\b\d+\s+(day|week|month|year)s?\s+ago\b/i,
  /\b(currently|right now|as of now|recently|nowadays|these days|soon|a few days ago|the other day)\b/i,
];

function shortHash(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
}

// ── note model ───────────────────────────────────────────────────────────────
// A note is { path (vault-relative), title, content, mtimeMs }.

function frontmatterTitle(content) {
  const m = String(content).match(/^---\n([\s\S]*?)\n---/);
  if (m) {
    const t = m[1].match(/^title:\s*(.+)$/m);
    if (t) return t[1].trim().replace(/^["']|["']$/g, "");
  }
  const h = String(content).match(/^#\s+(.+)$/m);
  return h ? h[1].trim() : null;
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Strip frontmatter + markdown punctuation; return a lowercase word multiset key.
function tokenize(text) {
  const body = String(text).replace(/^---\n[\s\S]*?\n---\n?/, "");
  return body
    .toLowerCase()
    .replace(/[`*#>\-\[\]()_~|]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const w of aSet) if (bSet.has(w)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}

// ── duplicate detection (pure) ───────────────────────────────────────────────
// Groups notes that are the same memory expressed twice: identical normalized
// title, OR content Jaccard >= threshold. Union-find over both signals so a
// transitive cluster (a~b, b~c) becomes one group. Returns groups of >= 2.
export function findDuplicateNotes(notes = [], { jaccardThreshold = 0.8 } = {}) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    parent.set(find(a), find(b));
  };
  for (const n of notes) parent.set(n.path, n.path);

  // title signal
  const byTitle = new Map();
  for (const n of notes) {
    const key = normalizeTitle(n.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(n.path);
  }
  for (const paths of byTitle.values()) {
    for (let i = 1; i < paths.length; i++) union(paths[0], paths[i]);
  }

  // content signal (O(n^2); vault note counts are small)
  const tokens = notes.map((n) => new Set(tokenize(n.content)));
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      if (find(notes[i].path) === find(notes[j].path)) continue;
      if (jaccard(tokens[i], tokens[j]) >= jaccardThreshold) union(notes[i].path, notes[j].path);
    }
  }

  const groups = new Map();
  const titleByPath = new Map(notes.map((n) => [n.path, n.title]));
  for (const n of notes) {
    const root = find(n.path);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(n.path);
  }
  return [...groups.values()]
    .filter((members) => members.length >= 2)
    .map((members) => ({
      members: members.slice().sort(),
      titles: members.map((p) => titleByPath.get(p)).filter(Boolean),
    }));
}

// ── relative-date detection (pure) ───────────────────────────────────────────
// Finds body lines that use relative time references, skipping frontmatter and
// fenced code blocks. Returns [{ path, line, lineNumber }].
export function scanRelativeDates(notes = []) {
  const hits = [];
  for (const n of notes) {
    const lines = String(n.content).split("\n");
    let inFrontmatter = false;
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0 && line.trim() === "---") { inFrontmatter = true; continue; }
      if (inFrontmatter) { if (line.trim() === "---") inFrontmatter = false; continue; }
      if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
      if (inCode) continue;
      if (RELATIVE_DATE_PATTERNS.some((re) => re.test(line))) {
        hits.push({ path: n.path, line: line.trim().slice(0, 200), lineNumber: i + 1 });
      }
    }
  }
  return hits;
}

// ── stale checkpoint selection (pure) ────────────────────────────────────────
// files: [{ name, path, mtimeMs }]; returns the capture checkpoints older than
// retentionDays relative to `now`. Only matches session-*.md (the capture hook's
// own output) so durable notes are never archived.
export function selectStaleCheckpoints(files = [], { now = null, retentionDays = 14 } = {}) {
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  return files.filter((f) => /(^|\/)session-.*\.md$/.test(f.name || f.path || "") && (f.mtimeMs ?? Infinity) < cutoff);
}

// ── LLM phase: prompt + tolerant parse + validated proposals ──────────────────
export function tolerantJSON(reply) {
  if (!reply || typeof reply !== "string") return null;
  try { return JSON.parse(reply); } catch { /* fall through */ }
  const obj = reply.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch { /* ignore */ } }
  const arr = reply.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch { /* ignore */ } }
  return null;
}

function itemsFrom(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.proposals)) return parsed.proposals;
  return [];
}

export function buildDreamSystemPrompt() {
  return [
    "You are the Improver's memory-consolidation reviewer — the 'dream' pass over a",
    "Basic Memory Obsidian vault (plain-markdown notes indexed into a knowledge graph).",
    "You consolidate: you do not capture. Your job is to keep the memory concise, true,",
    "and durable by proposing:",
    "  - distill: a durable note distilled from raw session checkpoints,",
    "  - merge: fold near-duplicate notes into one canonical note,",
    "  - contradiction: resolve two notes that disagree,",
    "  - date-fix: rewrite a relative date (\"yesterday\", \"last week\") to an absolute one,",
    "  - prune: drop a stale or superseded speculative note.",
    "",
    "Rules:",
    "- EVERY proposal MUST cite the real source note path(s) in `sources`, taken verbatim",
    "  from the 'Known vault note paths' list. NEVER invent a path. A proposal whose",
    "  sources are not in that list is discarded.",
    "- Be conservative: propose only where the evidence below justifies it.",
    "- `body` is the proposed markdown (the distilled/merged note, the resolution, or the",
    "  corrected line). For date-fix, infer the absolute date from the checkpoint metadata.",
    "",
    "Respond with ONLY valid JSON, no markdown fences:",
    '{"proposals":[{"kind":"distill|merge|contradiction|date-fix|prune","sources":["<path>"],"title":"<short>","claim":"<one sentence>","body":"<markdown>"}]}',
  ].join("\n");
}

export function buildDreamMessage({ checkpoints = [], duplicates = [], relativeDates = [], knownPaths = [] } = {}) {
  const out = [];
  out.push("Known vault note paths (cite only these in `sources`):");
  for (const p of knownPaths) out.push(`- ${p}`);
  out.push("");
  if (checkpoints.length) {
    out.push("Recent session checkpoints to distill (path :: excerpt):");
    for (const c of checkpoints) {
      const excerpt = String(c.content).replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/\s+/g, " ").trim().slice(0, 600);
      out.push(`- ${c.path} :: ${excerpt}`);
    }
    out.push("");
  }
  if (duplicates.length) {
    out.push("Candidate duplicate groups (consider merge):");
    for (const g of duplicates) out.push(`- ${g.members.join(" + ")}`);
    out.push("");
  }
  if (relativeDates.length) {
    out.push("Relative-date lines (consider date-fix):");
    for (const r of relativeDates.slice(0, 40)) out.push(`- ${r.path}:${r.lineNumber} :: ${r.line}`);
    out.push("");
  }
  out.push("Propose consolidations per the system instructions.");
  return out.join("\n");
}

// Validate + shape model items into reviewable proposals. knownPaths gates the
// citations (anti-hallucination). cap is enforced here (never trust the model).
export function buildDreamProposals({ items = [], knownPaths = [], cap = 8, at = null } = {}) {
  const known = new Set(knownPaths);
  const proposals = [];
  const dropped = [];
  const seen = new Set();
  const stamp = at || new Date().toISOString();

  for (const it of items) {
    if (proposals.length >= cap) { dropped.push({ reason: "over-cap" }); continue; }
    if (!it || typeof it !== "object") { dropped.push({ reason: "not-object" }); continue; }
    const kind = typeof it.kind === "string" ? it.kind.trim() : "";
    if (!DREAM_KINDS.includes(kind)) { dropped.push({ kind, reason: "bad-kind" }); continue; }
    const sources = Array.isArray(it.sources) ? it.sources.filter((s) => typeof s === "string") : [];
    if (!sources.length) { dropped.push({ kind, reason: "no-sources" }); continue; }
    const unknown = sources.filter((s) => !known.has(s));
    if (unknown.length) { dropped.push({ kind, sources, unknown, reason: "fabricated-source" }); continue; }
    const body = typeof it.body === "string" ? it.body : "";
    if (!body.trim()) { dropped.push({ kind, reason: "empty-body" }); continue; }
    const claim = typeof it.claim === "string" && it.claim.trim()
      ? it.claim.trim()
      : `Consolidate ${sources.join(", ")} (${kind}).`;
    const title = typeof it.title === "string" && it.title.trim() ? it.title.trim() : sources[0];
    const id = `memory-dream-${kind}-${shortHash(sources.join("|") + title + body)}`;
    if (seen.has(id)) { dropped.push({ kind, reason: "dupe" }); continue; }
    seen.add(id);

    const diff = body.split("\n").map((l) => `+${l}`).join("\n");
    proposals.push({
      id,
      rule: "memory-dream",
      targetClass: "memory/vault",
      targetFile: sources[0],
      claim,
      evidence: { kind, sources, signal: kind },
      diff,
      decision: `Apply this ${kind} to the vault?`,
      applyVia: "POST /api/quarters file.update (vault)",
      at: stamp,
    });
  }
  return { proposals: proposals.slice(0, cap), dropped };
}

// Default runTurn: dynamic import of the PTY one-shot — the ONLY model entry
// point (no Agent SDK, no warm pool). Injected in tests / fixture replay so a
// hermetic run never loads the package or spawns a TUI.
async function defaultRunTurn({ systemPrompt, model, message, timeoutMs }) {
  const mod = await import("@garrison/claude-pty");
  const oneShotTurn = mod.oneShotTurn;
  if (typeof oneShotTurn !== "function") {
    throw new Error("@garrison/claude-pty#oneShotTurn not available — run setup first");
  }
  const promptDir = mkdtempSync(path.join(tmpdir(), "improver-dream-"));
  const promptFile = path.join(promptDir, "system-prompt.md");
  writeFileSync(promptFile, systemPrompt, "utf8");
  return oneShotTurn({
    cwd: promptDir,
    appendSystemPromptFile: promptFile,
    model,
    permissionMode: "bypassPermissions",
    message,
    timeoutMs: timeoutMs ?? 90_000,
  });
}

// ── vault IO helpers (used by the orchestrator; pure-ish over a given dir) ─────
const VAULT_SKIP_DIRS = new Set([".git", ".obsidian", ".serena", ".trash", "node_modules"]);

export function readVaultNotes(vaultDir, { maxFiles = 5000, maxBytes = 64 * 1024, memoryDir = "Memory" } = {}) {
  const notes = [];
  if (!vaultDir || !existsSync(vaultDir)) return notes;
  let entries = [];
  try {
    entries = readdirSync(vaultDir, { recursive: true, withFileTypes: true });
  } catch {
    return notes;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    // ent.parentPath (node 20.12+) / ent.path (older) is the containing dir.
    const dir = ent.parentPath ?? ent.path ?? vaultDir;
    const abs = path.join(dir, ent.name);
    const rel = path.relative(vaultDir, abs);
    if (rel.split(path.sep).some((seg) => VAULT_SKIP_DIRS.has(seg))) continue;
    if (rel.startsWith(path.join(memoryDir, "archive"))) continue;
    let content = "";
    let mtimeMs = 0;
    try {
      const st = statSync(abs);
      mtimeMs = st.mtimeMs;
      content = readFileSync(abs, "utf8").slice(0, maxBytes);
    } catch {
      continue;
    }
    notes.push({ path: rel, title: frontmatterTitle(content) || ent.name.replace(/\.md$/, ""), content, mtimeMs });
    if (notes.length >= maxFiles) break;
  }
  return notes;
}

// runDreamPhase — the IO orchestrator. Side effects are confined to vaultDir
// (archiving stale checkpoints) and an optional `runCommand` (basic-memory
// reindex/doctor). Everything else is the pure helpers above. Seams:
//   runTurn       inject for hermetic model replay (default: PTY one-shot)
//   runCommand    inject ({cmd,args}) => {ok,stdout} for basic-memory; null skips
//   now           pinned ISO timestamp
//   dryRun        when true, do not move files (housekeeping is reported only)
export async function runDreamPhase({
  vaultDir,
  memoryDir = "Memory",
  retentionDays = 14,
  checkpointLookbackDays = 1,
  model = "haiku",
  cap = 8,
  runTurn = defaultRunTurn,
  runCommand = null,
  now = null,
  dryRun = false,
} = {}) {
  const at = now || new Date().toISOString();
  const nowMs = new Date(at).getTime();
  const notes = readVaultNotes(vaultDir, { memoryDir });
  const knownPaths = notes.map((n) => n.path);

  // checkpoint files (for lookback + stale selection)
  const checkpointNotes = notes.filter((n) => /(^|\/)session-.*\.md$/.test(n.path));
  const lookbackCutoff = nowMs - checkpointLookbackDays * 24 * 60 * 60 * 1000;
  const recentCheckpoints = checkpointNotes.filter((n) => (n.mtimeMs ?? 0) >= lookbackCutoff);

  // ── deterministic housekeeping (auto) ──
  const staleFiles = selectStaleCheckpoints(
    checkpointNotes.map((n) => ({ name: path.basename(n.path), path: n.path, mtimeMs: n.mtimeMs })),
    { now: at, retentionDays }
  );
  const archived = [];
  if (!dryRun && vaultDir) {
    const archiveDir = path.join(vaultDir, memoryDir, "archive");
    for (const f of staleFiles) {
      try {
        mkdirSync(archiveDir, { recursive: true });
        const src = path.join(vaultDir, f.path);
        const dst = path.join(archiveDir, path.basename(f.path));
        renameSync(src, dst);
        archived.push(f.path);
      } catch { /* best-effort; never fail the run */ }
    }
  } else {
    for (const f of staleFiles) archived.push(f.path);
  }

  let reindex = "skipped";
  let doctor = "skipped";
  if (runCommand) {
    try { reindex = (await runCommand({ cmd: "basic-memory", args: ["reindex"] }))?.ok ? "ok" : "error"; } catch { reindex = "error"; }
    try { doctor = (await runCommand({ cmd: "basic-memory", args: ["doctor"] }))?.ok ? "ok" : "error"; } catch { doctor = "error"; }
  }

  // ── LLM consolidation pass (review-queued) ──
  const duplicates = findDuplicateNotes(notes);
  const relativeDates = scanRelativeDates(notes);
  let dreamProposals = [];
  let dropped = [];
  let raw = null;
  if (recentCheckpoints.length || duplicates.length || relativeDates.length) {
    const { reply } =
      (await runTurn({
        systemPrompt: buildDreamSystemPrompt(),
        model,
        message: buildDreamMessage({ checkpoints: recentCheckpoints, duplicates, relativeDates, knownPaths }),
        timeoutMs: 90_000,
      })) || {};
    raw = reply ?? null;
    const built = buildDreamProposals({ items: itemsFrom(tolerantJSON(reply)), knownPaths, cap, at });
    dreamProposals = built.proposals;
    dropped = built.dropped;
  }

  return {
    dreamProposals,
    dropped,
    invocationPath: INVOCATION_PATH,
    raw,
    housekeeping: {
      archived,
      staleCount: staleFiles.length,
      reindex,
      doctor,
      noteCount: notes.length,
      duplicateGroups: duplicates.length,
      relativeDateLines: relativeDates.length,
      checkpointsConsidered: recentCheckpoints.length,
    },
  };
}

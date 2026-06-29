#!/usr/bin/env node
// Garrison Improver nightly substrate.
//
// Proposal-only by design: reads local telemetry/evidence/docs, writes a
// reviewable markdown artifact plus a JSON run record, and never edits source.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const FITTING_ID = "improver-nightly";
const DEFAULT_NAMESPACE = "improver";
const DEFAULT_STATE_REL = "data/improver";
const META_SUFFIX = ".meta.json";

function usage() {
  return [
    "usage: improver.mjs --probe | run [flags]",
    "",
    "flags:",
    "  --root <dir>              repository root (default: GARRISON_ROOT_DIR or auto)",
    "  --composition-dir <dir>   composition directory (default: GARRISON_COMPOSITION_DIR or auto)",
    "  --state-dir <dir>         run record dir (default: <composition>/data/improver)",
    "  --artifact-root <dir>     artifact root (default: <composition>/artifacts)",
    "  --artifact-cli <path>     artifact-store CLI path",
    "  --namespace <name>        artifact namespace (default: improver)",
    "  --require-vault <bool>    skip if vault appears locked (default: true)",
    "  --artifact-fallback <bool> write artifact-compatible files if CLI unavailable (default: true)",
    "  --json                    print the run record as JSON"
  ].join("\n");
}

function parseArgs(argv) {
  const opts = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      opts.json = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    opts[key] = value;
    i += 1;
  }
  return opts;
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (/^(1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(0|false|no|off)$/i.test(String(value))) return false;
  return defaultValue;
}

function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveDir(value, fallback) {
  return path.resolve(expandTilde(value ?? fallback));
}

function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (fsSync.existsSync(path.join(dir, "package.json")) && fsSync.existsSync(path.join(dir, "docs"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

function inferCompositionDir() {
  if (process.env.GARRISON_COMPOSITION_DIR) {
    return path.resolve(expandTilde(process.env.GARRISON_COMPOSITION_DIR));
  }
  let dir = process.cwd();
  for (let i = 0; i < 5; i += 1) {
    if (fsSync.existsSync(path.join(dir, "apm.yml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function pathStat(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeRunRecord(stateDir, record) {
  const runsDir = path.join(stateDir, "runs");
  await ensureDir(runsDir);
  const file = path.join(runsDir, `${record.id}.json`);
  await fs.writeFile(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  return file;
}

async function vaultLooksLocked(rootDir, compositionDir, requireVault) {
  if (!requireVault) return { locked: false };
  if (process.env.GARRISON_IMPROVER_VAULT_UNLOCKED === "true" || process.env.VAULT_UNLOCKED === "true") {
    return { locked: false };
  }
  const vaultFile = path.join(rootDir, "data", "vault.json");
  if (!(await pathStat(vaultFile))) {
    return { locked: false };
  }
  const envPath = path.join(compositionDir, ".env");
  if (await pathStat(envPath)) {
    return { locked: false };
  }
  return {
    locked: true,
    reason: "vault-locked",
    message: `vault exists at ${path.relative(rootDir, vaultFile)} but ${path.relative(rootDir, envPath)} is not materialized`
  };
}

async function findArtifactCli(rootDir, compositionDir, explicit) {
  const candidates = [
    explicit,
    process.env.GARRISON_ARTIFACT_CLI,
    path.join(compositionDir, "apm_modules", "_local", "documents", "scripts", "artifacts.py"),
    path.join(rootDir, "fittings", "seed", "documents", "scripts", "artifacts.py")
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(expandTilde(candidate));
    if (await pathStat(resolved)) return resolved;
  }
  return null;
}

async function missingServices(rootDir, compositionDir, artifactCli, artifactFallback) {
  const missing = [];
  if (!(await pathStat(path.join(rootDir, "docs")))) missing.push("docs-root");
  if (!(await pathStat(path.join(rootDir, "docs", "GARRISON_ROADMAP.md")))) missing.push("roadmap-doc");
  if (!artifactCli && !artifactFallback) missing.push("artifact-store-cli");
  if (!(await pathStat(compositionDir))) missing.push("composition-dir");
  return missing;
}

async function safeReadText(file, maxBytes = 64 * 1024) {
  try {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function firstHeadings(text, limit = 8) {
  return text
    .split(/\r?\n/)
    .filter((line) => /^#{1,3}\s+/.test(line))
    .slice(0, limit);
}

function interestingLines(text, limit = 8) {
  return text
    .split(/\r?\n/)
    .filter((line) => /\b(TODO|FIXME|open question|risk|blocked|deferred|pending)\b/i.test(line))
    .slice(0, limit);
}

async function summarizeDoc(rootDir, rel) {
  const file = path.join(rootDir, rel);
  const stat = await pathStat(file);
  if (!stat?.isFile()) {
    return { path: rel, exists: false };
  }
  const text = await safeReadText(file);
  return {
    path: rel,
    exists: true,
    bytes: stat.size,
    updated: stat.mtime.toISOString(),
    headings: firstHeadings(text),
    signals: interestingLines(text)
  };
}

async function listFiles(dir, { recursive = false, limit = 20 } = {}) {
  const out = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(full);
        continue;
      }
      const stat = await pathStat(full);
      if (!stat?.isFile()) continue;
      out.push({ path: full, bytes: stat.size, updated: stat.mtime.toISOString() });
    }
  }
  await walk(dir);
  return out.sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, limit);
}

function redactLine(line) {
  return line
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)[^\s]+/gi, "$1[redacted]")
    .slice(0, 240);
}

async function tailLines(file, limit = 3) {
  const text = await safeReadText(file, 16 * 1024);
  const lines = text.trim().split(/\r?\n/).filter(Boolean).slice(-limit);
  return lines.map(redactLine);
}

async function collectInputs(rootDir, compositionDir) {
  const docs = await Promise.all([
    "docs/GARRISON_ROADMAP.md",
    "docs/DECISIONS.md",
    "docs/CLAUDE_CONFIG_PLANE_HANDOFF.md",
    "docs/FLOW_PLAN.md",
    "CLAUDE.md"
  ].map((rel) => summarizeDoc(rootDir, rel)));

  const evidenceIndex = await summarizeDoc(rootDir, "docs/autothing/evidence-index.json");
  const evidenceFiles = (await listFiles(path.join(rootDir, "docs", "autothing", "evidence"), { limit: 12 }))
    .map((f) => ({ ...f, path: path.relative(rootDir, f.path) }));
  const gateFiles = (await listFiles(path.join(rootDir, "docs", "autothing", "slices"), { recursive: true, limit: 12 }))
    .filter((f) => f.path.endsWith("gate-status.json"))
    .map((f) => ({ ...f, path: path.relative(rootDir, f.path) }));

  const telemetryCandidates = [
    path.join(rootDir, "logs"),
    path.join(compositionDir, "logs"),
    path.join(rootDir, ".playwright-cli"),
    path.join(rootDir, "data")
  ];
  const telemetry = [];
  for (const dir of telemetryCandidates) {
    const files = await listFiles(dir, { recursive: false, limit: 8 });
    for (const file of files) {
      if (!/\.(log|json|txt)$/.test(file.path) && !file.path.endsWith("scheduler.log")) continue;
      telemetry.push({
        path: path.relative(rootDir, file.path),
        bytes: file.bytes,
        updated: file.updated,
        tail: await tailLines(file.path)
      });
    }
  }
  telemetry.sort((a, b) => b.updated.localeCompare(a.updated));

  return {
    docs,
    evidence: {
      index: evidenceIndex,
      recentFiles: evidenceFiles,
      gateStatusFiles: gateFiles
    },
    telemetry: telemetry.slice(0, 12)
  };
}

function bulletList(items, render) {
  if (!items.length) return "- None found.";
  return items.map(render).join("\n");
}

function renderProposal(record, inputs) {
  const docSignals = inputs.docs.flatMap((doc) =>
    (doc.signals ?? []).map((line) => ({ path: doc.path, line }))
  );
  const headings = inputs.docs.flatMap((doc) =>
    (doc.headings ?? []).slice(0, 3).map((line) => ({ path: doc.path, line }))
  );

  return [
    `# Improver Proposal ${record.startedAt.slice(0, 10)}`,
    "",
    `Run: \`${record.id}\``,
    "Autonomy: manual/proposal-only",
    "Applied changes: none",
    "",
    "## Inputs Read",
    "",
    bulletList(inputs.docs, (doc) =>
      `- ${doc.path}: ${doc.exists ? `${doc.bytes} bytes, updated ${doc.updated}` : "missing"}`
    ),
    "",
    "## Evidence Snapshot",
    "",
    `- Evidence index: ${inputs.evidence.index.exists ? `${inputs.evidence.index.bytes} bytes, updated ${inputs.evidence.index.updated}` : "missing"}`,
    `- Recent evidence files: ${inputs.evidence.recentFiles.length}`,
    `- Gate status files sampled: ${inputs.evidence.gateStatusFiles.length}`,
    "",
    "## Telemetry Snapshot",
    "",
    bulletList(inputs.telemetry.slice(0, 8), (item) =>
      `- ${item.path}: ${item.bytes} bytes, updated ${item.updated}${item.tail.length ? `; tail: ${item.tail.join(" | ")}` : ""}`
    ),
    "",
    "## Signals",
    "",
    bulletList(docSignals.slice(0, 12), (item) => `- ${item.path}: ${item.line}`),
    "",
    "## Proposal Queue",
    "",
    "- Review the signals above and decide whether any should become a human-approved task.",
    "- If evidence files are stale relative to roadmap claims, request a fresh verification pass before changing code.",
    "- If telemetry shows recurring failures, create a narrow follow-up with the failing log path and expected behavior.",
    "- Keep any follow-up manual until its acceptance criteria and rollback path are explicit.",
    "",
    "## Context Headings Sample",
    "",
    bulletList(headings.slice(0, 12), (item) => `- ${item.path}: ${item.line}`),
    "",
    "## Review Contract",
    "",
    "This artifact is a proposal queue item. It is safe to discard. It does not authorize automated source edits, dependency changes, or Quarters primitive changes.",
    ""
  ].join("\n");
}

function nowIso() {
  return new Date().toISOString();
}

function isoForSidecar() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function writeWithArtifactCli(cli, artifactRoot, namespace, filename, title, markdown) {
  return new Promise((resolve) => {
    const child = spawn("python3", [
      cli,
      "--root",
      artifactRoot,
      "write",
      namespace,
      filename,
      "--title",
      title,
      "--mime",
      "text/markdown",
      "--producer",
      FITTING_ID
    ], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (code === 0) {
        const id = stdout.trim().split(/\r?\n/).pop();
        resolve({ ok: true, id });
      } else {
        resolve({ ok: false, error: stderr.trim() || `artifact cli exited ${code}` });
      }
    });
    child.stdin.end(markdown);
  });
}

async function writeFallbackArtifact(artifactRoot, namespace, filename, title, markdown) {
  const id = randomUUID().replace(/-/g, "");
  const nsDir = path.join(artifactRoot, namespace);
  await ensureDir(nsDir);
  const artifactPath = path.join(nsDir, filename);
  const sidecarPath = `${artifactPath}${META_SUFFIX}`;
  const ts = isoForSidecar();
  await fs.writeFile(artifactPath, markdown, "utf8");
  await fs.writeFile(sidecarPath, JSON.stringify({
    id,
    filename,
    namespace,
    producer: FITTING_ID,
    title,
    mime: "text/markdown",
    created: ts,
    updated: ts
  }, null, 2) + "\n", "utf8");
  return { id, artifactPath, sidecarPath };
}

async function writeProposal({ artifactCli, artifactFallback, artifactRoot, namespace, filename, title, markdown }) {
  if (artifactCli) {
    const result = await writeWithArtifactCli(artifactCli, artifactRoot, namespace, filename, title, markdown);
    if (result.ok) {
      const filePath = path.join(artifactRoot, namespace, filename);
      return {
        // The artifact-store view was dropped 2026-06-26; reference the proposal by
        // its real filesystem location (openable via the File Browser / directly),
        // not a garrison:// link to a Fitting that no longer exists.
        mode: "documents-store",
        id: result.id,
        uri: `file://${filePath}`,
        path: filePath
      };
    }
    if (!artifactFallback) {
      throw new Error(`artifact-store CLI failed: ${result.error}`);
    }
  }
  if (!artifactFallback) {
    throw new Error("artifact-store CLI unavailable and fallback disabled");
  }
  const fallback = await writeFallbackArtifact(artifactRoot, namespace, filename, title, markdown);
  return {
    mode: "artifact-compatible-fallback",
    id: fallback.id,
    uri: `file://${fallback.artifactPath}`,
    path: fallback.artifactPath
  };
}

async function skipped({ id, stateDir, startedAt, reason, message, services = [] }) {
  const endedAt = nowIso();
  const record = {
    id,
    fittingId: FITTING_ID,
    status: "skipped",
    reason,
    message,
    missingServices: services,
    startedAt,
    endedAt
  };
  record.recordPath = await writeRunRecord(stateDir, record);
  return record;
}

async function run(opts) {
  const startedAt = nowIso();
  const id = `${timestampId(new Date(startedAt))}-${randomUUID().slice(0, 8)}`;
  const compositionDir = resolveDir(opts.compositionDir, inferCompositionDir());
  const rootDir = resolveDir(opts.root, process.env.GARRISON_ROOT_DIR ?? findRepoRoot(path.join(compositionDir, "..", "..")));
  const stateDir = resolveDir(opts.stateDir ?? process.env.GARRISON_IMPROVER_STATE_DIR, path.join(compositionDir, DEFAULT_STATE_REL));
  const artifactRoot = resolveDir(opts.artifactRoot ?? process.env.GARRISON_ARTIFACTS_ROOT, path.join(compositionDir, "artifacts"));
  const namespace = opts.namespace ?? process.env.GARRISON_IMPROVER_NAMESPACE ?? DEFAULT_NAMESPACE;
  const requireVault = parseBool(opts.requireVault ?? process.env.GARRISON_IMPROVER_REQUIRE_VAULT, true);
  const artifactFallback = parseBool(opts.artifactFallback ?? process.env.GARRISON_IMPROVER_ARTIFACT_FALLBACK, true);

  const vault = await vaultLooksLocked(rootDir, compositionDir, requireVault);
  if (vault.locked) {
    return skipped({ id, stateDir, startedAt, reason: vault.reason, message: vault.message });
  }

  const artifactCli = await findArtifactCli(rootDir, compositionDir, opts.artifactCli);
  const missing = await missingServices(rootDir, compositionDir, artifactCli, artifactFallback);
  if (missing.length > 0) {
    return skipped({
      id,
      stateDir,
      startedAt,
      reason: "missing-services",
      message: `missing required local service(s): ${missing.join(", ")}`,
      services: missing
    });
  }

  const inputs = await collectInputs(rootDir, compositionDir);
  const filename = `${id}-proposal.md`;
  const title = `Improver proposal ${id}`;
  const baseRecord = {
    id,
    fittingId: FITTING_ID,
    status: "completed",
    startedAt,
    endedAt: "",
    rootDir,
    compositionDir,
    autonomy: "manual",
    inputs: {
      docs: inputs.docs.filter((doc) => doc.exists).map((doc) => doc.path),
      evidenceFiles: inputs.evidence.recentFiles.length,
      telemetryFiles: inputs.telemetry.length
    }
  };
  const markdown = renderProposal(baseRecord, inputs);
  const artifact = await writeProposal({
    artifactCli,
    artifactFallback,
    artifactRoot,
    namespace,
    filename,
    title,
    markdown
  });
  const record = {
    ...baseRecord,
    endedAt: nowIso(),
    artifact,
    proposal: {
      namespace,
      filename,
      title
    }
  };
  record.recordPath = await writeRunRecord(stateDir, record);
  return record;
}

async function main(argv) {
  if (argv[0] === "--probe") {
    console.log("ok");
    return 0;
  }

  const opts = parseArgs(argv);
  if (opts.command !== "run") {
    console.error(usage());
    return 2;
  }

  const record = await run(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(record, null, 2) + "\n");
  } else if (record.status === "skipped") {
    console.log(`skipped ${record.id}: ${record.reason} (${record.message})`);
    console.log(`record ${record.recordPath}`);
  } else {
    console.log(`completed ${record.id}: ${record.artifact.uri}`);
    console.log(`record ${record.recordPath}`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  }
);

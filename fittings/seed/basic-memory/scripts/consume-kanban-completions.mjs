#!/usr/bin/env node
// Consume neutral personal-card completion packets written by Kanban.
//
// This is intentionally deterministic source capture, not LLM distillation:
// user-authored card text stays explicitly unverified, agent closeout fields
// stay labelled as bounded run summaries, and nothing is promoted to timeless
// product truth. Local mode writes a canonical source note under
// Personal/Kanban Completions. Cortex mode uses the same remote capability CLI
// and permalink mapping as the existing spool/import path. Shadow mode writes
// both and reports partial/pending state honestly.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import {
  permalinkForRelPath,
  resolveRemoteCli,
  resolveRemoteFolder,
  runCli
} from "./lib/memory-vault.mjs";

const PREFIX = "[basic-memory] kanban completions:";
const PACKET_KIND = "garrison.personal-card-completion";
const CARD_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PACKET_FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26}-g\d+)\.json$/;
const NOTE_FOLDER = path.join("Personal", "Kanban Completions");
const MAX_PACKET_BYTES = 256 * 1024;

const log = (message) => console.log(`${PREFIX} ${message}`);

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function garrisonHome(env = process.env) {
  return (env.GARRISON_HOME || "").trim() || path.join(os.homedir(), ".garrison");
}

export function kanbanRoot(env = process.env) {
  return (env.GARRISON_KANBAN_DIR || "").trim() || path.join(garrisonHome(env), "kanban-loop");
}

export function completionOutboxPaths(root) {
  const base = path.join(root, "memory-outbox", "personal-completions");
  return {
    base,
    packets: path.join(base, "packets"),
    status: path.join(base, "status")
  };
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function oneLine(value, max = 240) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function quoteBlock(value) {
  const text = String(value ?? "").trim();
  if (!text) return ["_(none recorded)_"];
  // Indented code is inert Markdown: source text cannot smuggle a heading,
  // frontmatter fence, HTML block, or a fake provenance row into this note.
  return text.split(/\r?\n/).map((line) => `    ${line || " "}`);
}

function markdownInline(value, max = 500) {
  return oneLine(value, max).replace(/([\\`*_[\]<>])/g, "\\$1");
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function validPacket(packet, expectedId) {
  if (!packet || packet.schemaVersion !== 1 || packet.kind !== PACKET_KIND || packet.scope !== "personal") return false;
  if (!CARD_ID_RE.test(packet.cardId || "")) return false;
  if (!Number.isSafeInteger(packet.coordinationSeq) || packet.coordinationSeq < 0) return false;
  const identity = `${packet.cardId}-g${packet.coordinationSeq}`;
  return packet.packetId === expectedId && packet.packetId === identity;
}

export function noteRelativePath(packet) {
  if (!validPacket(packet, packet?.packetId)) throw new Error("invalid personal completion packet identity");
  return path.join(NOTE_FOLDER, `kanban-${packet.cardId}-g${packet.coordinationSeq}.md`);
}

export function renderPersonalCompletionNote(packet, sourceSha256) {
  const title = oneLine(packet.title || "(untitled)", 240);
  const checklist = Array.isArray(packet.checklist) ? packet.checklist : [];
  const closeout = packet.agentCloseout && typeof packet.agentCloseout === "object"
    ? packet.agentCloseout
    : null;
  const lines = [
    "---",
    `title: ${yamlString(`Personal task completed - ${title}`)}`,
    "type: note",
    "tags: [personal, kanban, completion-source]",
    `source_kind: ${yamlString(PACKET_KIND)}`,
    `source_packet_id: ${yamlString(packet.packetId)}`,
    `source_packet_sha256: ${yamlString(sourceSha256)}`,
    `card_id: ${yamlString(packet.cardId)}`,
    `coordination_seq: ${packet.coordinationSeq}`,
    `completed_at: ${yamlString(packet.completedAt || "unknown")}`,
    "truth_status: source-record-not-promoted-fact",
    "---",
    "",
    "# Personal task completion source",
    "",
    "> This note is a deterministic completion source record, not a promoted memory.",
    "> The description, checklist, and manual completion note are user-authored and unverified.",
    "> Agent closeout fields are bounded run summaries/evidence references, not independently verified product facts.",
    "",
    "## Provenance",
    "",
    `- **Card**: \`${packet.cardId}\``,
    `- **Done generation**: \`${packet.coordinationSeq}\``,
    `- **Completed at**: ${markdownInline(packet.completedAt || "unknown", 100)}`,
    `- **Project label**: ${packet.project ? markdownInline(packet.project, 160) : "_(none)_"}`,
    `- **Work kind**: ${packet.workKind ? markdownInline(packet.workKind, 120) : "_(none)_"}`,
    `- **Source packet**: \`${packet.packetId}\``,
    `- **Source SHA-256**: \`${sourceSha256}\``,
    "- **Capture semantics**: completion event only; no statement below is promoted to timeless truth",
    "",
    "## Card title",
    "",
    ...quoteBlock(title),
    "",
    "## User-authored description (unverified)",
    "",
    ...quoteBlock(packet.description),
    "",
    "## User-authored checklist (unverified)",
    ""
  ];

  if (checklist.length === 0) lines.push("_No checklist was recorded._");
  else {
    for (const item of checklist) {
      lines.push(`- [${item?.done === true ? "x" : " "}] ${markdownInline(item?.text, 500)}`);
    }
  }

  lines.push(
    "",
    "## Manual completion note (unverified)",
    "",
    ...quoteBlock(packet.manualCompletionNote),
    "",
    "## Agent closeout (bounded; not independently verified)",
    ""
  );

  if (!closeout) {
    lines.push("_No agent closeout was recorded for this completion._");
  } else {
    lines.push("### Summary", "", ...quoteBlock(closeout.summary));
    const decisions = Array.isArray(closeout.decisions) ? closeout.decisions : [];
    lines.push("", "### Decisions reported by the run", "");
    if (decisions.length === 0) lines.push("_None recorded._");
    else for (const decision of decisions) lines.push(`- ${markdownInline(decision, 500)}`);

    const evidence = Array.isArray(closeout.evidence) ? closeout.evidence : [];
    lines.push("", "### Evidence references", "");
    if (evidence.length === 0) lines.push("_None recorded._");
    else {
      for (const item of evidence) {
        lines.push(`- **Reference**: ${markdownInline(item?.ref, 500)}${item?.description ? ` - ${markdownInline(item.description, 500)}` : ""}`);
      }
    }
  }

  lines.push(
    "",
    "## Deliberately omitted",
    "",
    "- Transcripts and session identifiers",
    "- Operative logs and diffs",
    "- Environment/configuration values",
    "- Attachment bodies",
    ""
  );
  return lines.join("\n");
}

function readStatus(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function noteIdentityMatches(file, packetId, sourceHash) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.includes(`source_packet_id: ${yamlString(packetId)}`) &&
      text.includes(`source_packet_sha256: ${yamlString(sourceHash)}`);
  } catch {
    return false;
  }
}

function atomicCreateText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function writeLocalNote({ packet, note, sourceHash, env }) {
  const vault = (env.BASIC_MEMORY_VAULT_DIR || "").trim() || path.join(os.homedir(), "ObsidianVault");
  if (!fs.existsSync(vault)) {
    return { state: "pending", reason: `vault directory is missing: ${vault}` };
  }
  const relPath = noteRelativePath(packet);
  const file = path.join(vault, relPath);
  try {
    const created = atomicCreateText(file, note);
    if (!created && !noteIdentityMatches(file, packet.packetId, sourceHash)) {
      return { state: "conflict", reason: "deterministic note path already contains a different source packet", relPath };
    }
    return { state: "captured", relPath, created };
  } catch (err) {
    return { state: "pending", reason: oneLine(err?.message || err, 300), relPath };
  }
}

function writeRemoteNote({ packet, note, env }) {
  const resolvedFolder = resolveRemoteFolder((env.BASIC_MEMORY_REMOTE_FOLDER || "").trim() || "vault");
  if (!resolvedFolder) return { state: "pending", reason: "remote folder does not produce a valid permalink" };
  const relPath = noteRelativePath(packet);
  const permalink = permalinkForRelPath(relPath, resolvedFolder.folder);
  const explicitBin = String(env.REMOTE_MEMORY_CLI_BIN || env.BASIC_MEMORY_REMOTE_CLI_BIN || "").trim();
  const cli = explicitBin ? { bin: explicitBin, source: "env" } : resolveRemoteCli();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-kanban-memory-"));
  const file = path.join(tempDir, "note.md");
  try {
    fs.writeFileSync(file, note, { encoding: "utf8", mode: 0o600 });
    const result = runCli(cli.bin, ["memory", "write", "--file", file, "--permalink", permalink, "--json"]);
    if (result.enoent) return { state: "pending", reason: `remote memory CLI is not installed (${cli.bin})`, permalink };
    if (result.timedOut || result.status !== 0) {
      return { state: "pending", reason: `remote memory write failed: ${oneLine(result.why, 180)}`, permalink };
    }
    return { state: "captured", permalink };
  } catch (err) {
    return { state: "pending", reason: oneLine(err?.message || err, 300), permalink };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function backendConfig(env) {
  const raw = String(env.BASIC_MEMORY_BACKEND || "local").trim().toLowerCase();
  const backend = raw === "cortex" ? "cortex" : "local";
  const shadow = truthy(env.BASIC_MEMORY_SHADOW_WRITE);
  return {
    backend,
    shadow,
    // Shadow adds the other destination; it never replaces the selected one.
    // Keep local capture alive even if an operator temporarily combines the
    // cortex backend with shadow during a migration/review.
    wantLocal: backend === "local" || shadow,
    wantRemote: backend === "cortex" || shadow
  };
}

function capturedForSameSource(record, sourceHash) {
  return record?.state === "captured" && record?.sourceSha256 === sourceHash;
}

export function consumePacketFile(file, { root = kanbanRoot(), env = process.env, now = () => new Date().toISOString() } = {}) {
  const match = PACKET_FILE_RE.exec(path.basename(file));
  if (!match) return { state: "invalid", reason: "invalid packet filename" };
  const packetId = match[1];
  let raw;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_PACKET_BYTES) {
      return { state: "invalid", packetId, reason: `packet exceeds ${MAX_PACKET_BYTES} bytes or is not a file` };
    }
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { state: "invalid", packetId, reason: oneLine(err?.message || err, 300) };
  }

  let packet;
  try { packet = JSON.parse(raw); }
  catch { return { state: "invalid", packetId, reason: "packet is not valid JSON" }; }
  if (!validPacket(packet, packetId)) {
    return { state: "invalid", packetId, reason: "packet schema, identity, or personal scope is invalid" };
  }

  const sourceHash = sha256(raw);
  const paths = completionOutboxPaths(root);
  const statusFile = path.join(paths.status, `${packetId}.json`);
  const prior = readStatus(statusFile) || {};
  const config = backendConfig(env);
  const note = renderPersonalCompletionNote(packet, sourceHash);
  const destinations = { ...(prior.destinations && typeof prior.destinations === "object" ? prior.destinations : {}) };

  if (config.wantLocal && !capturedForSameSource(destinations.local, sourceHash)) {
    destinations.local = { ...writeLocalNote({ packet, note, sourceHash, env }), sourceSha256: sourceHash };
  }
  if (config.wantRemote && !capturedForSameSource(destinations.remote, sourceHash)) {
    destinations.remote = { ...writeRemoteNote({ packet, note, env }), sourceSha256: sourceHash };
  }

  const desired = [
    ...(config.wantLocal ? [destinations.local] : []),
    ...(config.wantRemote ? [destinations.remote] : [])
  ];
  const captured = desired.length > 0 && desired.every((item) => item?.state === "captured");
  const hardConflict = desired.some((item) => item?.state === "conflict");
  const state = captured ? "captured" : hardConflict ? "conflict" : "pending";
  const status = {
    schemaVersion: 1,
    packetId,
    cardId: packet.cardId,
    coordinationSeq: packet.coordinationSeq,
    state,
    sourceSha256: sourceHash,
    backend: config.backend,
    shadow: config.shadow,
    attempts: (Number.isSafeInteger(prior.attempts) ? prior.attempts : 0) + 1,
    lastAttemptAt: now(),
    destinations
  };
  atomicWriteJson(statusFile, status);
  return status;
}

export function consumePersonalCompletionOutbox({ root = kanbanRoot(), env = process.env, now } = {}) {
  const paths = completionOutboxPaths(root);
  let names = [];
  try {
    names = fs.readdirSync(paths.packets).filter((name) => PACKET_FILE_RE.test(name)).sort();
  } catch {
    return { scanned: 0, captured: 0, pending: 0, conflict: 0, invalid: 0, results: [] };
  }

  const results = [];
  for (const name of names) {
    results.push(consumePacketFile(path.join(paths.packets, name), { root, env, ...(now ? { now } : {}) }));
  }
  return {
    scanned: results.length,
    captured: results.filter((item) => item.state === "captured").length,
    pending: results.filter((item) => item.state === "pending").length,
    conflict: results.filter((item) => item.state === "conflict").length,
    invalid: results.filter((item) => item.state === "invalid").length,
    results
  };
}

async function main() {
  const result = consumePersonalCompletionOutbox();
  log(`scanned=${result.scanned} captured=${result.captured} pending=${result.pending} conflict=${result.conflict} invalid=${result.invalid}`);
  for (const item of result.results) {
    if (item.state === "pending") {
      const reasons = Object.values(item.destinations || {})
        .filter((destination) => destination?.state !== "captured" && destination?.reason)
        .map((destination) => destination.reason);
      log(`${item.packetId} remains pending${reasons.length ? ` (${reasons.join("; ")})` : ""}`);
    } else if (item.state === "conflict" || item.state === "invalid") {
      log(`${item.packetId || "unknown packet"}: ${item.state} (${item.reason || "destination conflict"})`);
    }
  }
  return result.conflict || result.invalid ? 1 : 0;
}

const isDirect = (() => {
  try {
    return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || "");
  } catch {
    return false;
  }
})();

if (isDirect) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`${PREFIX} unexpected error: ${oneLine(err?.message || err, 300)}`);
      process.exit(1);
    });
}

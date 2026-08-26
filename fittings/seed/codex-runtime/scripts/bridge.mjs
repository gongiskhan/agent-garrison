#!/usr/bin/env node
// codex-runtime bridge — the uniform runtime-bridge entrypoint (BRIEF v4).
// Exposes delegate(task_spec) -> {summary, artifacts} for Codex-as-secondary.
//
// Usage:
//   bridge.mjs --probe                # health check, prints "ok"
//   echo '<task_spec_json>' | bridge.mjs delegate   # task spec via STDIN (never argv)
//   ... [--conversation <id> [--stretch <id>] [--brief-ref <ref>]]
//                                     # additionally record the delegation in
//                                     # the conversation ledger (L3)
//
// The task spec is read from STDIN (or --spec-file <path>) — NEVER interpolated
// into argv (shell-injection guard under bypassPermissions). Full output goes to
// the Artifact Store; the delegation is appended to decisions.jsonl; the return
// is a schema-validated {summary, artifacts}.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { delegate, parseTaskSpec, acquireCodexLock, releaseCodexLock, openConversation, CODEX_LOCK_FILE } from "@garrison/claude-pty";
import { CodexAdapter } from "../lib/codex-adapter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CODEX_RUNTIME_DATA || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "codex-runtime");
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
const MODEL_ALLOWLIST = /^(gpt-5|o[34]|codex|gpt-4)/i;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Write full output to the Artifact Store. Prefers the documents fitting's
// artifacts.py write CLI when present (ARTIFACTS_CLI); falls back to a local file.
async function writeArtifact(ns, name, content) {
  const cli = process.env.ARTIFACTS_CLI;
  if (cli && existsSync(cli)) {
    const r = spawnSync("python3", [cli, "write", "--namespace", ns, "--name", name], { input: content, encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      try {
        return JSON.parse(r.stdout).path || `${ns}/${name}`;
      } catch {
        /* fall through to local */
      }
    }
  }
  mkdirSync(path.join(ARTIFACTS_DIR, ns), { recursive: true });
  const p = path.join(ARTIFACTS_DIR, ns, name);
  writeFileSync(p, content, "utf8");
  return p;
}

async function logDecision(rec) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(DECISIONS, JSON.stringify(rec) + "\n", "utf8");
}

// ── run-wide Codex serialization (GARRISON-UNIFY-V1 D14) ────────────────────
// Codex's shared OAuth/API token is revoked by CONCURRENT `codex` processes, so
// the one-call-at-a-time constraint is machine-wide — callers (skills, the
// checkpoint, per-slice passes) no longer serialize themselves. The mutex now
// lives in `@garrison/claude-pty` (codex-lock.mjs) rather than in this fitting,
// because the GATEWAY's codex lane spawns `codex` too and has to take the SAME
// lock; a bridge-only copy left that lane free to run a second codex process.
// Semantics, path and tunables are unchanged — this bridge is still one of the
// two callers, and re-exports the primitives for the regression suite.


async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--probe")) {
    const v = spawnSync("codex", ["--version"], { encoding: "utf8" });
    if (v.status !== 0) {
      console.error("codex CLI not found on PATH");
      process.exit(1);
    }
    console.log("ok");
    return;
  }

  const specFileIdx = argv.indexOf("--spec-file");
  const raw = specFileIdx >= 0 ? readFileSync(argv[specFileIdx + 1], "utf8") : readStdin();
  if (!raw.trim()) {
    console.error("no task spec on stdin (or --spec-file)");
    process.exit(2);
  }
  const spec = parseTaskSpec(raw);
  const adapter = new CodexAdapter();
  // A delegation that belongs to a conversation writes its dispatched/returned/
  // failed events into that conversation's ledger and copies the raw output into
  // its payloads dir (L3 stays one greppable directory). Absent the flag the
  // bridge behaves exactly as before: no store is opened, no event is emitted.
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const conversationId = flag("--conversation");
  const store = conversationId ? openConversation(conversationId, { role: "codex-bridge" }) : null;
  // D14: one Codex call at a time, machine-wide (the lock is shared with the
  // gateway's codex lane — @garrison/claude-pty/codex-lock.mjs).
  await acquireCodexLock();
  try {
    const result = await delegate(spec, {
      adapter,
      spawnConfig: { compositionDir: spec.cwd || process.cwd(), model: spec.model, env: process.env },
      writeArtifact,
      logDecision,
      secrets: process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {},
      now: () => new Date().toISOString(),
      ...(store
        ? {
            recordEvent: (evt) => store.append(evt),
            writePayloadCopy: (name, content) => store.writeNamedPayload(name, content)
          }
        : {})
    }, {
      modelAllowlist: MODEL_ALLOWLIST,
      ...(conversationId ? { conversationId } : {}),
      ...(flag("--stretch") ? { stretchId: flag("--stretch") } : {}),
      ...(flag("--brief-ref") ? { briefRef: flag("--brief-ref") } : {})
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.code || "error", message: err?.message }) + "\n");
    process.exitCode = 1;
  } finally {
    releaseCodexLock();
  }
}

// Serialization primitives are re-exported for the regression suite (they now
// live in @garrison/claude-pty, shared with the gateway's codex lane); the CLI
// still runs main() when invoked directly, not when imported.
export { acquireCodexLock, releaseCodexLock };
export { CODEX_LOCK_FILE as LOCK_FILE };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

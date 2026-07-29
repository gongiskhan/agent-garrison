#!/usr/bin/env node
// cursor-runtime bridge — the uniform runtime-bridge entrypoint (BRIEF v4).
// Exposes delegate(task_spec) -> {summary, artifacts} for Cursor-as-secondary.
//
// Usage:
//   bridge.mjs --probe                # health check, prints "ok"
//   echo '<task_spec_json>' | bridge.mjs delegate   # task spec via STDIN (never argv)
//
// Per turn the bridge runs a stateless `cursor-agent -p --output-format json`
// subprocess with the prompt on STDIN (never argv → shell-injection safe under
// bypassPermissions), captures the minted Cursor chat id for `--resume`, and returns
// a schema-validated {summary, artifacts}. Like OpenCode and unlike Codex there is
// NO shared-token revocation, so NO machine-wide serialization lock is needed —
// concurrent cursor-agent processes are safe.
//
// Auth is Cursor's OWN native login (`cursor-agent login` → ~/.config/cursor/auth.json)
// or a CURSOR_API_KEY in the environment. There is no Garrison account plane for
// Cursor yet, which is exactly why the probe below checks authentication rather than
// only the binary's presence: a version-only probe passes while logged out and then
// every delegated turn fails.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { delegate, parseTaskSpec } from "@garrison/claude-pty";
import { CursorAdapter } from "../lib/cursor-adapter.mjs";

const DATA_DIR =
  process.env.CURSOR_RUNTIME_DATA ||
  path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "cursor-runtime");
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
const DEFAULT_MODEL = process.env.CURSOR_MODEL || "auto";
// A Cursor model id: a bare slug (auto, gpt-5.3-codex, claude-opus-5-thinking-high)
// optionally followed by the CLI's bracket-override form for its parameterized
// models (claude-opus-4-8[context=1m,effort=high]).
const MODEL_ALLOWLIST = /^[a-z0-9][a-z0-9._-]*(\[[^\]]*\])?$/i;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Write full output to the Artifact Store — prefers the documents fitting's write
// CLI (ARTIFACTS_CLI) when present; falls back to a local file. (Shared shape with
// the codex/gemini/opencode bridges.)
async function writeArtifact(ns, name, content) {
  const cli = process.env.ARTIFACTS_CLI;
  if (cli && existsSync(cli)) {
    const r = spawnSync("python3", [cli, "write", "--namespace", ns, "--name", name], { input: content, encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      try {
        return JSON.parse(r.stdout).path || `${ns}/${name}`;
      } catch {
        /* local fallback */
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

// Health probe, offline-safe (no model turn): the CLI must be on PATH AND print a
// version, and the box must be able to authenticate — either Cursor's native login
// reports authenticated, or a CURSOR_API_KEY is present. Returns null when healthy,
// else the reason, so --probe can fail loudly with the remediation.
export function probeFailure(run = (bin, argv) => spawnSync(bin, argv, { encoding: "utf8" }), env = process.env) {
  const v = run("cursor-agent", ["--version"]);
  const version = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim();
  if (v.status !== 0 || !/\d/.test(version)) {
    return "cursor-agent CLI not found on PATH (or no version string) — install the Cursor CLI (https://cursor.com/cli)";
  }
  // An API key authenticates without any stored login, so it short-circuits.
  if (String(env.CURSOR_API_KEY ?? "").trim()) return null;
  const s = run("cursor-agent", ["status", "--format", "json"]);
  const out = `${s.stdout ?? ""}`.trim();
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    /* fall through to the loud not-authenticated message */
  }
  if (parsed?.isAuthenticated === true) return null;
  const detail = parsed?.status ?? (out.slice(0, 120) || "no status output");
  return `cursor-agent is not authenticated (${detail}) — run \`cursor-agent login\` on this box, or set CURSOR_API_KEY`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--probe")) {
    const failure = probeFailure();
    if (failure) {
      console.error(failure);
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
  const model = spec.model || DEFAULT_MODEL;
  const adapter = new CursorAdapter();

  try {
    const result = await delegate(
      { ...spec, model },
      {
        adapter,
        spawnConfig: {
          compositionDir: spec.cwd || process.cwd(),
          model,
          sessionId: spec.sessionId ?? null,
          // A delegated turn is headless: there is no permission-prompt surface,
          // so it runs on the full-access mapping unless the caller's gateway
          // environment says otherwise (cursorPermissionArgs reads it).
          permissionMode: process.env.GARRISON_PERMISSION_MODE || "auto",
          env: process.env
        },
        writeArtifact,
        logDecision,
        secrets: {},
        now: () => new Date().toISOString()
      },
      { modelAllowlist: MODEL_ALLOWLIST }
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err?.code || "error", message: err?.message }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

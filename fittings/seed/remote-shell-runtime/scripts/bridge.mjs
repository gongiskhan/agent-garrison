#!/usr/bin/env node
// remote-shell bridge — the uniform runtime-bridge entrypoint.
//
//   bridge.mjs --probe                              # health check, prints "ok"
//   echo '<task_spec_json>' | bridge.mjs delegate   # task spec via STDIN
//
// A delegated task is injected into the REMOTE agent's TUI (tmux send-keys via
// the fitting's own-port server) and completes when the remote agent's stop
// hook lands in the events file — the terminal is never scraped for state.
// The task spec's `model` slot names the TRANSPORT (e.g. "csg"), mirroring the
// adapter's routing-target convention.
//
// The probe is OFFLINE-SAFE and configuration-free (Rule 6): it checks local
// prerequisites only. Transport reachability is a runtime concern surfaced by
// the server's /health and the first turn, not a compose-time gate.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { delegate, parseTaskSpec } from "@garrison/claude-pty";
import { RemoteShellAdapter } from "../lib/remote-shell-adapter.mjs";

const DATA_DIR = path.join(
  process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"),
  "remote-shell"
);
const DECISIONS = path.join(DATA_DIR, "decisions.jsonl");
const ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
// Transport names are config keys, not model ids.
const MODEL_ALLOWLIST = /^[a-z0-9][a-z0-9_-]*$/i;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function writeArtifact(ns, name, content) {
  const cli = process.env.ARTIFACTS_CLI;
  if (cli && existsSync(cli)) {
    const r = spawnSync("python3", [cli, "write", "--namespace", ns, "--name", name], { input: content, encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      try {
        return JSON.parse(r.stdout).path || `${ns}/${name}`;
      } catch { /* local fallback */ }
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

export function probeFailure(run = (bin, argv) => spawnSync(bin, argv, { encoding: "utf8" })) {
  const ssh = run("ssh", ["-V"]);
  if (ssh.error || (ssh.status !== 0 && ssh.status !== null && !/OpenSSH/i.test(`${ssh.stdout}${ssh.stderr}`))) {
    return "ssh binary not found on PATH";
  }
  return null;
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
  const transport = spec.model || process.env.GARRISON_REMOTESHELLRUNTIME_DEFAULT_TRANSPORT || "";
  const adapter = new RemoteShellAdapter();

  try {
    const result = await delegate(
      { ...spec, model: transport },
      {
        adapter,
        spawnConfig: { transport, env: process.env },
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

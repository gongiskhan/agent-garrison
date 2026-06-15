#!/usr/bin/env node
// improver.mjs — nightly Improver runner CLI (BRIEF v4 §4).
//   improver.mjs run-now [improver-nightly]   # produce proposals + queue entries
//   improver.mjs --probe
// Needs NO HTTP: reads inputs, writes proposal diffs + a run report, upserts a
// review-queue index JSON. Vault-locked / server-down → records `skipped` (never
// fails silently). Applies happen only through hosted APIs from the review UI.
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runImprover, upsertQueue } from "../lib/improver-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.IMPROVER_DATA || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "improver");
const QUEUE_FILE = path.join(DATA_DIR, "review-queue.json");
const PROPOSALS_DIR = path.join(DATA_DIR, "proposals");
const REPORT_FILE = path.join(DATA_DIR, "last-run.json");

// Parse a MEMORY.md index into {title, hook} entries (shared shape with harvest).
function parseMemory(md) {
  const out = [];
  for (const line of String(md).split("\n")) {
    const m = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:—|-)?\s*(.*)$/);
    if (m) out.push({ title: m[1].trim(), hook: (m[3] || "").trim() });
  }
  return out;
}

function readDecisions(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--probe")) {
    // probe: the core runs on empty inputs without throwing
    runImprover({});
    console.log("ok");
    return;
  }
  if (args[0] !== "run-now") {
    console.error("usage: improver.mjs run-now [improver-nightly] | --probe");
    process.exit(2);
  }

  const memoryPath = process.env.IMPROVER_MEMORY || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".claude", "projects"), "MEMORY.md");
  const decisionsPath = process.env.IMPROVER_DECISIONS || "";
  const vaultLocked = process.env.IMPROVER_VAULT_LOCKED === "1";
  const serverUp = process.env.IMPROVER_SERVER_DOWN !== "1";

  const memoryEntries = existsSync(memoryPath) ? parseMemory(readFileSync(memoryPath, "utf8")) : [];
  const decisions = readDecisions(decisionsPath);
  const at = new Date().toISOString();

  mkdirSync(DATA_DIR, { recursive: true });
  const result = runImprover({ decisions, memoryEntries, vaultLocked, serverUp, at });

  if (result.skipped) {
    writeFileSync(REPORT_FILE, JSON.stringify({ at, skipped: result.skipped }, null, 2), "utf8");
    appendFileSync(path.join(DATA_DIR, "runs.log"), `${at} skipped: ${result.skipped}\n`, "utf8");
    console.log(JSON.stringify({ skipped: result.skipped }));
    return;
  }

  // write proposal diffs + upsert the review queue
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  let queue = loadQueue();
  for (const p of result.proposals) {
    writeFileSync(path.join(PROPOSALS_DIR, `${p.id}.json`), JSON.stringify(p, null, 2), "utf8");
    queue = upsertQueue(queue, p);
  }
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf8");
  writeFileSync(REPORT_FILE, JSON.stringify(result.report, null, 2), "utf8");
  console.log(JSON.stringify({ proposals: result.proposals.length, queue: queue.length }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { parseMemory };

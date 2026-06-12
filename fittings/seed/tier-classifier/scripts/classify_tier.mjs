#!/usr/bin/env node
// Garrison tier-classifier script.
//
// Usage:
//   node classify_tier.mjs --probe           # health check, prints "ok"
//   echo '{"prompt":"refactor the app"}' | node classify_tier.mjs
//
// Output: { "tier": N, "reason": "..." }
//
// Talks to the model through @garrison/claude-pty (interactive Claude Code TUI
// driven via node-pty), one-shot — the same substrate as the gateway. No Agent
// SDK.
//
// Environment:
//   GARRISON_TIER_FLOOR       minimum tier (default 3)
//   GARRISON_PLAN_THRESHOLD   tier that triggers plan-before-execute (default 3)
//   GARRISON_TIER_MODEL       model to classify with (default haiku)

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FITTING_DIR = path.resolve(__dirname, "..");

const SKILL_MD_PATH = path.join(FITTING_DIR, ".apm", "skills", "tier-classifier", "SKILL.md");

const TIER_FLOOR = Number(process.env.GARRISON_TIER_FLOOR ?? "3");
const PLAN_THRESHOLD = Number(process.env.GARRISON_PLAN_THRESHOLD ?? "3");
const TIER_MODEL = process.env.GARRISON_TIER_MODEL ?? "haiku";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadOneShot() {
  // Dynamic import so --probe doesn't hard-fail if the package isn't linked.
  try {
    const mod = await import("@garrison/claude-pty");
    return mod.oneShotTurn;
  } catch {
    return null;
  }
}

async function classify(prompt) {
  if (!existsSync(SKILL_MD_PATH)) {
    throw new Error(`SKILL.md not found at ${SKILL_MD_PATH}`);
  }
  const skillMd = readFileSync(SKILL_MD_PATH, "utf8");

  const oneShotTurn = await loadOneShot();
  if (!oneShotTurn) {
    throw new Error("@garrison/claude-pty not found — run setup first");
  }

  const systemPrompt = [
    skillMd.trim(),
    "",
    `Config: tier_floor=${TIER_FLOOR}, plan_threshold=${PLAN_THRESHOLD}.`,
    "",
    "Respond with ONLY valid JSON on one line, no markdown fences:",
    '{"tier": <integer 1-7>, "reason": "<one sentence>"}',
  ].join("\n");

  const promptDir = mkdtempSync(path.join(tmpdir(), "garrison-tier-"));
  const promptFile = path.join(promptDir, "system-prompt.md");
  writeFileSync(promptFile, systemPrompt, "utf8");

  const { reply } = await oneShotTurn({
    cwd: promptDir,
    appendSystemPromptFile: promptFile,
    model: TIER_MODEL,
    permissionMode: "bypassPermissions",
    message: `Classify this prompt:\n\n${prompt}`,
    timeoutMs: 90_000,
  });

  const jsonMatch = reply.match(/\{[^}]*"tier"\s*:\s*\d+[^}]*\}/);
  if (!jsonMatch) {
    throw new Error(`could not parse tier JSON from model output: ${reply.slice(0, 200)}`);
  }
  const parsed = JSON.parse(jsonMatch[0]);
  const tier = Math.max(TIER_FLOOR, Math.min(7, Number(parsed.tier)));
  return { tier, reason: parsed.reason ?? "" };
}

async function main(argv) {
  if (argv[0] === "--probe") {
    if (!existsSync(SKILL_MD_PATH)) {
      process.stderr.write(`classify_tier: SKILL.md not found at ${SKILL_MD_PATH}\n`);
      return 1;
    }
    const f = await loadOneShot();
    if (!f) {
      process.stderr.write("classify_tier: @garrison/claude-pty not installed\n");
      return 1;
    }
    process.stdout.write("ok\n");
    return 0;
  }

  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`classify_tier: invalid JSON input: ${err.message}\n`);
    return 1;
  }

  if (!input.prompt || typeof input.prompt !== "string") {
    process.stderr.write("classify_tier: input.prompt (string) is required\n");
    return 1;
  }

  try {
    const result = await classify(input.prompt);
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`classify_tier: ${err.message}\n`);
    return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`classify_tier: ${err.message}\n`);
    process.exit(1);
  });

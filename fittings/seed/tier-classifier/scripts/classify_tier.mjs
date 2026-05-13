#!/usr/bin/env node
// Garrison tier-classifier script.
//
// Usage:
//   node classify_tier.mjs --probe           # health check, prints "ok"
//   echo '{"prompt":"refactor the app"}' | node classify_tier.mjs
//
// Output: { "tier": N, "reason": "..." }
//
// Environment:
//   GARRISON_TIER_FLOOR       minimum tier (default 3)
//   GARRISON_PLAN_THRESHOLD   tier that triggers plan-before-execute (default 3)

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FITTING_DIR = path.resolve(__dirname, "..");

const SKILL_MD_PATH = path.join(FITTING_DIR, ".apm", "skills", "tier-classifier", "SKILL.md");

const TIER_FLOOR = Number(process.env.GARRISON_TIER_FLOOR ?? "3");
const PLAN_THRESHOLD = Number(process.env.GARRISON_PLAN_THRESHOLD ?? "3");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function loadQuery() {
  // Dynamic import so --probe doesn't fail if the SDK isn't installed yet.
  const require = createRequire(import.meta.url);
  const paths = [
    path.join(FITTING_DIR, "node_modules", "@anthropic-ai", "claude-agent-sdk", "index.js"),
    // Sibling http-gateway symlink path
    path.join(FITTING_DIR, "node_modules", "@anthropic-ai", "claude-agent-sdk"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try { return require(p).query; } catch { /* try next */ }
    }
  }
  // Standard resolution
  try { return require("@anthropic-ai/claude-agent-sdk").query; } catch { /* fall through */ }
  return null;
}

async function classify(prompt) {
  if (!existsSync(SKILL_MD_PATH)) {
    throw new Error(`SKILL.md not found at ${SKILL_MD_PATH}`);
  }
  const skillMd = readFileSync(SKILL_MD_PATH, "utf8");

  const query = loadQuery();
  if (!query) {
    throw new Error("@anthropic-ai/claude-agent-sdk not found — run setup first");
  }

  const systemPrompt = [
    skillMd.trim(),
    "",
    `Config: tier_floor=${TIER_FLOOR}, plan_threshold=${PLAN_THRESHOLD}.`,
    "",
    "Respond with ONLY valid JSON on one line, no markdown fences:",
    '{"tier": <integer 1-7>, "reason": "<one sentence>"}'
  ].join("\n");

  let assistantText = "";
  const queryHandle = query({
    prompt: `Classify this prompt:\n\n${prompt}`,
    options: {
      systemPrompt,
      maxTurns: 1,
      allowedTools: [],
      permissionMode: "default"
    }
  });

  for await (const event of queryHandle) {
    if (event.type === "assistant" && event.message?.content) {
      for (const block of (event.message.content ?? [])) {
        if (block.type === "text") assistantText += block.text;
      }
    }
  }

  // Extract JSON — may be wrapped in prose
  const jsonMatch = assistantText.match(/\{[^}]*"tier"\s*:\s*\d+[^}]*\}/);
  if (!jsonMatch) {
    throw new Error(`could not parse tier JSON from model output: ${assistantText.slice(0, 200)}`);
  }
  const parsed = JSON.parse(jsonMatch[0]);
  const tier = Math.max(TIER_FLOOR, Math.min(7, Number(parsed.tier)));
  return { tier, reason: parsed.reason ?? "" };
}

async function main(argv) {
  if (argv[0] === "--probe") {
    // Verify SKILL.md exists and SDK is loadable
    if (!existsSync(SKILL_MD_PATH)) {
      process.stderr.write(`classify_tier: SKILL.md not found at ${SKILL_MD_PATH}\n`);
      return 1;
    }
    const q = loadQuery();
    if (!q) {
      process.stderr.write("classify_tier: SDK not installed\n");
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

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`classify_tier: ${err.message}\n`);
  process.exit(1);
});

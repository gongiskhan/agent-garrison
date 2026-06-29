#!/usr/bin/env node
import { OperativePtySession } from "@garrison/claude-pty";

const COMPOSITION_DIR = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();
const SYSTEM_PROMPT_PATH = process.env.GARRISON_SYSTEM_PROMPT_PATH || undefined;
const MODEL = process.env.GARRISON_MODEL ?? "opus";
const PERMISSION_MODE = process.env.GARRISON_PERMISSION_MODE ?? "bypassPermissions";
const CLAUDE_BINARY = process.env.GARRISON_CLAUDE_BINARY ?? "claude";
// When the primary runtime selects a non-default provider (ollama/deepseek/zai),
// the runner sets ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN + GARRISON_PROVIDER_LAUNCH.
// providerLaunch keeps those vars instead of stripping them for the Max-plan default.
const PROVIDER_LAUNCH = process.env.GARRISON_PROVIDER_LAUNCH === "1";

let session = null;

function log(stream, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), component: "pty-operative", stream, ...payload });
  (stream === "stderr" ? process.stderr : process.stdout).write(line + "\n");
}

async function main() {
  log("stdout", {
    kind: "spawning",
    model: MODEL,
    compositionDir: COMPOSITION_DIR,
    providerLaunch: PROVIDER_LAUNCH,
    provider: process.env.GARRISON_PROVIDER
  });
  session = await OperativePtySession.spawn({
    compositionDir: COMPOSITION_DIR,
    appendSystemPromptFile: SYSTEM_PROMPT_PATH,
    model: MODEL,
    permissionMode: PERMISSION_MODE,
    claudeBinary: CLAUDE_BINARY,
    providerLaunch: PROVIDER_LAUNCH
  });
  log("stdout", { kind: "ready", sessionId: session.getClaudeSessionId() });
  const outcome = await session.runTurn({
    message: "You are now online as an Agent Garrison operative. Acknowledge briefly."
  });
  log("stdout", { kind: "assistant", reply: outcome.reply, sessionId: outcome.sessionId });
  await new Promise(() => {});
}

async function shutdown(signal) {
  log("stdout", { kind: "shutdown", signal });
  try {
    session?.dispose();
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((error) => {
  log("stderr", { kind: "failed", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

#!/usr/bin/env node
// coord-hook — the gap-fill SessionStart / UserPromptSubmit COMMAND hook.
// (a) Nudges the agent to declare intent + call begin_planning before substantial
//     work, and (b) injects a short, repo-scoped digest (planning-lock state +
//     conflicting/active intents) for the current session.
//
// Reads the Claude Code hook payload on stdin (session_id, cwd, hook_event_name,
// prompt?) and emits a hookSpecificOutput.additionalContext JSON on stdout. Writes
// one heartbeat line per fire to ~/.garrison/coord/heartbeat.log (observability
// layer 3). FAIL-OPEN: always exits 0; emits empty context on ANY error — it can
// never block a session. PTY-safe: no model call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".garrison");
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function emit(event, ctx) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event || "SessionStart", additionalContext: ctx || "" } }));
}

async function main() {
  const raw = readStdin();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  const event = payload.hook_event_name || "SessionStart";
  const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const session = payload.session_id || process.env.CLAUDE_SESSION_ID || "hook";

  // Import the coordination libs from the fitting (sibling ./lib). On any import
  // failure (fitting half-removed) we still emit empty context + exit 0.
  let repo,
    digest = { text: "", bytes: 0, hasConflicts: false, conflicts: [] };
  try {
    const { repoRoot } = await import(path.join(__dirname, "lib", "repo.mjs"));
    const { buildDigest } = await import(path.join(__dirname, "lib", "digest.mjs"));
    repo = repoRoot(cwd);
    // For UserPromptSubmit, the prompt text is a working-set hint; we pass it as a
    // loose "area" so an intent naming the same area surfaces as a hard conflict.
    const area = event === "UserPromptSubmit" && typeof payload.prompt === "string" ? payload.prompt.slice(0, 200) : "";
    digest = buildDigest(repo, { session, area, files: [] }, new Date());
  } catch {
    emit(event, "");
    return;
  }

  // Heartbeat line (observability layer 3): timestamp, session, conflicts, bytes.
  try {
    const dir = path.join(garrisonHome(), "coord");
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      session,
      repo,
      conflicts: digest.conflicts ? digest.conflicts.length : 0,
      digestBytes: digest.bytes
    });
    fs.appendFileSync(path.join(dir, "heartbeat.log"), line + "\n");
  } catch {
    /* never fail the hook on a log write */
  }

  emit(event, digest.text);
}

main().catch(() => {
  // Absolute fail-open backstop.
  try {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" } }));
  } catch {}
  process.exit(0);
});

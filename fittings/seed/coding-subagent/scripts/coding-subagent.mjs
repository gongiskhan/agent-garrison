#!/usr/bin/env node
/**
 * coding-subagent CLI. Plan-then-execute coding sub-agent for Agent
 * Garrison. The Operative invokes this via the Bash tool.
 *
 * Subcommands:
 *   plan    --project <name> --goal "<sentence>"
 *   execute --plan-id <doc-id> --project <name>
 *   kill    --execution-id <id>
 *   --probe                           # health check, prints "ok"
 *
 * Non-trivial design points:
 * - Sub-agent runs in-process via @anthropic-ai/claude-agent-sdk. The
 *   parent (gateway) is undisturbed because we run as a child process
 *   spawned by the Operative's Bash tool.
 * - Project path resolution defers to the consumed projects-index
 *   Fitting. We never re-implement path logic.
 * - Plans are persisted via the consumed documents Fitting. The CLI
 *   shells out to documents.py rather than touching the artifact store
 *   directly — same producer label, same namespace, same id space.
 * - Per-execution log files live at compositions/<id>/logs/. T4 (Run
 *   tab) tails these. Format matches the gateway: one JSON object per
 *   line.
 * - Execution registry at compositions/<id>/data/coding-subagent-executions.json
 *   tracks active runs for the kill subcommand and survives crashes.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FITTING_DIR = path.resolve(__dirname, "..");
const COMPOSITION_DIR = path.resolve(FITTING_DIR, "../../..");

const PROJECTS_CLI = path.join(
  COMPOSITION_DIR,
  "apm_modules/_local/projects-index/scripts/projects.py"
);
const DOCUMENTS_CLI = path.join(
  COMPOSITION_DIR,
  "apm_modules/_local/documents/scripts/documents.py"
);

const LOGS_DIR = path.join(COMPOSITION_DIR, "logs");
const DATA_DIR = path.join(COMPOSITION_DIR, "data");
const STATE_FILE = path.join(DATA_DIR, "coding-subagent-executions.json");

const SUBAGENT_MODEL = process.env.GARRISON_SUBAGENT_MODEL ?? "opus";
const SUBAGENT_PERMISSION_MODE =
  process.env.GARRISON_SUBAGENT_PERMISSION_MODE ?? "bypassPermissions";
const MAX_PLAN_TURNS = Number(process.env.GARRISON_SUBAGENT_MAX_PLAN_TURNS ?? "30");
const MAX_EXECUTE_TURNS = Number(
  process.env.GARRISON_SUBAGENT_MAX_EXECUTE_TURNS ?? "200"
);

// ───────────────────────────────────────────── helpers

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readState() {
  ensureDir(DATA_DIR);
  if (!existsSync(STATE_FILE)) return { executions: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { executions: {} };
  }
}

function writeState(state) {
  ensureDir(DATA_DIR);
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function upsertExecution(record) {
  const state = readState();
  state.executions[record.id] = record;
  writeState(state);
}

function patchExecution(id, patch) {
  const state = readState();
  if (!state.executions[id]) return null;
  state.executions[id] = { ...state.executions[id], ...patch };
  writeState(state);
  return state.executions[id];
}

/** Patch only if current status is "running"; preserves a terminal status
 *  (killed/done) that a signal handler may have already set. */
function patchIfRunning(id, patch) {
  const state = readState();
  const current = state.executions[id];
  if (!current) return null;
  if (current.status !== "running") return current;
  state.executions[id] = { ...current, ...patch };
  writeState(state);
  return state.executions[id];
}

function logTo(stream, payload) {
  // Match the gateway log format: one JSON object per line.
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    component: "coding-subagent",
    ...payload
  });
  stream.write(line + "\n");
}

function resolveProject(name) {
  const result = spawnSync("python3", [PROJECTS_CLI, "describe", name], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `projects-index describe failed for "${name}": ${result.stderr.trim()}`
    );
  }
  // describe returns JSON with name and directory_listing; the path is
  // the projects_root + name. List gives us projects_root.
  const list = spawnSync("python3", [PROJECTS_CLI, "list"], {
    encoding: "utf8"
  });
  if (list.status !== 0) {
    throw new Error(`projects-index list failed: ${list.stderr.trim()}`);
  }
  const listing = JSON.parse(list.stdout);
  const root = listing.projects_root;
  const described = JSON.parse(result.stdout);
  return path.join(root, described.name);
}

function captureDocument(title, body) {
  const result = spawnSync(
    "python3",
    [DOCUMENTS_CLI, "create", "--title", title],
    { input: body, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`documents create failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim(); // artifact id
}

function readDocument(id) {
  const result = spawnSync("python3", [DOCUMENTS_CLI, "read", id], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`documents read failed for ${id}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// ───────────────────────────────────────────── subagent runner

// Active sub-agent handle for signal-driven interrupts. Set by
// runSubAgent; consumed by the SIGTERM/SIGINT handler installed by
// installAbortHandlers.
let activeQuery = null;

function installAbortHandlers(executionId, logStream) {
  const onSignal = async (signal) => {
    logTo(logStream, { kind: "killed-by-signal", signal });
    patchIfRunning(executionId, {
      status: "killed",
      ended_at: new Date().toISOString()
    });
    if (activeQuery && typeof activeQuery.interrupt === "function") {
      try {
        await activeQuery.interrupt();
      } catch {
        /* sub-agent already gone */
      }
    }
    // Give the SDK a beat to flush its child processes. interrupt()
    // signals the in-flight Claude session; the for-await in
    // runSubAgent will end on its own. Force-exit if cleanup hangs.
    setTimeout(() => process.exit(143), 2000).unref();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

async function runSubAgent({
  prompt,
  systemPrompt,
  cwd,
  maxTurns,
  logStream
}) {
  const start = Date.now();
  let assistantText = "";
  let resultSubtype = null;
  let toolUseCount = 0;
  let costUsd = null;

  logTo(logStream, {
    kind: "subagent-start",
    cwd,
    model: SUBAGENT_MODEL,
    permission_mode: SUBAGENT_PERMISSION_MODE,
    max_turns: maxTurns
  });

  const queryHandle = query({
    prompt,
    options: {
      cwd,
      systemPrompt,
      model: SUBAGENT_MODEL,
      permissionMode: SUBAGENT_PERMISSION_MODE,
      maxTurns: maxTurns
    }
  });
  activeQuery = queryHandle;

  for await (const event of queryHandle) {
    if (event.type === "system" && event.subtype === "init") {
      logTo(logStream, {
        kind: "subagent-session-init",
        session_id: event.session_id
      });
    } else if (event.type === "assistant" && event.message?.content) {
      const blocks = Array.isArray(event.message.content)
        ? event.message.content
        : [];
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          assistantText += block.text;
          logTo(logStream, { kind: "assistant-text", text: block.text });
        } else if (block.type === "tool_use") {
          toolUseCount++;
          logTo(logStream, {
            kind: "tool-use",
            name: block.name,
            input: block.input
          });
        }
      }
    } else if (event.type === "result") {
      resultSubtype = event.subtype;
      costUsd = event.total_cost_usd ?? null;
      logTo(logStream, {
        kind: "turn-result",
        subtype: resultSubtype,
        cost_usd: costUsd
      });
    }
  }

  const totalMs = Date.now() - start;
  logTo(logStream, {
    kind: "subagent-end",
    result_subtype: resultSubtype,
    total_ms: totalMs,
    tool_uses: toolUseCount,
    cost_usd: costUsd
  });

  activeQuery = null;

  if (resultSubtype && resultSubtype !== "success") {
    throw new Error(`sub-agent ended with subtype="${resultSubtype}"`);
  }

  return {
    text: assistantText.trim(),
    totalMs,
    toolUseCount,
    costUsd
  };
}

// ───────────────────────────────────────────── prompts

const PLAN_SYSTEM_PROMPT = `You are a coding sub-agent in planning mode.

You read the relevant parts of the codebase you've been pointed at, and
produce a concise implementation plan. You DO NOT make any file edits
during planning. If you need to inspect more files than you initially
thought, do so — the plan should reflect real code, not guesses.

Output starts directly with "## Goal". No preamble, no "I'll now…",
no "Here is the plan." Just the plan. The first line of your reply
is "## Goal".

Output a markdown plan with these sections:

## Goal
The user's goal restated in your own words, plus any clarifications you
inferred from reading the codebase.

## Files
A list of files that will be touched, with a one-line note per file
describing what changes there.

## Changes
For each file, what specific change. Include enough detail that someone
who hasn't read the codebase could execute it from this plan alone, but
be terse — no prose, just the change.

## Verification
How to confirm the change works end-to-end. Tests to run, manual smokes,
or commands to invoke.

## Risks
Anything that could go wrong, edge cases the plan glosses over, or
dependencies you're uncertain about. Be honest. If there are no real
risks, say so in one line.

End the plan after Risks. Do not add a trailing summary or "next steps"
section.`;

const EXECUTE_SYSTEM_PROMPT = `You are a coding sub-agent in execution mode.

You execute the plan you were given against the project you've been
pointed at. You make file edits, run tests, and verify your work.

Discipline:
- Follow the plan. If the plan is wrong, STOP and explain rather than
  improvising — the parent agent will re-plan.
- Run the verification steps from the plan before declaring done.
- If a test fails or a command errors, surface it; don't paper over.

Output starts directly with "## What I did". No preamble, no "I've
completed…", no acknowledgement before the heading. The first line
of your reply is "## What I did".

Output a single concluding markdown summary with:

## What I did
Bullet list of concrete changes. File paths.

## What I checked
What you ran to verify the work. Output if relevant.

## Notes
Anything the parent agent should know — surprises, follow-up work, or
parts of the plan that turned out wrong.

Keep the summary terse. The Run tab shows the full execution log; the
summary is the chat-facing recap.`;

// ───────────────────────────────────────────── subcommands

async function cmdPlan(flags) {
  const project = flags.project;
  const goal = flags.goal;
  if (!project || !goal) {
    throw new Error("plan requires --project and --goal");
  }

  const projectPath = resolveProject(project);
  const executionId = randomUUID();
  const logPath = path.join(LOGS_DIR, `coding-subagent-${executionId}.log`);
  ensureDir(LOGS_DIR);
  const logStream = (await fs.open(logPath, "w")).createWriteStream();

  upsertExecution({
    id: executionId,
    kind: "plan",
    project,
    project_path: projectPath,
    goal,
    started_at: new Date().toISOString(),
    ended_at: null,
    status: "running",
    pid: process.pid,
    log_path: logPath
  });
  installAbortHandlers(executionId, logStream);

  const userPrompt = `Project: ${project}
Goal: ${goal}

Read the codebase and produce a plan as instructed.`;

  let plan;
  try {
    const result = await runSubAgent({
      prompt: userPrompt,
      systemPrompt: PLAN_SYSTEM_PROMPT,
      cwd: projectPath,
      maxTurns: MAX_PLAN_TURNS,
      logStream
    });
    plan = result.text;
  } catch (error) {
    patchIfRunning(executionId, {
      status: "failed",
      ended_at: new Date().toISOString(),
      error: error.message
    });
    logStream.end();
    throw error;
  }

  const title = `Plan: ${goal.slice(0, 80)}`.replace(/\s+/g, " ").trim();
  const docId = captureDocument(title, plan);

  patchExecution(executionId, {
    status: "done",
    ended_at: new Date().toISOString(),
    plan_id: docId
  });
  logStream.end();

  // Emit a compact, parseable result to stdout. The Operative reads
  // this verbatim and surfaces both the plan and the link.
  process.stdout.write(JSON.stringify({
    execution_id: executionId,
    plan_id: docId,
    plan_url: `garrison://documents/${docId}`,
    plan
  }, null, 2));
  process.stdout.write("\n");
}

async function cmdExecute(flags) {
  const project = flags.project;
  const planId = flags["plan-id"];
  if (!project || !planId) {
    throw new Error("execute requires --project and --plan-id");
  }

  const planMarkdown = readDocument(planId).trim();
  if (!planMarkdown) {
    throw new Error(`plan document ${planId} is empty`);
  }

  const projectPath = resolveProject(project);
  const executionId = randomUUID();
  const logPath = path.join(LOGS_DIR, `coding-subagent-${executionId}.log`);
  ensureDir(LOGS_DIR);
  const logStream = (await fs.open(logPath, "w")).createWriteStream();

  upsertExecution({
    id: executionId,
    kind: "execute",
    project,
    project_path: projectPath,
    plan_id: planId,
    started_at: new Date().toISOString(),
    ended_at: null,
    status: "running",
    pid: process.pid,
    log_path: logPath
  });
  installAbortHandlers(executionId, logStream);

  const userPrompt = `Project: ${project}

The plan to execute follows. Treat it as authoritative; if any part is
wrong or unworkable, stop and explain rather than improvising.

---

${planMarkdown}

---

Now execute the plan and produce the concluding summary.`;

  let summary;
  try {
    const result = await runSubAgent({
      prompt: userPrompt,
      systemPrompt: EXECUTE_SYSTEM_PROMPT,
      cwd: projectPath,
      maxTurns: MAX_EXECUTE_TURNS,
      logStream
    });
    summary = result.text;
  } catch (error) {
    patchIfRunning(executionId, {
      status: "failed",
      ended_at: new Date().toISOString(),
      error: error.message
    });
    logStream.end();
    throw error;
  }

  patchExecution(executionId, {
    status: "done",
    ended_at: new Date().toISOString()
  });
  logStream.end();

  process.stdout.write(JSON.stringify({
    execution_id: executionId,
    project,
    plan_id: planId,
    summary
  }, null, 2));
  process.stdout.write("\n");
}

function cmdKill(flags) {
  const id = flags["execution-id"];
  if (!id) throw new Error("kill requires --execution-id");
  const state = readState();
  const record = state.executions[id];
  if (!record) {
    throw new Error(`unknown execution ${id}`);
  }
  if (record.status !== "running") {
    process.stdout.write(JSON.stringify({
      execution_id: id,
      status: record.status,
      noop: true
    }));
    process.stdout.write("\n");
    return;
  }
  const pid = record.pid;
  if (!pid) throw new Error(`execution ${id} has no pid`);
  // SIGTERM the CLI process. Its signal handler reconciles state and
  // exits, which closes the SDK's stdio and reaps MCP server children.
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") {
      // Already gone. Reconcile state.
      patchExecution(id, {
        status: "killed",
        ended_at: new Date().toISOString()
      });
    } else {
      throw error;
    }
  }
  // Give the child a moment to flush its log before we report status.
  // The execute path's signal handler updates state.
  process.stdout.write(JSON.stringify({
    execution_id: id,
    status: "killing"
  }));
  process.stdout.write("\n");
}

// ───────────────────────────────────────────── entry

async function main(argv) {
  if (argv.includes("--probe")) {
    process.stdout.write("ok\n");
    return 0;
  }

  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));

  if (cmd === "plan") {
    await cmdPlan(flags);
    return 0;
  }
  if (cmd === "execute") {
    await cmdExecute(flags);
    return 0;
  }
  if (cmd === "kill") {
    cmdKill(flags);
    return 0;
  }

  process.stderr.write(
    "usage:\n" +
      "  coding-subagent.mjs plan --project <name> --goal <sentence>\n" +
      "  coding-subagent.mjs execute --plan-id <doc-id> --project <name>\n" +
      "  coding-subagent.mjs kill --execution-id <id>\n" +
      "  coding-subagent.mjs --probe\n"
  );
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (error) => {
    process.stderr.write(`coding-subagent failed: ${error.message}\n`);
    process.exit(1);
  }
);

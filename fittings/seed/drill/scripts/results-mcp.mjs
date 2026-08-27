#!/usr/bin/env node
// drill-results - the Results MCP: a universal test-evidence entry point for
// Garrison. Any session (a Claude Code work session, an automation, an e2e
// run, another tool) reports what it verified and gets back a drill-style
// report page it can hand to a human.
//
// THIS SERVER EXECUTES NOTHING. It renders no verdict of its own. Every run it
// creates is stamped origin=reported - self-declared evidence - and the report
// says so in words at the top, so it can never be mistaken for a drill run
// that actually happened.
//
// It is a THIN WRAPPER over Garrison's HTTP API (POST /api/results...). The
// HTTP surface is the real one: Claude Code loads MCP servers only at session
// start, so an already-running session can never reach this process, and must
// be able to report with nothing but curl. The two surfaces stay functionally
// identical - this adds tool discoverability, never capability.
//
// Newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio transport),
// same shape as coord-mcp's server. Spawned per Claude Code session, so this
// process == one session, which is why `runId` is optional: the run opened by
// this session is remembered and used as the default target.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = "drill-results";
const VERSION = "0.1.0";

// Baked into the MCP registration by scripts/register-results-mcp.mjs from the
// registering instance's GARRISON_APP_URL, so a dev-registered server talks to
// dev and a prod-registered one to prod. The literal is the last resort only:
// prod is the always-on instance (systemd, tailnet root), so it is the only
// defensible guess when nothing else says otherwise.
const FALLBACK_API = "http://127.0.0.1:8777";

export function apiBase(env = process.env) {
  const raw = (env.GARRISON_RESULTS_API || env.GARRISON_APP_URL || env.GARRISON_BASE_URL || FALLBACK_API).trim();
  return raw.replace(/\/+$/, "");
}

const SESSION =
  (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) ||
  (process.env.GARRISON_SESSION_ID && process.env.GARRISON_SESSION_ID.trim()) ||
  `${os.hostname().split(".")[0]}-${randomUUID().slice(0, 8)}`;

// The run this session opened. Explicit runId always wins; this is the default
// so a session does not have to thread an id through every call.
let currentRunId = null;

function resolveRunId(args) {
  const explicit = args && args.runId ? String(args.runId).trim() : "";
  const id = explicit || currentRunId;
  if (!id) throw new Error("no run is open - call results_open_run first (or pass runId)");
  return id;
}

async function call(method, endpoint, body, env = process.env) {
  const url = `${apiBase(env)}${endpoint}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    });
  } catch (err) {
    throw new Error(
      `Garrison is not reachable at ${apiBase(env)} (${err.message}). The Results API is served by the Garrison app itself, so start it (or set GARRISON_RESULTS_API).`
    );
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // fall through - a non-JSON body is reported raw
  }
  if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status}: ${parsed?.error ?? text.slice(0, 300)}`);
  return parsed ?? {};
}

// ---- tools (exported for tests) ----

export async function openRun(args = {}, env = process.env) {
  const result = await call(
    "POST",
    "/api/results",
    {
      title: args.title,
      // origin is NOT caller-settable to "executed" from here: this server
      // never executes anything, so everything it opens is reported evidence.
      origin: "reported",
      session: args.session || SESSION,
      tool: "mcp",
      cwd: args.cwd || process.cwd(),
      project: args.project,
      path: args.path,
      meta: args.meta
    },
    env
  );
  currentRunId = result.runId;
  return {
    runId: result.runId,
    url: result.url,
    origin: result.origin,
    note: "Report steps as they happen with results_add_step. The page is live - it can be opened mid-run."
  };
}

export async function addStep(args = {}, env = process.env) {
  const runId = resolveRunId(args);
  const result = await call(
    "POST",
    `/api/results/${encodeURIComponent(runId)}/steps`,
    {
      name: args.name,
      status: args.status,
      description: args.description,
      logs: args.logs,
      notes: args.notes,
      tags: args.tags,
      id: args.id
    },
    env
  );
  return { runId, stepId: result.stepId, n: result.n, status: result.status, url: result.url };
}

export async function attachMedia(args = {}, env = process.env) {
  const runId = resolveRunId(args);
  const body = { stepId: args.stepId, caption: args.caption, kind: args.kind, name: args.name };
  if (args.path) {
    const abs = path.resolve(String(args.path));
    if (!fs.existsSync(abs)) throw new Error(`no such file: ${abs}`);
    body.path = abs;
    body.name = args.name || path.basename(abs);
  } else if (args.base64) {
    body.base64 = args.base64;
    if (!body.name) throw new Error("`name` is required with base64 content (the extension picks the media type)");
  } else {
    throw new Error("pass `path` (a file on this machine - the normal case) or `base64` + `name`");
  }
  const result = await call("POST", `/api/results/${encodeURIComponent(runId)}/media`, body, env);
  return {
    runId,
    media: result.media,
    kind: result.kind,
    stepId: result.stepId,
    keyframes: result.keyframes ?? [],
    keyframeNote: result.keyframeNote ?? null,
    url: result.url
  };
}

export async function finalizeRun(args = {}, env = process.env) {
  const runId = resolveRunId(args);
  const result = await call(
    "POST",
    `/api/results/${encodeURIComponent(runId)}/finalize`,
    { status: args.status, conclusion: args.conclusion },
    env
  );
  // Do NOT clear currentRunId when the run went out with no evidence: the
  // warning tells the caller to attach what it still holds, and media can be
  // attached after finalize. Dropping the default target would make the very
  // next results_attach_media fail for want of a runId.
  const thin = Array.isArray(result.warnings) && result.warnings.length > 0;
  if (currentRunId === runId && !thin) currentRunId = null;
  return {
    runId,
    status: result.status,
    summary: result.summary,
    evidence: result.evidence,
    ...(thin ? { warnings: result.warnings } : {}),
    url: result.url,
    note: thin
      ? "Attach what you still hold with results_attach_media (it works after finalize), THEN print this url as the last line of your output."
      : "Print this url as the LAST line of your output so it is tappable from the phone."
  };
}

export async function listRuns(args = {}, env = process.env) {
  const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 100) : 20;
  const result = await call("GET", `/api/results?limit=${limit}`, undefined, env);
  return { runs: result.runs ?? [], index: `${apiBase(env)}/results` };
}

const TOOLS = [
  {
    name: "results_open_run",
    description:
      "Open a test-evidence report and get its live link back. Records what YOU verified - it executes nothing, and the report is stamped 'reported' so it can never read as an executed Drill run. Steps are appended as they happen and the page is viewable mid-run.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What was tested, in a human-readable line." },
        project: { type: "string", description: "Repo root or project name this evidence is about." },
        path: { type: "string", description: "Optional URL path under test, e.g. /muster." },
        session: { type: "string", description: "Override the reporting session id (defaults to this session)." },
        cwd: { type: "string" },
        meta: { type: "object", description: "Anything else worth keeping with the run." }
      },
      required: ["title"]
    }
  },
  {
    name: "results_add_step",
    description:
      "Append one step to the open run, AT THE MOMENT you finish that check - not in a batch at the end. Only name and status are required. Report as you go because the evidence is only in your hands then: the screenshot you just took and the output you just read are attachable now and gone later.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Defaults to the run this session opened." },
        name: { type: "string" },
        status: { type: "string", enum: ["pass", "fail", "skipped", "info"] },
        description: { type: "string" },
        logs: { type: "string", description: "Command output, stack trace, assertion text." },
        notes: { description: "Arbitrary JSON or text kept verbatim with the step." },
        tags: { type: "array", items: { type: "string" } },
        id: { type: "string", description: "Stable step id; generated when omitted." }
      },
      required: ["name", "status"]
    }
  },
  {
    name: "results_attach_media",
    description:
      "Attach a screenshot, image, video or file to a step (defaults to the newest step). Pass `path` for a file already on this machine. Call this right after the step it backs: if you drove a browser, took a screenshot, ran Playwright (test-results/ holds its screenshots, traces and videos), or wrote output to a file, that artifact belongs on the step - a `pass` nobody can look at is an assertion, not evidence. A video gets keyframes extracted so the report shows something before it is played.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        stepId: {
          type: "string",
          description: 'Defaults to the most recent step. Pass "run" for evidence about the whole run, such as a full-run recording.'
        },
        path: { type: "string", description: "Absolute path to the file on this machine." },
        base64: { type: "string", description: "Base64 bytes, when you hold the content rather than a file." },
        name: { type: "string", description: "File name; required with base64." },
        caption: { type: "string" },
        kind: { type: "string", enum: ["image", "video", "file"] }
      }
    }
  },
  {
    name: "results_finalize_run",
    description:
      "Close the run and get the durable report link. Print that url as the last line of your output. The link keeps working after this server and the Drill fitting stop.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        status: { type: "string", enum: ["passed", "failed", "partial", "canceled"], description: "Derived from the steps when omitted." },
        conclusion: { type: "string", description: "A closing sentence shown at the top of the report." }
      }
    }
  },
  {
    name: "results_list_runs",
    description: "List recently stored result runs (newest first) with their links.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } }
  }
];

const DISPATCH = {
  results_open_run: openRun,
  results_add_step: addStep,
  results_attach_media: attachMedia,
  results_finalize_run: finalizeRun,
  results_list_runs: listRuns
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: VERSION } }
    });
  }
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const fn = DISPATCH[name];
    if (!fn) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } });
    try {
      const result = await fn(args || {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  }
  if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
}

function runStdioServer() {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore malformed
    }
    Promise.resolve(handle(msg)).catch(() => {
      /* never crash the server on a tool error */
    });
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--probe")) {
    send({ ok: true, server: SERVER_NAME, api: apiBase(), session: SESSION, tools: TOOLS.map((t) => t.name) });
    process.exit(0);
  } else {
    runStdioServer();
  }
}

export { TOOLS, SESSION, SERVER_NAME };

#!/usr/bin/env node
// coord-mcp — the planning-gate stdio MCP server. Newline-delimited JSON-RPC 2.0
// over stdin/stdout (the MCP stdio transport; same shape as the Knowledge server).
// Spawned per Claude Code session, so this process == one session.
//
// Tools:
//   begin_planning(repo?, summary)  -> WAIT (held by another) | GRANTED + read-bundle
//   end_planning(repo?)             -> release the lock (records the released plan)
//   plan_heartbeat(repo?)           -> extend the lock TTL
//   plan_status(repo?)              -> holder + waiters (observability layer 5)
//   declare_intent(repo?, area, files?, reason)  -> record an intent (drift signal)
//   release_intents(repo?)          -> clear this session's intents
//   coord_digest(repo?, area?, files?) -> the repo-scoped digest (same as the hook)
//
// All work is mechanical (file scans + a bd query) — NO model call (stays in PTY).
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { repoRoot } from "./lib/repo.mjs";
import { acquireLock, releaseLock, heartbeat, lockStatus, recordWaiter, clearWaiter, readWaiters } from "./lib/plan-lock.mjs";
import { recordPlan } from "./lib/plan-store.mjs";
import { declareIntent, removeIntentsBySession } from "./lib/intent-store.mjs";
import { buildReadBundle } from "./lib/read-bundle.mjs";
import { buildDigest } from "./lib/digest.mjs";

const SESSION =
  (process.env.CLAUDE_SESSION_ID && process.env.CLAUDE_SESSION_ID.trim()) ||
  (process.env.COORD_SESSION && process.env.COORD_SESSION.trim()) ||
  `${os.hostname().split(".")[0]}-${randomUUID().slice(0, 8)}`;

function resolveRepo(args) {
  const r = args && args.repo;
  if (r && String(r).trim()) return String(r).trim();
  return repoRoot(process.cwd());
}

// ---- tool implementations (exported for tests) ----
export function beginPlanning(args, session = SESSION, now = new Date()) {
  const repo = resolveRepo(args);
  const summary = String((args && args.summary) || "");
  const acq = acquireLock(repo, session, summary, now);
  if (!acq.acquired) {
    recordWaiter(repo, session, summary, now);
    const h = acq.holder;
    return {
      status: "WAIT",
      repo,
      message: `Another session is planning ${repo}. WAIT and re-check; do not start planning.`,
      // holder is unknown for a "contended" loss (a concurrent acquirer mid-write).
      holder: h ? { session: h.session, summary: h.summary, startedAt: h.startedAt, expiresAt: h.expiresAt } : null,
      reason: acq.reason
    };
  }
  clearWaiter(repo, session);
  return {
    status: "GRANTED",
    repo,
    lock: { session, startedAt: acq.lock.startedAt, expiresAt: acq.lock.expiresAt },
    recoveredStaleLock: Boolean(acq.recovered),
    readBundle: buildReadBundle(repo, now)
  };
}

export function endPlanning(args, session = SESSION, now = new Date()) {
  const repo = resolveRepo(args);
  const st = lockStatus(repo, now);
  // Record the released plan if THIS session is the lock's attributed owner — even
  // if the lock has since expired, the planner's plan is still valuable to the next.
  if (st.lock && st.lock.session === session) {
    recordPlan(repo, {
      session,
      summary: st.lock.summary,
      startedAt: st.lock.startedAt,
      releasedAt: now.toISOString()
    });
  }
  const rel = releaseLock(repo, session, now);
  return { status: rel.released ? "RELEASED" : "NOT-HELD", repo, detail: rel };
}

export function planHeartbeat(args, session = SESSION, now = new Date()) {
  const repo = resolveRepo(args);
  return { repo, ...heartbeat(repo, session, now) };
}

export function planStatus(args, _session = SESSION, now = new Date()) {
  const repo = resolveRepo(args);
  return { repo, lock: lockStatus(repo, now), waiters: readWaiters(repo, now) };
}

export function declareIntentTool(args, session = SESSION, now = new Date()) {
  const repo = resolveRepo(args);
  const row = declareIntent(repo, {
    session,
    area: (args && args.area) || "",
    files: (args && args.files) || [],
    reason: (args && args.reason) || "",
    ts: now.toISOString()
  });
  return { status: "DECLARED", repo, intent: row };
}

export function releaseIntentsTool(args, session = SESSION) {
  const repo = resolveRepo(args);
  removeIntentsBySession(repo, session);
  return { status: "RELEASED", repo, session };
}

export async function coordDigestTool(args, session = SESSION, now = new Date()) {
  const repo = resolveRepo(args);
  const d = await buildDigest(repo, { session, area: (args && args.area) || "", files: (args && args.files) || [] }, now);
  return { repo, text: d.text, bytes: d.bytes, hasConflicts: d.hasConflicts, conflicts: d.conflicts, leaseConflicts: d.leaseConflicts };
}

const TOOLS = [
  { name: "begin_planning", description: "Acquire the per-repo planning lock before a substantial task. Returns WAIT (with the current holder) if another session is planning, else GRANTED + a read-bundle (the last released plan, recent plans, and in-flight intents/leases) so you plan with full knowledge.", inputSchema: { type: "object", properties: { repo: { type: "string" }, summary: { type: "string" } }, required: ["summary"] } },
  { name: "end_planning", description: "Release the per-repo planning lock (records your plan as the released plan for the next planner).", inputSchema: { type: "object", properties: { repo: { type: "string" } } } },
  { name: "plan_heartbeat", description: "Extend your planning lock's TTL while you are still planning.", inputSchema: { type: "object", properties: { repo: { type: "string" } } } },
  { name: "plan_status", description: "Show the current planning-lock holder + waiters for a repo.", inputSchema: { type: "object", properties: { repo: { type: "string" } } } },
  { name: "declare_intent", description: "Declare intent to work on an area/files (with a reason) so other sessions see it and conflicts surface in their digest.", inputSchema: { type: "object", properties: { repo: { type: "string" }, area: { type: "string" }, files: { type: "array", items: { type: "string" } }, reason: { type: "string" } }, required: ["reason"] } },
  { name: "release_intents", description: "Clear this session's declared intents for a repo.", inputSchema: { type: "object", properties: { repo: { type: "string" } } } },
  { name: "coord_digest", description: "Get the repo-scoped coordination digest (planning-lock state + conflicting intents) for your working set.", inputSchema: { type: "object", properties: { repo: { type: "string" }, area: { type: "string" }, files: { type: "array", items: { type: "string" } } } } }
];

const DISPATCH = {
  begin_planning: beginPlanning,
  end_planning: endPlanning,
  plan_heartbeat: planHeartbeat,
  plan_status: planStatus,
  declare_intent: declareIntentTool,
  release_intents: releaseIntentsTool,
  coord_digest: coordDigestTool
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "coord-mcp", version: "0.1.0" } } });
  }
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    const fn = DISPATCH[name];
    if (!fn) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } });
    try {
      const result = await fn(args || {}); // tools may be async (e.g. coord_digest fetches leases)
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
    send({ ok: true, session: SESSION, tools: TOOLS.map((t) => t.name) });
    process.exit(0);
  } else {
    runStdioServer();
  }
}

export { TOOLS, SESSION };

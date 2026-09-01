// codex-adapter.mjs — the Codex RuntimeAdapter (BRIEF v4 Runtime faculty).
//
// Codex is a SECONDARY runtime that proves coding delegation. `codex exec` runs
// non-interactively and reads the prompt from STDIN (never argv → shell-injection
// safe under bypassPermissions), so this is a CLEAN non-PTY adapter — no TUI
// scraping. It implements the same RuntimeAdapter contract as ClaudeCodeAdapter;
// the generic pool + runtime-bridge drive it unchanged.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FULL_ACCESS_PERMISSION_MODES = new Set(["auto", "bypassPermissions", "full-auto"]);
const WORKSPACE_WRITE_PERMISSION_MODES = new Set(["acceptEdits", "allow-file-edits"]);

// Garrison's gateway passes its permission mode through the runtime config's
// environment. Codex does not understand Claude's permission-mode names, so map
// them onto Codex's sandbox flags here, at the runtime boundary. `auto` is a
// headless Garrison mode (there is no permission-prompt surface), and therefore
// needs the same unrestricted execution as `bypassPermissions`: routed turns can
// be asked to write an absolute task workspace and an absolute run/evidence dir,
// neither of which is necessarily beneath Codex's scratch cwd.
//
// Every non-auto mode fails closed. Edit-accepting modes can write only the
// selected Codex workspace; plan/default/unknown modes stay read-only. An
// explicit config value wins over the inherited gateway environment.
export function codexPermissionArgs(config = {}) {
  const mode = config.permissionMode ?? config.env?.GARRISON_PERMISSION_MODE ?? null;
  if (FULL_ACCESS_PERMISSION_MODES.has(mode)) {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  if (WORKSPACE_WRITE_PERMISSION_MODES.has(mode)) {
    return ["--sandbox", "workspace-write"];
  }
  return ["--sandbox", "read-only"];
}

// The shared mcp-gateway server, mounted into one `codex exec` through -c
// config overrides so nothing lands in config.toml. Two unlocks, proven live
// by the spike (bench/codex-spike-2026-08-31): the per-server approval mode
// must be "auto", and headless exec pins the GLOBAL approval policy to
// `never`, which DENIES any MCP tool that still wants approval - so sandboxed
// lanes carry --approve-for-me (Codex's automatic reviewer). The bypass lane
// skips approvals wholesale and must NOT carry the flag.
export function mcpServerArgs(server = {}, { bypassed = false } = {}) {
  const name = String(server.name ?? "garrison").replace(/[^A-Za-z0-9_-]/g, "_");
  const out = [];
  out.push("-c", `mcp_servers.${name}.command=${JSON.stringify(String(server.command ?? "node"))}`);
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  out.push("-c", `mcp_servers.${name}.args=${JSON.stringify(args)}`);
  const env = server.env && typeof server.env === "object" ? server.env : null;
  if (env && Object.keys(env).length) {
    const table = Object.entries(env)
      .map(([k, v]) => `${String(k).replace(/[^A-Za-z0-9_-]/g, "_")} = ${JSON.stringify(String(v))}`)
      .join(", ");
    out.push("-c", `mcp_servers.${name}.env={ ${table} }`);
  }
  out.push("-c", `mcp_servers.${name}.default_tools_approval_mode="auto"`);
  if (!bypassed) out.push("--approve-for-me");
  return out;
}

// Build the `codex exec` invocation. Pure + testable: the prompt travels via
// stdin (returned separately), model + reasoning effort via documented `-c`
// config overrides, cwd via `--cd`. argv NEVER contains the prompt.
export function buildExecArgs(config = {}) {
  const argv = ["exec"];
  if (config.model) argv.push("-c", `model=${config.model}`);
  if (config.effort) argv.push("-c", `model_reasoning_effort=${config.effort}`);
  const permission = codexPermissionArgs(config);
  argv.push(...permission);
  // The stretch lane mounts the shared Garrison MCP server into this one exec
  // via -c overrides - session-scoped, no config.toml residue.
  if (config.mcpServer && typeof config.mcpServer === "object") {
    argv.push(...mcpServerArgs(config.mcpServer, {
      bypassed: permission.includes("--dangerously-bypass-approvals-and-sandbox"),
    }));
  }
  if (config.compositionDir) argv.push("--cd", config.compositionDir);
  // `codex exec` refuses to run outside a trusted git dir unless told to skip the
  // check; delegations run in throwaway/non-repo cwds, so always skip it (verified
  // live U4 — the bare invocation errors "Not inside a trusted directory").
  argv.push("--skip-git-repo-check");
  // JSONL events on stdout instead of the human transcript. This is the ONLY way
  // `codex exec` reports token usage (verified live against codex-cli 0.149.0:
  // `--json` is documented as "Print events to stdout as JSONL", and the closing
  // `turn.completed` event carries {input_tokens, cached_input_tokens,
  // cache_write_input_tokens, output_tokens, reasoning_output_tokens}). The reply
  // text then comes from the `agent_message` items rather than raw stdout —
  // parseCodexJsonl does both, and falls back to raw stdout if a build ever stops
  // emitting JSONL, so an unparseable stream degrades to the old behaviour rather
  // than to an empty turn.
  argv.push("--json");
  // read the prompt from stdin
  argv.push("-");
  return { bin: config.bin || "codex", argv, stdinFromPrompt: true };
}

// Sum a `turn.completed` usage object into ONE cumulative token count. Codex
// follows the OpenAI convention where `cached_input_tokens` is a subset of
// `input_tokens` and `reasoning_output_tokens` a subset of `output_tokens`, so
// the total is input + output — adding the subsets would double-count.
function totalTokens(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input_tokens ?? usage.inputTokens);
  const output = Number(usage.output_tokens ?? usage.outputTokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}


// ── rollout usage (cost instrumentation, 2026-08-28) ────────────────────────
//
// `codex exec --json` closes with ONE `turn.completed.usage` for the thread it
// ran. That number is real, but it is NOT the bill: codex 0.149 spawns subagent
// threads (`spawn_agent`), each with its own independent counter that never
// reaches the parent's total. Measured on a real Garrison delegation, stdout
// reported 4,102,975 tokens against an actual 11,255,541 — a 2.74x undercount.
//
// The honest source is the rollout under $CODEX_HOME/sessions. Every thread
// writes one `rollout-<local-iso>-<uuid>.jsonl`; the parent's `thread_id` (from
// the first stdout line) is the uuid in its filename AND the `session_id` every
// one of its subagent threads carries. So the parent's id groups the whole tree.
//
// Per-call rows come from `total_token_usage` DELTAS, not from summing
// `last_token_usage`: the CLI re-emits identical token_count records (a measured
// 22% over-count when summed naively), while `total_token_usage` is strictly
// monotone per thread.
//
// The rollout is written progressively, so this must run AFTER the child closes.

export function codexHome(env = process.env) {
  return env?.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

function* jsonlRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      yield JSON.parse(t);
    } catch {
      /* a torn final line is not a parse failure worth reporting */
    }
  }
}

/** Day directories under sessions/, newest first, bounded. */
function sessionDayDirs(root, limit = 8) {
  const dirs = [];
  const listNumeric = (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  for (const y of listNumeric(root)) {
    for (const m of listNumeric(path.join(root, y))) {
      for (const d of listNumeric(path.join(root, y, m))) {
        dirs.push(path.join(root, y, m, d));
        if (dirs.length >= limit) return dirs;
      }
    }
  }
  return dirs;
}

/**
 * Every rollout file belonging to `threadId` — its own, plus every subagent
 * thread whose session_meta names it as `session_id`. Matched on the uuid, never
 * on the filename timestamp: that timestamp is LOCAL time while every payload
 * timestamp is UTC, and deriving one from the other silently finds nothing.
 */
export function findRolloutFiles(threadId, { home, env = process.env, dayLimit = 4 } = {}) {
  if (!threadId) return [];
  const root = path.join(home ?? codexHome(env), "sessions");
  const found = [];
  for (const dir of sessionDayDirs(root, dayLimit)) {
    let entries;
    try {
      entries = fs.readdirSync(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of entries) {
      const file = path.join(dir, name);
      if (name.endsWith(`-${threadId}.jsonl`)) {
        found.push({ file, own: true });
        continue;
      }
      // Only the first session_meta record is read to test membership.
      for (const rec of jsonlRecords(file)) {
        if (rec?.type !== "session_meta") continue;
        if (rec?.payload?.session_id === threadId && rec?.payload?.id !== threadId) {
          found.push({ file, own: false });
        }
        break;
      }
    }
  }
  return found;
}

const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];

/**
 * Per-API-call usage rows for one rollout file, as monotone deltas of
 * `total_token_usage`. Returns [] when the file reports no usage.
 */
export function rolloutUsageRows(file, { own = true } = {}) {
  const rows = [];
  let prev = null;
  let model = null;
  let threadId = null;
  let threadSource = own ? "user" : "subagent";
  let n = 0;
  for (const rec of jsonlRecords(file)) {
    if (rec?.type === "session_meta") {
      // FIRST session_meta only. A forked subagent replays the parent's history,
      // parent session_meta included, so a last-one-wins read tags every child's
      // spend as the parent's and the parent/subagent split silently collapses.
      if (threadId == null) {
        threadId = rec.payload?.id ?? null;
        threadSource = rec.payload?.thread_source ?? threadSource;
      }
      continue;
    }
    if (rec?.type === "turn_context") {
      model = rec.payload?.model ?? model;
      continue;
    }
    if (rec?.type !== "event_msg" || rec?.payload?.type !== "token_count") continue;
    const total = rec.payload?.info?.total_token_usage;
    if (!total || typeof total !== "object") continue;
    const usage = {};
    let any = false;
    for (const k of USAGE_KEYS) {
      const cur = Number(total[k] ?? 0);
      const was = Number(prev?.[k] ?? 0);
      const d = Number.isFinite(cur) && Number.isFinite(was) ? cur - was : 0;
      usage[k] = d > 0 ? d : 0;
      if (usage[k] > 0) any = true;
    }
    prev = total;
    if (!any) continue; // a repeated token_count record contributes nothing
    rows.push({
      source: "codex-rollout",
      callId: `${threadId ?? path.basename(file)}:${n++}`,
      threadId,
      threadSource,
      model,
      usage,
    });
  }
  return rows;
}

/**
 * Every per-call usage row for a codex thread and its subagents.
 * `{rows, files, complete}` — `complete` is false when no rollout was found, so
 * a caller can fall back to the stdout aggregate and SAY that it did.
 */
export function readCodexThreadUsage(threadId, opts = {}) {
  const files = findRolloutFiles(threadId, opts);
  const rows = [];
  for (const f of files) rows.push(...rolloutUsageRows(f.file, { own: f.own }));
  return { rows, files: files.map((f) => f.file), complete: files.length > 0 };
}

/**
 * Parse a `codex exec --json` stdout stream.
 *
 * Returns `{sawJson, text, usedTokens, usage, errorText}`. `sawJson` is false
 * when nothing on stdout parsed as a JSON event — the caller then treats stdout
 * as plain text (older codex builds, a stubbed exec in tests, `--json` dropped
 * from a future CLI). `usedTokens` is null when the stream reported no usage:
 * unknown usage is NEVER a fabricated zero.
 */
export function parseCodexJsonl(stdout) {
  const messages = [];
  const errors = [];
  let usage = null;
  let sawJson = false;
  // The thread id is the join key to the rollout file under ~/.codex/sessions,
  // which is the ONLY place a subagent's spend is visible (stdout reports the
  // parent thread only). It arrives on the first line and used to be discarded.
  let threadId = null;
  for (const line of String(stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue; // a partial line (cancelled turn) is not a parse failure worth reporting
    }
    sawJson = true;
    // codex 0.149 shape: {type, item?, usage?}. Older builds nest the same
    // payloads under {id, msg:{type,...}} — read both so an adapter upgrade is
    // not a silent text loss.
    const type = evt.type ?? evt.msg?.type ?? null;
    const item = evt.item ?? evt.msg ?? evt;
    if (type === "thread.started" && typeof evt.thread_id === "string") threadId = evt.thread_id;
    // ONLY the completed item (never `item.updated`, which repeats the same
    // item id mid-stream and would duplicate the reply text).
    if (type === "item.completed" || type === "agent_message") {
      if ((item?.type ?? type) === "agent_message") {
        const text = item?.text ?? item?.message ?? "";
        if (String(text).trim()) messages.push(String(text));
      }
    }
    if (type === "turn.completed" || type === "token_count") {
      const u = evt.usage ?? evt.msg?.info?.total_token_usage ?? evt.msg ?? null;
      const total = totalTokens(u);
      if (total != null) {
        usage = u;
      }
    }
    if (type === "turn.failed" || type === "error") {
      const msg = evt.error?.message ?? evt.msg?.message ?? item?.message ?? null;
      if (msg) errors.push(String(msg));
    }
  }
  return {
    sawJson,
    threadId,
    // A turn can emit more than one agent message; keep them all, in order.
    text: messages.join("\n\n"),
    usedTokens: totalTokens(usage),
    usage,
    errorText: errors.join("\n")
  };
}

// A cancelled turn's child gets SIGTERM first so codex can unwind and flush; a
// process that ignores it (or is wedged in a syscall) is SIGKILLed after this
// grace. Short on purpose: the HTTP interrupt caller is waiting on the turn.
const CANCEL_GRACE_MS = 2000;

// node keeps `child.pid` set and flips `child.killed` the moment kill() is
// CALLED, so neither is a liveness signal (same trap pty.mjs documents). The real
// predicate is "no exit observed yet": exitCode stays null until a normal exit,
// signalCode until a signalled one.
function childAlive(child) {
  return !!child && child.exitCode == null && child.signalCode == null;
}

function defaultRunExec({ bin, argv, env, cwd, stdin, onSpawn }) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    // Settle once: a cancel resolves the turn early with the partial buffer, and
    // the dying child's later close must not overwrite that result.
    const settle = (result) => {
      if (settled) return false;
      settled = true;
      resolve(result);
      return true;
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => settle({ code, stdout: out, stderr: err }));
    child.on("error", (e) => settle({ code: -1, stdout: out, stderr: String(e?.message || e) }));
    // Hand the live child (plus its buffered output and an early-settle) back to
    // the adapter. Without this the child stays local to this promise and
    // cancel() has nothing to signal - the bug the run-context decision calls out.
    if (typeof onSpawn === "function") onSpawn({ child, partial: () => out, settle });
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** Last ~600 chars of a stream, trimmed — where a CLI puts its failure. */
function tailOf(text) {
  const s = String(text ?? "").trim();
  return s.length > 600 ? `…${s.slice(-600)}` : s;
}

export class CodexAdapter {
  constructor(opts = {}) {
    this.id = "codex";
    this._runExec = opts.runExec ?? defaultRunExec; // injectable for tests
    this._pending = new WeakMap();
  }

  async spawn(config = {}) {
    // codex exec is per-turn one-shot; the "session" carries config.
    const effort = config.effort ?? null;
    return {
      config: { ...config },
      alive: true,
      model: config.model ?? null,
      effort,
      // A configured effort is applied by buildExecArgs on every `codex exec`.
      // Keep the explicit boolean so route evidence can distinguish "requested
      // and applied" from runtimes that merely retain an unsupported request.
      effortApplied: effort != null,
      // Cancel bookkeeping - the in-flight child (parked per turn by sendTurn) and
      // the user's Stop intent. Declared here so the session shape is honest.
      proc: null,
      cancelRequested: false,
      // Token usage of the LAST turn, filled by awaitResponse from the
      // turn.completed event. null until a turn reports it - never 0, which
      // would read as "this turn was free".
      usedTokens: null,
      usage: null,
    };
  }

  async awaitReady() {
    /* no persistent process to await */
  }

  async sendTurn(session, text) {
    const { bin, argv } = buildExecArgs(session.config);
    // A prior turn's cancel must never leak into this one.
    session.cancelRequested = false;
    session.proc = null;
    this._pending.set(
      session,
      this._runExec({
        bin,
        argv,
        env: session.config.env ?? process.env,
        cwd: session.config.compositionDir,
        stdin: text,
        // Park the live child on the session so cancel() can signal it. An
        // injected runExec that ignores onSpawn leaves session.proc null and
        // cancel() degrades to a documented no-op.
        onSpawn: (proc) => {
          session.proc = proc;
        }
      })
    );
  }

  // Real cancel (2026-07-25 web-channel run-context §9). teardown() never killed
  // anything, so a routed codex turn ran to completion no matter what the user
  // pressed. SIGTERM the stored child, escalate to SIGKILL after a grace, and
  // settle the in-flight turn immediately with whatever codex already printed -
  // a dying process may never flush a close event worth waiting on.
  async cancel(session) {
    const proc = session?.proc ?? null;
    // Nothing running: a no-op that deliberately does NOT set cancelRequested,
    // which would otherwise poison the NEXT turn's awaitResponse.
    if (!proc?.child) return false;
    // Idempotent: a second Stop must not arm a second escalation timer.
    if (session.cancelRequested) return true;
    session.cancelRequested = true;
    const { child } = proc;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    if (childAlive(child)) {
      const timer = setTimeout(() => {
        if (!childAlive(child)) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, CANCEL_GRACE_MS);
      // Never hold the gateway's event loop open on a grace timer.
      timer.unref?.();
    }
    proc.settle?.({ code: -1, stdout: proc.partial?.() ?? "", stderr: "cancelled by user" });
    return true;
  }

  async awaitResponse(session) {
    const p = this._pending.get(session);
    if (!p) throw new Error("CodexAdapter: awaitResponse without a pending sendTurn");
    this._pending.delete(session);
    const r = await p;
    session.proc = null;
    // stdout is a JSONL event stream (`--json`): the reply is the agent_message
    // items, the usage is the closing turn.completed. A stream that yielded no
    // JSON at all (older CLI, stubbed exec) falls back to raw stdout, and usage
    // stays UNKNOWN — reported as an absent field, never as zero.
    const parsed = parseCodexJsonl(r.stdout);
    const text = parsed.sawJson ? parsed.text : (r.stdout ?? "");
    session.usedTokens = parsed.usedTokens;
    session.usage = parsed.usage ?? null;
    session.threadId = parsed.threadId ?? null;
    // Provider-reported usage, per API call. The rollout is authoritative because
    // it is the only source that sees subagent threads; the stdout aggregate is
    // the fallback and is TAGGED as such so a reader can tell a complete number
    // from a parent-thread-only one.
    let usageRows = [];
    let usageSource = null;
    if (parsed.threadId) {
      try {
        const roll = readCodexThreadUsage(parsed.threadId, { env: session.config?.env ?? process.env });
        if (roll.complete && roll.rows.length) {
          usageRows = roll.rows;
          usageSource = "codex-rollout";
          session.usageFiles = roll.files;
        }
      } catch {
        /* the rollout is telemetry: never fail a turn over it */
      }
    }
    if (!usageRows.length && parsed.usage) {
      usageRows = [
        {
          source: "codex-stdout",
          callId: parsed.threadId ? `${parsed.threadId}:turn` : null,
          threadId: parsed.threadId ?? null,
          threadSource: "user",
          model: session.model ?? session.config?.model ?? null,
          usage: parsed.usage,
          subagentsInvisible: true,
        },
      ];
      usageSource = "codex-stdout";
    }
    session.usageRows = usageRows;
    const usage = {
      ...(parsed.usedTokens == null ? {} : { usedTokens: parsed.usedTokens }),
      ...(usageRows.length ? { usage: usageRows, usageSource } : {}),
    };
    // A cancelled turn's child was signalled, so it "fails" with only partial
    // output. That is not a runtime error to throw on: settle the turn with the
    // partial text and the explicit stop reason so the caller can badge it.
    if (session.cancelRequested) {
      session.cancelRequested = false;
      return { text, artifacts: [], stoppedReason: "cancelled", ...usage };
    }
    // Report the TAIL of stderr, not the head. `codex exec` opens with a ~200-char
    // banner (workdir / model / provider / sandbox / effort) and puts the actual
    // failure on the LAST line, so a leading slice reliably truncates away the one
    // thing the reader needs — a real "You've hit your usage limit" turned into a
    // bare "codex exec exited 1" with the banner attached.
    if (r.code !== 0) throw new Error(`codex exec exited ${r.code}: ${tailOf(r.stderr) || tailOf(parsed.errorText) || tailOf(parsed.sawJson ? text : r.stdout) || "(no output)"}`);
    return { text, artifacts: [], ...usage };
  }

  async setModel(session, model) {
    // codex model is launch-fixed per exec (config carries it) — set on the session.
    session.config = { ...session.config, model };
    session.model = model ?? null;
  }

  async setEffort(session, effort) {
    session.config = { ...session.config, effort };
    session.effort = effort ?? null;
    session.effortApplied = effort != null;
  }

  async resume(config) {
    return this.spawn({ ...config, resume: true });
  }

  async teardown(session) {
    session.alive = false;
    // Back-compat: teardown has never killed the child (runSecondaryTurn calls it
    // in a `finally` on the happy path, where the exec has already exited) and
    // still doesn't - cancel() is the kill primitive. It does release the handle
    // so a torn-down session never pins a dead child.
    session.proc = null;
  }
}

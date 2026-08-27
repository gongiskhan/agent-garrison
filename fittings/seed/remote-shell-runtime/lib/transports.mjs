// Transport layer for the remote-shell runtime.
//
// A TRANSPORT names a reachable remote machine: an ssh target (host/port/user/
// identity) plus, optionally, a tunnel the ssh connection rides through. The
// only tunnel kind implemented today is `devtunnel` (Microsoft Dev Tunnels —
// the transport keeps a `devtunnel connect <tunnel>` client child alive, which
// maps the tunnel's forwarded port onto 127.0.0.1:<port> on this box). A
// transport with no `via` block is plain direct ssh (Mac Mini, another Linux
// box, ...). Everything above this file (sessions, adapter, UI) is
// transport-agnostic: it asks for ssh argv and never learns how the bytes
// travel.
//
// Direction invariant: connections are strictly OUTBOUND-from-Garrison into
// the remote (`devtunnel connect` dials Microsoft's relay; ssh dials the
// forwarded loopback port). Nothing here listens, and nothing asks the remote
// to dial us back.

import { spawn } from "node:child_process";
import { normalizeForwards } from "./forwards.mjs";
import { classifyTunnel, explainTunnel, probeSshBanner } from "./tunnel-health.mjs";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// explainTunnel lives beside the probe that produces the verdicts it words, but
// it has always been imported from here and its wording is pinned by tests
// against this path.
export { explainTunnel };

const HOME = os.homedir();

function expandHome(p) {
  if (typeof p !== "string") return p;
  return p === "~" ? HOME : p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

export function garrisonHome() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(HOME, ".garrison");
}

// ── Config ──────────────────────────────────────────────────────────────────
//
// Transports come from (first hit wins per name, so composition config can
// override the side file):
//   1. GARRISON_REMOTESHELLRUNTIME_TRANSPORTS — a JSON object, projected from
//      the composition's `transports` config key (a string, because the
//      own-port env projection only carries scalars).
//   2. $GARRISON_HOME/remote-shell/transports.json — machine-local additions.
//
// Shape per transport:
//   {
//     "ssh": { "host": "127.0.0.1", "port": 2222, "user": "ggomes",
//              "identity": "~/.ssh/garrison-remote-shell" },
//     "via": { "devtunnel": { "tunnel": "azr-imvwya5cqhr", "port": 2222 } },
//     "tmuxSession": "csg",
//     "cwd": "~/dev/pnmui-monorepo",
//     "eventsFile": "~/.garrison/events.jsonl",
//     "agentCommand": "cursor-agent",
//     "label": "CSG work",
//     "forwards": [{ "name": "web", "remotePort": 3006, "label": "PNMUI web" }]
//   }

export async function loadTransports(env = process.env) {
  const out = new Map();
  const fromFile = await readTransportsFile();
  for (const [name, t] of Object.entries(fromFile)) out.set(name, t);
  const raw = env.GARRISON_REMOTESHELLRUNTIME_TRANSPORTS;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [name, t] of Object.entries(parsed)) out.set(name, t);
      }
    } catch (err) {
      console.warn(`[remote-shell] transports config is not valid JSON: ${err.message}`);
    }
  }
  const transports = new Map();
  for (const [name, t] of out) {
    const norm = normalizeTransport(name, t);
    if (norm) transports.set(name, norm);
  }
  return transports;
}

async function readTransportsFile() {
  const file = path.join(garrisonHome(), "remote-shell", "transports.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// A leading "-" in a host (or a hostile user string) turns the ssh argv into
// option injection — `-oProxyCommand=` is local RCE.
const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;
const SSH_HOST_RE = /^(?!-)[A-Za-z0-9._-]{1,253}$|^[0-9a-fA-F:]{2,45}$/;

function normalizeTransport(name, t) {
  if (!t || typeof t !== "object" || !t.ssh || typeof t.ssh !== "object") {
    console.warn(`[remote-shell] transport "${name}" has no ssh block — skipped`);
    return null;
  }
  const ssh = {
    host: String(t.ssh.host || "127.0.0.1"),
    port: Number(t.ssh.port || 22),
    user: String(t.ssh.user || os.userInfo().username),
    identity: t.ssh.identity ? expandHome(String(t.ssh.identity)) : null
  };
  if (!SSH_USER_RE.test(ssh.user) || !SSH_HOST_RE.test(ssh.host)) {
    console.warn(`[remote-shell] transport "${name}" has an invalid ssh user/host — skipped`);
    return null;
  }
  const devtunnel = t.via?.devtunnel;
  return {
    name,
    label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : name,
    ssh,
    via: devtunnel
      ? { devtunnel: { tunnel: String(devtunnel.tunnel), port: Number(devtunnel.port || ssh.port) } }
      : null,
    tmuxSession: String(t.tmuxSession || name).replace(/[^A-Za-z0-9_-]/g, "_"),
    cwd: t.cwd ? String(t.cwd) : "~",
    eventsFile: t.eventsFile ? String(t.eventsFile) : "~/.garrison/events.jsonl",
    agentCommand: typeof t.agentCommand === "string" ? t.agentCommand : null,
    // How to bring the agent BACK with its conversation after the storm
    // recovery bounces it (see sessions.mjs #stormRecover). Defaults to the
    // agent command plus its conventional non-interactive resume verb.
    agentResumeCommand: typeof t.agentResumeCommand === "string" && t.agentResumeCommand.trim()
      ? t.agentResumeCommand.trim()
      : (typeof t.agentCommand === "string" && t.agentCommand.trim() ? `${t.agentCommand.trim()} resume` : null),
    // Optional routing-target id (composition policy) that chat-lane turns on a
    // thread bound to this transport should pin, e.g. "csg-work". Consumed by
    // the web channel; the server itself never routes.
    routingTarget: typeof t.routingTarget === "string" && t.routingTarget.trim() ? t.routingTarget.trim() : null,
    // Services on the remote worth reaching from here (a dev server, an API).
    // Each becomes an `ssh -L` channel on the SAME connection - see forwards.mjs
    // for why that keeps the inbound-only invariant.
    forwards: normalizeForwards(t.forwards)
  };
}

// ── ssh argv ────────────────────────────────────────────────────────────────

/** Build the ssh argv prefix for a transport. `pty: true` adds -tt for the
 *  interactive attach; exec channels (tail, tmux control commands) omit it. */
export function sshArgv(transport, { pty = false } = {}) {
  const { ssh } = transport;
  const argv = [
    "-p", String(ssh.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=4",
    "-o", "ConnectTimeout=10"
  ];
  if (ssh.identity) argv.push("-i", ssh.identity, "-o", "IdentitiesOnly=yes");
  if (pty) argv.push("-tt");
  argv.push(`${ssh.user}@${ssh.host}`);
  return argv;
}

/**
 * Run one command on the remote; resolves {code, stdout, stderr}.
 *
 * `input` is written to the command's stdin and closed. It exists so a secret can
 * be delivered without ever appearing in argv, where every other user on either
 * box can read it out of `ps`.
 */
export function sshExec(
  transport,
  remoteCommand,
  { timeoutMs = 15_000, input = null, onStdout = null, onSpawn = null } = {}
) {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...sshArgv(transport), remoteCommand], {
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"]
    });
    // A long remote turn reports progress while it runs; the caller still gets
    // the whole buffer at the end. `onSpawn` hands the child back so a turn can
    // be CANCELLED - killing the local ssh drops the channel, and the remote
    // command dies with its SIGHUP.
    if (typeof onSpawn === "function") onSpawn(child);
    if (input !== null) {
      child.stdin.on("error", () => { /* remote closed early; the exit code tells the story */ });
      child.stdin.end(input);
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      resolve({ code: null, stdout, stderr: stderr + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (onStdout) { try { onStdout(d.toString("utf8")); } catch { /* a consumer error must not kill the turn */ } }
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err) });
    });
  });
}


// ── devtunnel client management ─────────────────────────────────────────────

// The cadence, and why each number is what it is.
//
// TICK_MS mirrors host-tunnel.sh's 20s supervisor loop for the same reason: it
// is short enough that an outage is measured in tens of seconds and long enough
// that the relay is not being interrogated. MISSES_BEFORE_ACT is that script's
// rule verbatim - one miss can be an unlucky read, two is a dead leg.
const TICK_MS = 20_000;
const PARKED_TICK_MS = 60_000;
const MISSES_BEFORE_ACT = 2;
const BANNER_CONNECT_MS = 1_500;
const BANNER_READ_MS = 4_000;
const CONFIRM_EXEC_MS = 12_000;
// Strictly under TICK_MS, so one tick can never overrun into the next.
const SERVICE_TIMEOUT_MS = 10_000;
/** Settle window for a caller a human is waiting on. */
export const SETTLE_REQUEST_MS = 20_000;
/** Settle window off the request path. A hand-run `devtunnel connect` was
 *  observed silent for 45s before it settled; the old fixed 10s killed exactly
 *  that client and made every retry start from zero. */
export const SETTLE_SUPERVISOR_MS = 45_000;
const SETTLE_EXTEND_MS = 10_000;
const SETTLE_CAP_MS = 90_000;
const BRINGUP_GRACE_MS = 60_000;
const REPAIR_BACKOFF_MS = [0, 30_000, 60_000, 120_000, 300_000];
const UNKNOWN_REPAIR_LIMIT = 2;
const HEALTH_TTL_MS = 15_000;
const REAP_TIMEOUT_MS = 2_000;
const RETIRE_SIGKILL_MS = 2_000;
// After SIGKILL, how long to wait for the port to actually come free before a
// replacement is spawned into it.
const RETIRE_REAP_GRACE_MS = 750;
const NOTIFY_REPEAT_MS = 30 * 60_000;
// A tunnel id reaches us as a bare String() out of transport config and ends up
// in a process matcher. Anchored and bounded here so an id of ".*" cannot.
const TUNNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,60}$/;

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else - still alive.
    return err?.code === "EPERM";
  }
}

export function resolveDevtunnelBin(env = process.env) {
  const configured = env.GARRISON_REMOTESHELLRUNTIME_DEVTUNNEL_BIN?.trim();
  if (configured) return expandHome(configured);
  const local = path.join(HOME, ".local", "bin", "devtunnel");
  return existsSync(local) ? local : "devtunnel";
}

/** Run a short-lived CLI and collect its output. */
function runTool(spawnFn, bin, argv, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("close", finish);
    child.on("error", (err) => { stderr += String(err); finish(null); });
  });
}

/**
 * Ask the tunnel SERVICE what it knows about a tunnel.
 *
 * WHY THIS EXISTS. `devtunnel connect` against a tunnel nobody is hosting does
 * not fail - it waits, silently, forever. So a timeout on the local forward
 * cannot tell "the remote stopped hosting" from "this box is not logged in",
 * and a message that hedged between the two sent a real debugging session to
 * re-login on BOTH machines when the answer was neither. One cheap query
 * against the service settles it.
 */
export async function describeTunnel(tunnelId, { bin = "devtunnel", timeoutMs = 15_000, spawnFn = spawn } = {}) {
  const result = await runTool(spawnFn, bin, ["show", tunnelId, "--json"], timeoutMs);
  const text = `${result.stdout}\n${result.stderr}`;
  // The CLI prints a first-run banner ahead of the JSON, so parse from the brace
  // rather than from byte zero.
  const start = result.stdout.indexOf("{");
  if (start >= 0) {
    try {
      const tunnel = JSON.parse(result.stdout.slice(start))?.tunnel;
      if (tunnel) {
        return {
          ok: true,
          hostConnections: Number(tunnel.hostConnections) || 0,
          ports: (tunnel.ports ?? []).map((p) => Number(p.portNumber)).filter(Number.isFinite)
        };
      }
    } catch {
      /* not JSON after all - fall through to the text-shaped answers */
    }
  }
  // Two shapes of the same problem, and the CLI picks between them per command:
  // `list` says "Login required.", `show` says "Login token expired." A GitHub
  // login here lasts under a day, so EXPIRED is the common one - and matching
  // only "required" sent it to the unknown branch, which told the reader to go
  // debug a client that was never the problem.
  if (/login token expired|token (?:has )?expired|login expired/i.test(text)) {
    return { ok: false, reason: "login", expired: true };
  }
  if (/login required|not logged in|unauthorized|401/i.test(text)) {
    return { ok: false, reason: "login", expired: false };
  }
  if (/not found|does not exist|404/i.test(text)) return { ok: false, reason: "missing" };
  return { ok: false, reason: "unknown", detail: text.trim().slice(-300) };
}

/**
 * Keeps `devtunnel connect <tunnel>` children alive for every transport that
 * rides a devtunnel - and, unlike the version this replaces, knows the
 * difference between a live child and a working forward.
 *
 * THE MISTAKE THIS CLASS USED TO MAKE, at three altitudes at once. Health was
 * a TCP connect, which a listener with a full accept queue passes without ever
 * servicing anything. Nothing re-asked on a timer, so a leg that died between
 * requests stayed dead until a human noticed. And the redial did not redial:
 * ensure() called #startClient BEFORE #retireClient, and #startClient skips a
 * live child - so the repair path spawned nothing, waited out its window
 * against the client that was already broken, and reported failure.
 *
 * All three are the same error the host side made first (scripts/host-tunnel.sh)
 * and answers the same way: ask for EVIDENCE, on a loop, and act on two
 * consecutive misses rather than on one.
 *
 * The one policy carried over unchanged: a HEALTHY port with no child of ours is
 * left alone. The user may be running `devtunnel connect` by hand and another
 * instance may own it; the port working is the contract, not our owning the
 * process. What changed is that "healthy" now means something.
 */
export class TunnelManager {
  constructor({ env = process.env, spawnFn = spawn, exec = sshExec, notify = null, log = console } = {}) {
    this.env = env;
    this.spawnFn = spawnFn;
    this.exec = exec;
    this.notify = notify;
    this.log = log;
    this.bin = resolveDevtunnelBin(env);
    this.profile = env.GARRISON_INSTANCE_ID?.trim() || path.basename(garrisonHome());
    this.reapEnabled = String(env.GARRISON_REMOTESHELLRUNTIME_REAP_STRAYS ?? "true").toLowerCase() !== "false";
    this.children = new Map(); // tunnelId -> {child, startedAt, restarts, bringUpUntil, lastOutputAt, tail()}
    this.lastError = new Map(); // tunnelId -> string
    this.health = new Map(); // tunnelId -> {state, lastOkAt, lastProbeAt, misses, detail}
    this.parked = new Map(); // tunnelId -> {reason, since, at, message}
    this.backoff = new Map(); // tunnelId -> {index, nextAttemptAt}
    this.inflight = new Map(); // tunnelId -> Promise (the repair lock)
    this.quiesced = new Set(); // storm path asked us not to act
    this.ticking = new Set(); // one tick per tunnel at a time
    this.unknownRepairs = new Map();
    this.lastService = new Map();
    this.notified = new Map();
    this.locks = new Map(); // tunnelId -> lockfile path we hold
    this.supervised = [];
    this.supervisor = null;
    this.tickIntervalMs = TICK_MS;
    /** Set by the server: (transport) => void, fired on a down→up transition. */
    this.onRecovered = null;
  }

  // ── Cheap truths the hot paths can consult ────────────────────────────────

  /**
   * Synchronous, never dials. The hot paths (attach, reattach, storm recovery)
   * need an answer without awaiting a probe, and a stale "yes" here is harmless
   * because everything downstream still has its own timeout.
   */
  healthy(transport) {
    const dt = transport?.via?.devtunnel;
    if (!dt) return true; // a direct-ssh box has no tunnel to be sick
    const h = this.health.get(dt.tunnel);
    return Boolean(h?.lastOkAt && Date.now() - h.lastOkAt < HEALTH_TTL_MS);
  }

  /**
   * Real bytes moved. Stronger evidence than any synthetic probe, and the
   * reason a busy transport is never probed at all - the supervisor skips a
   * tunnel that has carried traffic inside the last tick.
   */
  noteTraffic(transport) {
    const dt = transport?.via?.devtunnel;
    if (!dt) return;
    if (this.#markUp(dt.tunnel, "traffic")) this.#fireRecovered(transport);
  }

  /**
   * Something that should have crossed the tunnel timed out. Jump straight to
   * the acting threshold instead of waiting out two more ticks: a timed-out
   * exec is stronger evidence than a missed probe, and every tick spent
   * confirming is another turn hanging on a link that is already gone.
   */
  markSuspect(transport) {
    const dt = transport?.via?.devtunnel;
    if (!dt) return;
    const h = this.health.get(dt.tunnel) ?? {};
    this.health.set(dt.tunnel, {
      ...h,
      state: "suspect",
      lastOkAt: 0,
      lastProbeAt: h.lastProbeAt ?? 0,
      misses: MISSES_BEFORE_ACT
    });
  }

  /** Is a repair actually in progress right now? Deliberately narrower than
   *  "unhealthy": the session pulse pauses for an ACKNOWLEDGED repair, and
   *  pausing it on a merely-failed probe would blind the storm detector exactly
   *  when a storm is what made the probe fail. */
  repairing(transport) {
    const dt = transport?.via?.devtunnel;
    return Boolean(dt && this.inflight.has(dt.tunnel));
  }

  /** The storm path asks for a pause: replacing a client while the link is
   *  saturated adds load to the exact thing that is failing. */
  quiesce(transport, on = true) {
    const dt = transport?.via?.devtunnel;
    if (!dt) return;
    if (on) this.quiesced.add(dt.tunnel);
    else this.quiesced.delete(dt.tunnel);
  }

  // ── ensure(): one repair at a time, on evidence ───────────────────────────

  /**
   * Confirm the transport's ssh endpoint is reachable, repairing the tunnel
   * client if it is not. Never throws; the shape ({ok, error}) is what five
   * call sites already read.
   */
  async ensure(transport, opts = {}) {
    const dt = transport.via?.devtunnel;
    if (!dt) return { ok: true, via: "direct" };
    const id = dt.tunnel;

    // A second concurrent repair would race two `devtunnel connect` processes
    // onto one loopback port and turn a one-listener outage into a two-client
    // fight. Callers await the first answer instead.
    const pending = this.inflight.get(id);
    if (pending) {
      const waitMs = Number(opts.settleMs) > 0 ? Number(opts.settleMs) : SETTLE_REQUEST_MS;
      return await Promise.race([pending, this.#pendingTimeout(id, waitMs)]);
    }

    const run = this.#ensureNow(transport, dt, opts).catch((err) => ({
      ok: false,
      via: "devtunnel",
      error: `tunnel check for ${id} failed unexpectedly: ${err?.message ?? String(err)}`
    }));
    this.inflight.set(id, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(id);
    }
  }

  #pendingTimeout(tunnelId, waitMs) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({
        ok: false,
        via: "devtunnel",
        retryable: true,
        // Deliberately does NOT cancel the in-flight repair: the caller giving
        // up is not a reason to abandon work that may be seconds from settling.
        error: `devtunnel ${tunnelId} is being repaired right now and has not settled within ${Math.round(waitMs / 1000)}s. Retry shortly.`
      }), waitMs);
      t.unref?.();
    });
  }

  async #ensureNow(transport, dt, { settleMs = SETTLE_REQUEST_MS, reason = "demand" } = {}) {
    const id = dt.tunnel;
    const now = Date.now();

    if (this.healthy(transport)) {
      return { ok: true, via: "devtunnel", running: this.children.has(id) };
    }

    // Bring-up grace. A client started seconds ago has not failed yet, and
    // killing it here is precisely what made every retry restart from zero.
    // The demand path is eager but never destructive; only the settle window of
    // the call that started a client may retire it.
    const rec = this.children.get(id);
    if (rec && rec.child.exitCode === null && (rec.bringUpUntil ?? 0) > now) {
      const early = await this.#probe(transport);
      if (early.state === "up") return this.#reportUp(transport, dt, "probe");
      return {
        ok: false,
        via: "devtunnel",
        retryable: true,
        error: `the devtunnel client for ${id} started ${Math.round((now - rec.startedAt) / 1000)}s ago and is still coming up (${early.detail ?? early.state}). It has NOT been killed; retry.`
      };
    }

    const probe = await this.#probe(transport);
    if (probe.state === "up") return this.#reportUp(transport, dt, "probe");
    if (probe.state === "foreign") {
      // Never spawn and never kill over a port somebody else owns. This is the
      // same hazard forwards.mjs guards when it refuses to bind a taken port.
      return {
        ok: false,
        via: "devtunnel",
        probe,
        error: `127.0.0.1:${transport.ssh.port} is answering, but not as ssh (it said ${JSON.stringify(probe.head)}). Something other than the devtunnel client owns that port on this box - stop it, or repoint the transport. Nothing was started or killed.`
      };
    }

    // A park is a standing answer, so serve it from cache rather than paying a
    // service query per request. The supervisor refreshes it once a minute.
    const parked = this.parked.get(id);
    if (parked && now - parked.at < PARKED_TICK_MS) {
      return { ok: false, via: "devtunnel", parked: parked.reason, error: parked.message };
    }

    const info = await describeTunnel(id, {
      bin: this.bin,
      spawnFn: this.spawnFn,
      timeoutMs: SERVICE_TIMEOUT_MS
    });
    this.lastService.set(id, info);
    const verdict = classifyTunnel(info, dt);

    if (verdict.action === "park") {
      return { ok: false, via: "devtunnel", tunnel: info, parked: verdict.reason, error: this.#park(transport, dt, verdict) };
    }
    if (verdict.action === "unknown") {
      // The old code's silent `return null` here read as PERMISSION TO PROCEED,
      // so the least-informed case was the most eager one - and a saturated
      // uplink is exactly what makes `devtunnel show` time out. Cap the tries.
      const tries = (this.unknownRepairs.get(id) ?? 0) + 1;
      this.unknownRepairs.set(id, tries);
      if (tries > UNKNOWN_REPAIR_LIMIT) {
        const message = `devtunnel ${id} is unreachable and the service will not say why (${info.detail ? info.detail.slice(-160) : "the query timed out"}). ${UNKNOWN_REPAIR_LIMIT} client replacements changed nothing, so no more will be attempted until it answers. Check this box's network and \`devtunnel user login -g -d\`.`;
        return { ok: false, via: "devtunnel", tunnel: info, parked: "unknown", error: this.#park(transport, dt, { reason: "unknown", message }) };
      }
    }

    const back = this.backoff.get(id);
    if (back && now < back.nextAttemptAt) {
      return {
        ok: false,
        via: "devtunnel",
        retryable: true,
        error: `${probe.detail ?? `the forward for ${id} is not carrying`}. The last ${back.index} replacement(s) did not fix it, so the next attempt is held off until ${new Date(back.nextAttemptAt).toISOString()}.`
      };
    }

    return await this.#repair(transport, dt, { settleMs, info, probe, reason });
  }

  /** Operator lever behind POST /tunnels/:id/repair: everything hysteresis and
   *  backoff would otherwise delay, now, without bypassing the one-at-a-time
   *  lock. Before this existed the only way out of a wedge was restarting the
   *  whole fitting - which is what both observed outages actually required. */
  async repair(transport, { settleMs = SETTLE_SUPERVISOR_MS } = {}) {
    const dt = transport.via?.devtunnel;
    if (!dt) return { ok: true, via: "direct" };
    const id = dt.tunnel;
    this.backoff.delete(id);
    this.parked.delete(id);
    this.unknownRepairs.delete(id);
    this.health.delete(id);
    const pending = this.inflight.get(id);
    if (pending) return await pending;
    const run = this.#repair(transport, dt, { settleMs, info: this.lastService.get(id) ?? null, reason: "operator" })
      .catch((err) => ({ ok: false, via: "devtunnel", error: `repair failed: ${err?.message ?? String(err)}` }));
    this.inflight.set(id, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(id);
    }
  }

  async #repair(transport, dt, { settleMs, info, probe = null, reason = "demand" }) {
    const id = dt.tunnel;
    const claim = this.#claimTunnel(id);
    if (!claim.ok) return { ok: false, via: "devtunnel", error: claim.error };

    // ORDER IS THE WHOLE FIX. Reap first, so a client orphaned by an earlier
    // process (children starts empty on every boot, so it is invisible to every
    // check in this class) cannot keep holding the port. Retire second, because
    // #startClient skips a live child - with these two swapped the "repair"
    // spawned nothing at all and only waited.
    await this.#reapStrays(id);
    // Awaited, not fired: the successor must not race the corpse for the port.
    await this.#retireClient(id);
    this.#startClient(id);

    this.log.warn?.(`[remote-shell] replacing the devtunnel client for ${id} (${reason}): ${probe?.detail ?? probe?.state ?? "no forward"}`);

    const settled = await this.#waitForForward(transport, settleMs);
    if (settled.ok) return this.#reportUp(transport, dt, "repair");

    this.#armBackoff(id);
    const rec = this.children.get(id);
    // Retire ONLY a client that never said one word. A client still printing is
    // a client still working, and killing it at a fixed deadline is what
    // punished a merely-slow relay; one still silent after its whole (progress
    // -extended) window is providing nothing and does not exit on its own.
    let retired = false;
    if (rec && rec.child.exitCode === null && !rec.lastOutputAt) {
      void this.#retireClient(id);
      retired = true;
    }
    const tail = (rec?.tail?.() ?? "").trim().slice(-400);
    const hosted = info?.ok ? `${info.hostConnections} host connection(s)` : "unknown host state";
    // `settled.exited` is the difference between "still working, be patient"
    // and "already dead" - reporting a corpse as still printing sends the
    // reader looking for a process that is not there.
    const verdictSentence = settled.exited
      ? "The client exited on its own before the forward ever came up; retry, and if it recurs run"
      : retired
        ? "The wedged client has been retired; retry, and if it recurs run"
        : "The client is still printing, so it has been left running and the next attempt is backed off; to watch it yourself run";
    const message =
      `devtunnel ${id} reports ${hosted}, but the local forward for port ${dt.port} never came up on 127.0.0.1:${transport.ssh.port}. ` +
      `${verdictSentence} \`devtunnel connect ${id}\` by hand to see what it waits on.` +
      (tail ? ` Last output from the client: ${tail}` : "");
    this.#notifyOnce(id, message, transport);
    return { ok: false, via: "devtunnel", tunnel: info, error: message };
  }

  /**
   * Wait for the forward to carry, on a deadline that PROGRESS extends.
   *
   * The old form was `for (i < 20) { sleep(500); connect? }` - a fixed ten
   * seconds that could neither notice the child had already died (it slept out
   * the full window anyway) nor give a slow-but-working client more room.
   */
  async #waitForForward(transport, settleMs) {
    const id = transport.via.devtunnel.tunnel;
    const startedAt = Date.now();
    const cap = startedAt + SETTLE_CAP_MS;
    let deadline = startedAt + Math.max(2_000, Number(settleMs) || SETTLE_REQUEST_MS);
    let last = null;
    for (;;) {
      const rec = this.children.get(id);
      if (!rec || rec.child.exitCode !== null) {
        return { ok: false, probe: last, exited: true };
      }
      const probe = await this.#probe(transport);
      last = probe;
      if (probe.state === "up") return { ok: true, probe };
      if (rec.lastOutputAt && Date.now() - rec.lastOutputAt < SETTLE_EXTEND_MS) {
        deadline = Math.min(cap, Math.max(deadline, Date.now() + SETTLE_EXTEND_MS));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, probe };
      await sleep(Math.min(1_000, Math.max(100, remaining)));
    }
  }

  // ── Client children ───────────────────────────────────────────────────────

  /**
   * Kill a client that is carrying nothing, so the next try is fresh.
   *
   * SIGTERM then SIGKILL, and the record is dropped only on a CONFIRMED exit: a
   * wedged `devtunnel connect` is exactly the process that may ignore SIGTERM,
   * and forgetting it while it still runs is how one ended up ten hours old,
   * holding no forward, invisible to every check here.
   */
  /**
   * Retire the client for a tunnel. Returns a promise that settles only when
   * the child is CONFIRMED gone.
   *
   * The promise is the point. SIGTERM returns long before the process does, and
   * the dying client still owns 127.0.0.1:<port> while it goes - so a
   * replacement spawned in the same synchronous block races it for the bind and
   * loses, which is precisely how a "repair" managed to kill a wedged client
   * and then fail to replace it. Callers that only want the kill can ignore the
   * promise; the one that spawns the successor must await it.
   */
  #retireClient(tunnelId) {
    const rec = this.children.get(tunnelId);
    if (!rec) return Promise.resolve();
    const forget = () => {
      if (this.children.get(tunnelId) === rec) this.children.delete(tunnelId);
    };
    if (rec.child.exitCode !== null) {
      forget();
      return Promise.resolve();
    }
    rec.retiring = true;
    if (rec.retired) return rec.retired;
    rec.retired = new Promise((resolve) => {
      const done = () => { forget(); resolve(); };
      try { rec.child.kill("SIGTERM"); } catch { /* already gone */ }
      if (rec.child.exitCode !== null) return void done();
      const escalate = setTimeout(() => {
        if (rec.child.exitCode === null) {
          try { rec.child.kill("SIGKILL"); } catch {}
        }
        // SIGKILL is not instantaneous either, and a process that ignored
        // SIGTERM may have no 'close' left to emit here; resolve on a short
        // grace so a repair can never wedge on a corpse.
        setTimeout(done, RETIRE_REAP_GRACE_MS).unref?.();
      }, RETIRE_SIGKILL_MS);
      escalate.unref?.();
      rec.child.once?.("close", () => {
        clearTimeout(escalate);
        done();
      });
    });
    return rec.retired;
  }

  #startClient(tunnelId) {
    const existing = this.children.get(tunnelId);
    // `!retiring` matters: a retire whose SIGTERM has not been acknowledged yet
    // still holds the record, and skipping on it would make the repair a no-op
    // for the second time in this file's history.
    if (existing && existing.child.exitCode === null && !existing.retiring) return;
    // this.spawnFn, not spawn: the client's lifecycle is the half of this class
    // that keeps going wrong, so it has to be reachable by a test.
    const child = this.spawnFn(this.bin, ["connect", tunnelId], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false
    });
    let tail = "";
    const rec = {
      child,
      startedAt: Date.now(),
      restarts: existing ? existing.restarts + 1 : 0,
      bringUpUntil: Date.now() + BRINGUP_GRACE_MS,
      lastOutputAt: 0,
      tail: () => tail
    };
    this.children.set(tunnelId, rec);
    const keepTail = (d) => {
      // Doubles as the progress signal #waitForForward extends its deadline on.
      rec.lastOutputAt = Date.now();
      tail = (tail + d.toString("utf8")).slice(-2000);
    };
    child.stdout?.on("data", keepTail);
    child.stderr?.on("data", keepTail);
    child.on("close", (code) => {
      // Our own SIGTERM is not a diagnosis. Recording it would overwrite the real
      // reason with "devtunnel connect exited (code 0)" and hide it from the
      // message the user reads.
      if (rec.retiring) return;
      this.lastError.set(tunnelId, `devtunnel connect exited (code ${code}): ${tail.trim().slice(-500)}`);
    });
    child.on("error", (err) => {
      this.lastError.set(tunnelId, `devtunnel spawn failed: ${err.message}`);
    });
  }

  /**
   * The missing counterpart of host-tunnel.sh's reap_strays, and the only thing
   * that can recover a client orphaned across a fitting restart: `children`
   * starts empty on every boot, so an inherited process is invisible both to
   * #startClient's skip and to #retireClient's lookup.
   *
   * Reachable ONLY from the repair branch. A healthy port is hands-off - it may
   * be another instance's client or a hand-run one, and the port working is the
   * contract.
   */
  async #reapStrays(tunnelId) {
    if (!this.reapEnabled) return;
    if (!TUNNEL_ID_RE.test(tunnelId)) {
      this.log.warn?.(`[remote-shell] refusing to reap for an implausible tunnel id ${JSON.stringify(tunnelId)}`);
      return;
    }
    const owned = this.children.get(tunnelId)?.child?.pid;
    const listed = await runTool(this.spawnFn, "pgrep", ["-af", "devtunnel"], REAP_TIMEOUT_MS);
    for (const line of String(listed.stdout ?? "").split("\n")) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmdline = m[2];
      // Matched in JS rather than delegated to a `pgrep -f` pattern, because
      // `devtunnel host` may legitimately run on this same box and must never
      // be reaped by the client leg.
      if (!/(?:^|\/|\s)devtunnel(?:\s|$)/.test(cmdline)) continue;
      if (!/(?:^|\s)connect(?:\s|$)/.test(cmdline)) continue;
      if (!cmdline.includes(tunnelId)) continue;
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || pid === owned) continue;
      // Logged with the full cmdline, or the next debugging session loses an
      // hour to "something keeps killing my terminal".
      this.log.warn?.(`[remote-shell] reaping stray devtunnel client pid ${pid}: ${cmdline}`);
      try { process.kill(pid, "SIGTERM"); } catch { /* gone, or not ours to signal */ }
    }
  }

  /**
   * One owner per tunnel, across PROFILES. GARRISON_HOME is per-profile, so a
   * lock under it cannot see the instance it is meant to arbitrate against;
   * tmpdir is the only place both can look. Two profiles configured for one
   * tunnel is already broken - one loopback port cannot serve two owners - and
   * this makes it say so instead of thrashing.
   */
  #claimTunnel(tunnelId) {
    if (this.locks.has(tunnelId)) return { ok: true };
    const file = path.join(os.tmpdir(), `garrison-remote-shell-tunnel-${tunnelId.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
    const mine = JSON.stringify({ pid: process.pid, profile: this.profile, claimedAt: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, mine, { flag: "wx", mode: 0o600 });
        this.locks.set(tunnelId, file);
        return { ok: true };
      } catch (err) {
        // A lock we cannot write is a bookkeeping failure, not a reason to
        // leave the tunnel down.
        if (err?.code !== "EEXIST") return { ok: true };
        let holder = null;
        try { holder = JSON.parse(readFileSync(file, "utf8")); } catch { /* unreadable = stale */ }
        const pid = Number(holder?.pid);
        if (pid === process.pid || !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) {
          try { unlinkSync(file); } catch {}
          continue;
        }
        return {
          ok: false,
          error: `devtunnel ${tunnelId} is held by the "${holder?.profile ?? "unknown"}" Garrison instance (pid ${pid}) on this box, so this instance will not replace its client. Point one of them at a different composition.`
        };
      }
    }
    return { ok: true };
  }

  // ── Supervision: nothing used to re-ask ───────────────────────────────────

  /**
   * The loop this side never had. host-tunnel.sh asks the service every 20s and
   * replaces its child on two consecutive misses; here there was no timer at
   * all, so a leg that died between requests stayed dead until a human noticed.
   *
   * Starts only when something actually rides a devtunnel, so a direct-ssh or
   * unconfigured install supervises nothing (Rule 6). Returns whether it armed.
   */
  startSupervision({ transports = [], intervalMs = TICK_MS } = {}) {
    this.stopSupervision();
    const list = [...transports].filter((t) => t?.via?.devtunnel);
    if (list.length === 0 || !(Number(intervalMs) > 0)) return false;
    this.supervised = list;
    this.tickIntervalMs = Number(intervalMs);
    this.supervisor = setInterval(() => {
      void this.tickOnce().catch((err) => this.log.warn?.(`[remote-shell] tunnel tick failed: ${err?.message ?? err}`));
    }, this.tickIntervalMs);
    this.supervisor.unref?.();
    return true;
  }

  stopSupervision() {
    if (this.supervisor) {
      clearInterval(this.supervisor);
      this.supervisor = null;
    }
  }

  /** Public so a test drives the loop directly; the interval only calls this. */
  async tickOnce() {
    const byTunnel = new Map();
    for (const t of this.supervised) {
      const id = t.via?.devtunnel?.tunnel;
      if (!id) continue;
      if (!byTunnel.has(id)) byTunnel.set(id, []);
      byTunnel.get(id).push(t);
    }
    for (const [id, group] of byTunnel) {
      await this.#tickTunnel(id, group).catch?.(() => {});
    }
  }

  async #tickTunnel(tunnelId, group) {
    // A tick can outlive its interval: a wedged probe waits out the banner
    // deadline and the confirm exec waits out its own. Overlapping ticks then
    // ALL read `misses` before any of them writes it, so the count never
    // reaches two and the supervisor watches a dead tunnel forever without
    // ever acting. (Found by driving the loop faster than one probe.)
    if (this.ticking.has(tunnelId)) return;
    this.ticking.add(tunnelId);
    try {
      await this.#tickTunnelOnce(tunnelId, group);
    } finally {
      this.ticking.delete(tunnelId);
    }
  }

  async #tickTunnelOnce(tunnelId, group) {
    const now = Date.now();
    if (this.inflight.has(tunnelId)) return;
    if (this.quiesced.has(tunnelId)) return;
    const health = this.health.get(tunnelId);
    // Traffic inside the last tick already proved the leg; probing it again is
    // load on a link that may be exactly what is struggling.
    if (health?.lastOkAt && now - health.lastOkAt < this.tickIntervalMs) return;
    const back = this.backoff.get(tunnelId);
    if (back && now < back.nextAttemptAt) return;
    const rec = this.children.get(tunnelId);
    if (rec && rec.child.exitCode === null && (rec.bringUpUntil ?? 0) > now) return;
    const parked = this.parked.get(tunnelId);
    if (parked) {
      if (now - (parked.tickedAt ?? 0) < PARKED_TICK_MS) return;
      parked.tickedAt = now;
      // Still probed, deliberately: when the remote's own supervisor brings the
      // host back, the existing client re-establishes and we unpark for free.
    }

    // A tunnel is unhealthy only when EVERY transport riding it fails. If one
    // forward carries, the client is demonstrably working, and replacing it to
    // chase a dead remote SERVICE would take the working forward down too.
    let worst = null;
    for (const transport of group) {
      const probe = await this.#probe(transport);
      if (probe.state === "up") {
        if (this.#markUp(tunnelId, "probe")) for (const t of group) this.#fireRecovered(t);
        return;
      }
      if (!worst || probe.state === "wedged") worst = { transport, probe };
    }
    if (!worst) return;

    const misses = (this.health.get(tunnelId)?.misses ?? 0) + 1;
    this.health.set(tunnelId, {
      ...(this.health.get(tunnelId) ?? {}),
      state: worst.probe.state,
      lastProbeAt: now,
      lastOkAt: 0,
      misses,
      detail: worst.probe.detail ?? null
    });
    // One miss can be an unlucky read; two is a dead leg. host-tunnel.sh's rule.
    if (misses < MISSES_BEFORE_ACT) return;

    // Confirm with something strictly stronger than the banner before doing
    // anything destructive: a successful exec proves auth and the remote's sshd
    // too. This is the guard against bouncing a working tunnel.
    const confirm = await this.exec(worst.transport, "true", { timeoutMs: CONFIRM_EXEC_MS });
    if (confirm.code === 0) {
      if (this.#markUp(tunnelId, "confirm-exec")) for (const t of group) this.#fireRecovered(t);
      return;
    }
    await this.ensure(worst.transport, { settleMs: SETTLE_SUPERVISOR_MS, reason: "supervisor" });
  }

  // ── Bookkeeping ───────────────────────────────────────────────────────────

  #probe(transport) {
    return probeSshBanner(transport.ssh.host, transport.ssh.port, {
      connectMs: BANNER_CONNECT_MS,
      readMs: BANNER_READ_MS
    }).then((probe) => {
      const dt = transport.via?.devtunnel;
      if (dt && probe.state !== "up") {
        const h = this.health.get(dt.tunnel) ?? {};
        this.health.set(dt.tunnel, { ...h, state: probe.state, lastProbeAt: Date.now(), lastOkAt: 0, detail: probe.detail ?? null, misses: h.misses ?? 0 });
      }
      return probe;
    });
  }

  #markUp(tunnelId, reason) {
    const prev = this.health.get(tunnelId);
    const now = Date.now();
    this.health.set(tunnelId, { state: "up", lastOkAt: now, lastProbeAt: now, misses: 0, detail: null, reason });
    this.backoff.delete(tunnelId);
    this.unknownRepairs.delete(tunnelId);
    this.parked.delete(tunnelId);
    return !prev || prev.state !== "up";
  }

  #reportUp(transport, dt, reason) {
    const wasDown = this.#markUp(dt.tunnel, reason);
    if (wasDown) {
      this.log.log?.(`[remote-shell] devtunnel ${dt.tunnel} is carrying again (${reason})`);
      this.#notifyOnce(dt.tunnel, `the tunnel to ${transport.label ?? transport.name} is carrying again.`, transport);
      this.#fireRecovered(transport);
    }
    return { ok: true, via: "devtunnel", running: this.children.has(dt.tunnel) };
  }

  #fireRecovered(transport) {
    if (typeof this.onRecovered !== "function") return;
    try { this.onRecovered(transport); } catch { /* a consumer must not break a repair */ }
  }

  #armBackoff(tunnelId) {
    const prev = this.backoff.get(tunnelId);
    const index = Math.min((prev?.index ?? 0) + 1, REPAIR_BACKOFF_MS.length - 1);
    this.backoff.set(tunnelId, { index, nextAttemptAt: Date.now() + REPAIR_BACKOFF_MS[index] });
  }

  #park(transport, dt, verdict) {
    const id = dt.tunnel;
    const message = verdict.message
      ?? `devtunnel ${id} cannot be reached and the service gave no usable answer, so no local client will be started for it.`;
    const prev = this.parked.get(id);
    this.parked.set(id, { reason: verdict.reason, since: prev?.since ?? Date.now(), at: Date.now(), tickedAt: Date.now(), message });
    if (!prev) this.log.warn?.(`[remote-shell] parking devtunnel ${id} (${verdict.reason}): ${message}`);
    this.#notifyOnce(id, message, transport);
    return message;
  }

  /** One notify per TRANSITION, deduped on the diagnosis sentence, at most once
   *  per 30 minutes per tunnel. A tunnel down for a day must not page all day
   *  (host-tunnel.sh's `expired_said` pattern, one side over). */
  #notifyOnce(tunnelId, message, transport) {
    if (typeof this.notify !== "function") return;
    const prev = this.notified.get(tunnelId);
    if (prev && prev.message === message && Date.now() - prev.at < NOTIFY_REPEAT_MS) return;
    this.notified.set(tunnelId, { message, at: Date.now() });
    try {
      void Promise.resolve(this.notify({
        title: "Remote tunnel",
        text: `${transport?.label ?? transport?.name ?? tunnelId}: ${message}`,
        actions: [],
        tag: `remote-shell-tunnel:${tunnelId}`,
        idempotencyKey: `remote-shell-tunnel:${tunnelId}:${Date.now()}`,
        link: null
      })).catch(() => {});
    } catch { /* notification must never break a repair */ }
  }

  /**
   * What an operator reads on /health and /tunnels.
   *
   * `alive` is no longer the top-level word, and that is the point: process
   * -table liveness is what reported "healthy" all the way through an outage
   * where the client held no listener at all. It survives nested under `child`,
   * so the endpoint can finally say "child alive, forward wedged" - the
   * sentence the old shape made impossible.
   */
  status() {
    const out = {};
    const ids = new Set([...this.children.keys(), ...this.health.keys(), ...this.parked.keys()]);
    for (const id of ids) {
      const rec = this.children.get(id);
      const h = this.health.get(id);
      const parked = this.parked.get(id);
      const back = this.backoff.get(id);
      out[id] = {
        carrying: Boolean(h?.lastOkAt && Date.now() - h.lastOkAt < HEALTH_TTL_MS),
        state: h?.state ?? "unknown",
        lastOkAt: h?.lastOkAt ? new Date(h.lastOkAt).toISOString() : null,
        lastProbeAt: h?.lastProbeAt ? new Date(h.lastProbeAt).toISOString() : null,
        probeReason: h?.detail ?? null,
        misses: h?.misses ?? 0,
        service: this.lastService.get(id) ?? null,
        parked: parked ? { reason: parked.reason, since: new Date(parked.since).toISOString(), message: parked.message } : null,
        repairing: this.inflight.has(id),
        backoffUntil: back?.nextAttemptAt ? new Date(back.nextAttemptAt).toISOString() : null,
        child: rec
          ? { alive: rec.child.exitCode === null, startedAt: new Date(rec.startedAt).toISOString(), restarts: rec.restarts }
          : null,
        lastError: this.lastError.get(id) ?? null
      };
    }
    return out;
  }

  shutdown() {
    this.stopSupervision();
    for (const rec of this.children.values()) {
      rec.retiring = true;
      try { rec.child.kill("SIGTERM"); } catch {}
    }
    this.children.clear();
    for (const file of this.locks.values()) {
      try { unlinkSync(file); } catch {}
    }
    this.locks.clear();
  }
}

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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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
export function sshExec(transport, remoteCommand, { timeoutMs = 15_000, input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...sshArgv(transport), remoteCommand], {
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"]
    });
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
    child.stdout.on("data", (d) => { stdout += d; });
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

export function resolveDevtunnelBin(env = process.env) {
  const configured = env.GARRISON_REMOTESHELLRUNTIME_DEVTUNNEL_BIN?.trim();
  if (configured) return expandHome(configured);
  const local = path.join(HOME, ".local", "bin", "devtunnel");
  return existsSync(local) ? local : "devtunnel";
}

function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Run a short-lived CLI and collect its output. */
function runTool(spawnFn, bin, argv, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnFn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
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
 * Turn a tunnel description into the one sentence that says what to DO about
 * it, or null when the description gives no reason not to try connecting.
 * Pure, so the wording is pinned by a test rather than by whoever last read a
 * log - this string is the whole user-facing diagnosis.
 */
export function explainTunnel(info, dt) {
  if (info.ok) {
    if (info.hostConnections === 0) {
      return `nothing is hosting devtunnel ${dt.tunnel}: the tunnel exists and this box is logged in, but no machine is running \`devtunnel host\` for it. Start it ON THE REMOTE - \`devtunnel host ${dt.tunnel}\` - then retry. Logging in again here changes nothing.`;
    }
    if (info.ports.length && !info.ports.includes(dt.port)) {
      return `devtunnel ${dt.tunnel} is hosted but forwards no port ${dt.port} (it carries ${info.ports.join(", ")}). Add it on the remote: \`devtunnel port create ${dt.tunnel} -p ${dt.port}\`.`;
    }
    return null;
  }
  if (info.reason === "login") {
    const lede = info.expired
      ? `this box's dev tunnels login has EXPIRED (a GitHub login lasts well under a day), so ${dt.tunnel} cannot be reached`
      : `this box is not logged in to dev tunnels, so ${dt.tunnel} cannot be reached`;
    return `${lede} - run \`devtunnel user login -g -d\` as this user, HERE, not on the remote. (Each Garrison instance redirects XDG_DATA_HOME, so the login must be visible at $XDG_DATA_HOME/DevTunnels; the setup hook links the real store in.)`;
  }
  if (info.reason === "missing") {
    return `devtunnel ${dt.tunnel} does not exist - deleted, or owned by a different account than the one logged in here. Recreate it and repoint the transport.`;
  }
  return null;
}

/**
 * Keeps `devtunnel connect <tunnel>` children alive for every transport that
 * rides a devtunnel. Health = the forwarded loopback port accepts TCP. The
 * child is restarted with capped backoff; a healthy port with no child (e.g.
 * the user runs `devtunnel connect` by hand, or another instance owns it) is
 * left alone — the port working is the contract, not our owning the process.
 */
export class TunnelManager {
  constructor({ env = process.env, spawnFn = spawn } = {}) {
    this.env = env;
    this.spawnFn = spawnFn;
    this.bin = resolveDevtunnelBin(env);
    this.children = new Map(); // tunnelId -> {child, startedAt, restarts}
    this.lastError = new Map(); // tunnelId -> string
  }

  async ensure(transport) {
    const dt = transport.via?.devtunnel;
    if (!dt) return { ok: true, via: "direct" };
    const portUp = await tcpProbe(transport.ssh.host, transport.ssh.port);
    if (portUp) return { ok: true, via: "devtunnel", running: this.children.has(dt.tunnel) };
    // Ask the service BEFORE spawning a client that would wait silently forever
    // on a tunnel nobody hosts. This makes the failure fast as well as honest.
    const info = await describeTunnel(dt.tunnel, { bin: this.bin, spawnFn: this.spawnFn });
    const explained = explainTunnel(info, dt);
    if (explained) return { ok: false, via: "devtunnel", error: explained, tunnel: info };
    this.#startClient(dt.tunnel);
    // Give a fresh client a moment to bring the forward up.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await tcpProbe(transport.ssh.host, transport.ssh.port)) {
        return { ok: true, via: "devtunnel", running: true };
      }
    }
    // A `devtunnel connect` child that never brought the forward up is providing
    // nothing, and it does not exit on its own - the same liveness-is-not-health
    // trap as the host side. Retire it so the next attempt starts clean instead
    // of inheriting a wedged client forever (one was found alive for ten hours,
    // holding no forward, after the credential under it expired).
    this.#retireClient(dt.tunnel);
    const hosted = info.ok ? `${info.hostConnections} host connection(s)` : "unknown host state";
    return {
      ok: false,
      via: "devtunnel",
      tunnel: info,
      error: this.lastError.get(dt.tunnel) ||
        `devtunnel ${dt.tunnel} reports ${hosted}, but the local forward for port ${dt.port} never came up on 127.0.0.1:${transport.ssh.port}. The wedged client has been retired; retry, and if it recurs run \`devtunnel connect ${dt.tunnel}\` by hand to see what it waits on.`
    };
  }

  /** Kill a client that is alive but carrying nothing, so the next try is fresh. */
  #retireClient(tunnelId) {
    const rec = this.children.get(tunnelId);
    if (!rec || rec.child.exitCode !== null) return;
    rec.retiring = true;
    try { rec.child.kill("SIGTERM"); } catch { /* already gone */ }
    this.children.delete(tunnelId);
  }

  #startClient(tunnelId) {
    const existing = this.children.get(tunnelId);
    if (existing && existing.child.exitCode === null) return;
    // this.spawnFn, not spawn: the client's lifecycle is the half of this class
    // that keeps going wrong, so it has to be reachable by a test.
    const child = this.spawnFn(this.bin, ["connect", tunnelId], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false
    });
    const rec = { child, startedAt: Date.now(), restarts: existing ? existing.restarts + 1 : 0 };
    this.children.set(tunnelId, rec);
    let tail = "";
    const keepTail = (d) => {
      tail = (tail + d.toString("utf8")).slice(-2000);
    };
    child.stdout.on("data", keepTail);
    child.stderr.on("data", keepTail);
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

  status() {
    const out = {};
    for (const [tunnelId, rec] of this.children) {
      out[tunnelId] = {
        alive: rec.child.exitCode === null,
        startedAt: new Date(rec.startedAt).toISOString(),
        restarts: rec.restarts,
        lastError: this.lastError.get(tunnelId) ?? null
      };
    }
    return out;
  }

  shutdown() {
    for (const rec of this.children.values()) {
      rec.retiring = true;
      try { rec.child.kill("SIGTERM"); } catch {}
    }
    this.children.clear();
  }
}

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
// option injection — `-oProxyCommand=` is local RCE. Same guards as
// outpost-tailscale-host's config-sync.
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

/** Run one command on the remote; resolves {code, stdout, stderr}. */
export function sshExec(transport, remoteCommand, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...sshArgv(transport), remoteCommand], {
      stdio: ["ignore", "pipe", "pipe"]
    });
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

function resolveDevtunnelBin(env = process.env) {
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

/**
 * Keeps `devtunnel connect <tunnel>` children alive for every transport that
 * rides a devtunnel. Health = the forwarded loopback port accepts TCP. The
 * child is restarted with capped backoff; a healthy port with no child (e.g.
 * the user runs `devtunnel connect` by hand, or another instance owns it) is
 * left alone — the port working is the contract, not our owning the process.
 */
export class TunnelManager {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.bin = resolveDevtunnelBin(env);
    this.children = new Map(); // tunnelId -> {child, startedAt, restarts}
    this.lastError = new Map(); // tunnelId -> string
  }

  async ensure(transport) {
    const dt = transport.via?.devtunnel;
    if (!dt) return { ok: true, via: "direct" };
    const portUp = await tcpProbe(transport.ssh.host, transport.ssh.port);
    if (portUp) return { ok: true, via: "devtunnel", running: this.children.has(dt.tunnel) };
    this.#startClient(dt.tunnel);
    // Give a fresh client a moment to bring the forward up.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await tcpProbe(transport.ssh.host, transport.ssh.port)) {
        return { ok: true, via: "devtunnel", running: true };
      }
    }
    return {
      ok: false,
      via: "devtunnel",
      error: this.lastError.get(dt.tunnel) ||
        `devtunnel forward for ${dt.tunnel}:${dt.port} did not come up - the remote host for this tunnel is not running (or \`devtunnel user login\` is missing on this box)`
    };
  }

  #startClient(tunnelId) {
    const existing = this.children.get(tunnelId);
    if (existing && existing.child.exitCode === null) return;
    const child = spawn(this.bin, ["connect", tunnelId], {
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
      try { rec.child.kill("SIGTERM"); } catch {}
    }
    this.children.clear();
  }
}

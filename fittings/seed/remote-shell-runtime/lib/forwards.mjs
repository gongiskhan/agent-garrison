// Port forwards: reach a service running ON the remote machine from this box.
//
// WHY THIS EXISTS. The remote-shell runtime can drive an agent on another machine,
// but until now you could only read what it SAID. Verifying that the work is
// actually good means opening the app it built - a dev server bound to loopback on
// the remote, which nothing here could reach.
//
// HOW, AND THE INVARIANT IT KEEPS. `ssh -N -L <local>:127.0.0.1:<remote>` over the
// SAME transport the shell already uses. That is strictly OUTBOUND from Garrison:
// we dial the tunnel, the tunnel dials the VM, ssh opens a channel. The remote
// never learns our address and never dials back, and no second tunnel, relay or
// listener is introduced - the forward rides the connection that was already
// there. A transport with no `via` (a plain ssh box) works identically.
//
// THE LOCAL PORT MIRRORS THE REMOTE ONE, and that is not cosmetic. A real web app
// addresses its own siblings by absolute URL - a module-federation shell on 3006
// pulls remotes from 3008-3010 and calls an API on 8080. Forward those to
// arbitrary local ports and the page loads, renders nothing, and reports
// "Failed to load properties": every absolute reference inside it now points at a
// port that is not the forward. Mirroring makes the app's own URLs correct.
//
// It is a PREFERENCE, not a hardcode: the number comes from the transport's
// config, and if that port is already taken on this box the OS picks a free one
// and the result says so (`mirrored: false`) rather than failing or, worse,
// forwarding into whatever already owned it.

import { spawn } from "node:child_process";
import net from "node:net";
import { sshArgv } from "./transports.mjs";

/** Ask the OS for a free loopback port and release it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Is this local port free, i.e. is nobody listening? Connect-only is the right
 *  test here, because "someone already owns this number" is a local fact. */
function portTaken(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (taken) => {
      socket.destroy();
      resolve(taken);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Is the forward actually CARRYING data?
 *
 * A TCP connect is not evidence: `ssh -L` accepts on the local port whether or
 * not the far end is reachable, and only fails when the channel is opened. A
 * forward left over from a replaced tunnel therefore accepts instantly and then
 * hangs forever - reported "up" while every request times out. That exact failure
 * is why this sends a real request and requires real bytes back.
 *
 * Any response counts, including a 404: the question is whether the channel
 * carries traffic, not whether the remote likes the path. A non-HTTP service will
 * fail this check; forwards exist to be opened in a browser, so that trade is
 * deliberate rather than accidental.
 */
function probeRoundTrip(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(`HEAD / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.once("data", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}

/**
 * Normalise one `forwards[]` entry from transport config.
 * `{ name, remotePort, label?, path? }` - `path` is appended when a link is built,
 * so a dev server that only serves something useful at /admin can say so.
 */
export function normalizeForward(raw, index) {
  const remotePort = Number(raw?.remotePort ?? raw?.port);
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return null;
  const name = String(raw?.name || `port-${remotePort}`).replace(/[^A-Za-z0-9_-]/g, "-");
  return {
    name,
    remotePort,
    label: String(raw?.label || name),
    path: typeof raw?.path === "string" && raw.path.startsWith("/") ? raw.path : "/",
    order: index
  };
}

export function normalizeForwards(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeForward).filter(Boolean);
}

/**
 * Keeps one `ssh -N -L` child per (transport, forward) alive and reports where it
 * landed. Restarting is caller-driven (ensure() is idempotent) rather than a
 * background loop: a forward nobody is looking at should not hold a connection
 * into someone else's machine open forever.
 */
export class ForwardManager {
  constructor({ spawnFn = spawn, log = () => {} } = {}) {
    this.spawnFn = spawnFn;
    this.log = log;
    this.active = new Map(); // `${transport}:${name}` -> {child, localPort, remotePort, startedAt}
  }

  #key(transportName, forwardName) {
    return `${transportName}:${forwardName}`;
  }

  /** Bring one forward up (or confirm it already is). Never throws. */
  async ensure(transport, forward, { settleMs = 8000 } = {}) {
    const key = this.#key(transport.name, forward.name);
    const existing = this.active.get(key);
    if (existing && existing.child.exitCode === null && (await probeRoundTrip(existing.localPort, 1500))) {
      return { ...this.#describe(existing, forward), status: "up" };
    }
    if (existing) this.#stopEntry(key);

    let localPort = forward.remotePort;
    let mirrored = true;
    if (await portTaken(localPort)) {
      // Something on this box already owns the mirrored port. Binding it is not
      // ours to take, so fall back and be explicit about the consequence.
      mirrored = false;
      try {
        localPort = await freePort();
      } catch (err) {
        return { name: forward.name, status: "error", error: `no free local port: ${String(err?.message || err)}` };
      }
    }

    // -N: no remote command, this channel only forwards.
    const argv = [
      "-N",
      "-L", `127.0.0.1:${localPort}:127.0.0.1:${forward.remotePort}`,
      ...sshArgv(transport)
    ];
    const child = this.spawnFn("ssh", argv, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    const entry = { child, localPort, mirrored, remotePort: forward.remotePort, startedAt: Date.now(), stderr: () => stderr };
    this.active.set(key, entry);
    child.on("close", () => {
      if (this.active.get(key) === entry) this.active.delete(key);
    });

    // The forward is usable only once the remote end actually carries data. Waiting
    // here is what makes a published URL trustworthy instead of a promise - but on a
    // TOTAL deadline, not a retry count: each probe now waits for real bytes, so
    // "20 attempts" silently became a minute and a half of hanging on a dead
    // channel. A caller bringing up nine forwards feels that as a lost afternoon.
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      const remaining = deadline - Date.now();
      if (await probeRoundTrip(localPort, Math.min(1500, Math.max(250, remaining)))) {
        return { ...this.#describe(entry, forward), status: "up" };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const detail = (stderr.trim().split("\n").pop() || "").slice(0, 200);
    this.#stopEntry(key);
    return {
      name: forward.name,
      label: forward.label,
      remotePort: forward.remotePort,
      status: "down",
      error:
        detail ||
        `nothing is listening on 127.0.0.1:${forward.remotePort} on the remote - start the service there, then retry`
    };
  }

  #describe(entry, forward) {
    const mirrored = entry.mirrored !== false;
    return {
      name: forward.name,
      label: forward.label,
      remotePort: forward.remotePort,
      localPort: entry.localPort,
      mirrored,
      // An unmirrored forward is not a cosmetic detail, it is a correctness
      // hazard: the remote page still resolves its absolute localhost:<remote>
      // URLs, which now reach whatever owns that port on THIS box - typically a
      // local copy of the very same service. You would be reviewing a hybrid of
      // two machines and could not tell. Say so, loudly, next to the URL.
      conflict: mirrored
        ? null
        : `port ${forward.remotePort} is already in use on this machine, so this forward is on ${entry.localPort}. ` +
          `Anything the remote page requests from localhost:${forward.remotePort} will hit THIS machine's service, not the remote's. ` +
          `Stop the local one to review the remote faithfully.`,
      path: forward.path,
      startedAt: new Date(entry.startedAt).toISOString()
    };
  }

  #stopEntry(key) {
    const entry = this.active.get(key);
    if (!entry) return;
    try {
      entry.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    this.active.delete(key);
  }

  /** Bring up every forward a transport declares. */
  async ensureAll(transport) {
    const out = [];
    for (const forward of transport.forwards ?? []) {
      out.push(await this.ensure(transport, forward));
    }
    return out;
  }

  /**
   * Current state without dialing. Deliberately reports `open` rather than `up`
   * for a live child: an ssh -L channel can be open and carry nothing, so only
   * ensure() - which does the round trip - is entitled to say "up".
   */
  snapshot(transport) {
    return (transport.forwards ?? []).map((forward) => {
      const entry = this.active.get(this.#key(transport.name, forward.name));
      if (!entry || entry.child.exitCode !== null) {
        return { name: forward.name, label: forward.label, remotePort: forward.remotePort, path: forward.path, status: "down" };
      }
      return { ...this.#describe(entry, forward), status: "open" };
    });
  }

  stopAll() {
    for (const key of [...this.active.keys()]) this.#stopEntry(key);
  }
}

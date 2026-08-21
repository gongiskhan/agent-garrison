// RemoteShellAdapter — the RuntimeAdapter face of the remote-shell fitting.
//
// Unlike the exec engines this adapter spawns NOTHING: the long-lived state
// (devtunnel client, ssh+tmux attach PTY, events watcher) lives in the
// fitting's own-port server, and the adapter is a thin loopback-HTTP client of
// it. A "turn" = inject the instruction into the remote agent's TUI (tmux
// send-keys) and wait for the agent's own stop hook to signal completion via
// the remote events file — never by scraping terminal text for state.
//
// Target convention: `model` on a remote-shell routing target names the
// TRANSPORT (e.g. model: "csg"), the same way Cursor encodes effort inside the
// model id — it is the one runtime-specific slot every routing whitelist and
// UI already carries.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FITTING_ID = "remote-shell-runtime";

function garrisonHome() {
  const override = process.env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

function serverUrl() {
  // The status file is the discovery contract every own-port consumer uses.
  try {
    const status = JSON.parse(
      readFileSync(path.join(garrisonHome(), "ui-fittings", `${FITTING_ID}.json`), "utf8")
    );
    if (status?.url) return status.url;
  } catch {}
  const port = process.env.GARRISON_REMOTESHELLRUNTIME_PORT;
  if (port) return `http://127.0.0.1:${port}`;
  return null;
}

async function api(base, method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(method === "GET" ? 130_000 : 30_000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `remote-shell server ${res.status} on ${pathname}`);
  return data;
}

export class RemoteShellAdapter {
  constructor(opts = {}) {
    this._baseUrl = opts.baseUrl ?? null;
  }

  #base() {
    const base = this._baseUrl ?? serverUrl();
    if (!base) {
      throw new Error(
        "remote-shell server not running — the remote-shell-runtime fitting's own-port server publishes " +
          "~/.garrison/ui-fittings/remote-shell-runtime.json; is the composition up?"
      );
    }
    return base;
  }

  /** config.transport (explicit) or config.model (routing-target slot) names
   *  the transport. */
  async spawn(config = {}) {
    const base = this.#base();
    const transport = String(config.transport || config.model || "").trim();
    if (!transport) {
      throw new Error(
        'remote-shell target names no transport — set the routing target\'s model to the transport name (e.g. model: "csg")'
      );
    }
    const { session } = await api(base, "POST", "/sessions", { transport });
    return {
      base,
      sessionId: session.id,
      transport,
      pendingTurn: null,
      cancelRequested: false
    };
  }

  async awaitReady(session) {
    await api(session.base, "GET", `/sessions/${session.sessionId}`);
  }

  async sendTurn(session, text) {
    const { turn } = await api(session.base, "POST", `/sessions/${session.sessionId}/turn`, { text });
    session.pendingTurn = turn.id;
  }

  async awaitResponse(session) {
    if (!session.pendingTurn) throw new Error("RemoteShellAdapter: awaitResponse without a pending sendTurn");
    const turnId = session.pendingTurn;
    session.pendingTurn = null;
    // Long-poll until the stop hook settles the turn. The remote agent can
    // legitimately work for a long time; the gateway's own turn timeout / Stop
    // wiring (adapter.cancel) bounds this loop from outside.
    for (;;) {
      const { turn } = await api(
        session.base, "GET",
        `/sessions/${session.sessionId}/turns/${turnId}?waitMs=115000`
      );
      if (turn.state === "running") {
        if (session.cancelRequested) {
          session.cancelRequested = false;
          return { text: "(remote turn cancelled — the remote agent may still be working)", artifacts: [], stoppedReason: "cancelled" };
        }
        continue;
      }
      if (turn.state === "failed") throw new Error(`remote-shell turn failed: ${turn.error}`);
      const tail = (turn.tail ?? "").trim();
      return {
        text: tail
          ? `Remote agent finished (stop hook @ ${turn.endedAt}). Last terminal output:\n\n${tail}`
          : `Remote agent finished (stop hook @ ${turn.endedAt}).`,
        artifacts: []
      };
    }
  }

  /** Cancel = Escape into the remote TUI (the agent's own interrupt), never a
   *  kill — the remote session must survive. */
  async cancel(session) {
    session.cancelRequested = true;
    try {
      await api(session.base, "POST", `/sessions/${session.sessionId}/keys`, { keys: "Escape" });
    } catch {}
  }

  async setModel() { /* transports, not models — nothing to switch */ }

  async setEffort() { /* no effort control on a remote TUI */ }

  async resume(config = {}) {
    return this.spawn(config);
  }

  /** Teardown after a delegated turn keeps EVERYTHING alive: the session, the
   *  events watcher, the remote tmux. Detach/close is an explicit user action
   *  on the fitting surface, not a turn side-effect. */
  async teardown() {}
}

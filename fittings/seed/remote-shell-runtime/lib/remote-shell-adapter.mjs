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

/** Pane text is terminal output, not prose: fence it so a chat surface renders
 *  it monospaced and leaves its box-drawing and backticks alone. */
function remoteTranscript(text) {
  const body = String(text).replace(/\s+$/, "");
  // A fence has to be longer than the longest run of backticks inside it.
  const longest = (body.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

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

  /**
   * Long-poll until the stop hook settles the turn. The remote agent can
   * legitimately work for a long time; the gateway's own turn timeout / Stop
   * wiring (adapter.cancel) bounds this loop from outside.
   *
   * `opts.onChunk(text, replace)` — the gateway's streaming seam — receives the
   * remote pane's output as it grows, so the channel that dispatched the turn
   * shows the work happening instead of a blank wait. Always a REPLACE: a TUI
   * rewrites its last lines in place, so only the whole text is ever correct.
   */
  async awaitResponse(session, opts = {}) {
    if (!session.pendingTurn) throw new Error("RemoteShellAdapter: awaitResponse without a pending sendTurn");
    const turnId = session.pendingTurn;
    session.pendingTurn = null;
    const onChunk = typeof opts.onChunk === "function" ? opts.onChunk : null;
    let seenRev = 0;
    let streamed = "";
    let saidDegraded = false;
    // The server stops pretending when consecutive progress reads fail, so this
    // no longer has to present a frozen transcript as if it were live. Said
    // once: it is a state, not an event.
    const degradedNote = "\n\n_The link to the remote went quiet - the transcript above may be stale._";
    for (;;) {
      const { turn } = await api(
        session.base, "GET",
        `/sessions/${session.sessionId}/turns/${turnId}?waitMs=115000&sinceRev=${seenRev}`
      );
      const output = typeof turn.output === "string" ? turn.output : "";
      if (Number.isFinite(turn.outputRev) && turn.outputRev > seenRev) {
        seenRev = turn.outputRev;
        if (output && output !== streamed) {
          streamed = output;
          if (onChunk) {
            try { onChunk(remoteTranscript(output), true); } catch { /* a consumer must not break the turn */ }
          }
        }
      }
      if (turn.degraded === true && !saidDegraded) {
        saidDegraded = true;
        if (onChunk) {
          const body = streamed ? `${remoteTranscript(streamed)}${degradedNote}` : degradedNote.trim();
          try { onChunk(body, true); } catch { /* a consumer must not break the turn */ }
        }
      }
      if (turn.state === "running") {
        if (session.cancelRequested) {
          session.cancelRequested = false;
          return {
            text: streamed
              ? `${remoteTranscript(streamed)}\n\n_Remote turn cancelled — the remote agent may still be working._`
              : "(remote turn cancelled — the remote agent may still be working)",
            artifacts: [],
            stoppedReason: "cancelled"
          };
        }
        continue;
      }
      if (turn.state === "failed") throw new Error(`remote-shell turn failed: ${turn.error}`);
      const body = output || streamed || (turn.tail ?? "").trim();
      return {
        text: body
          ? `${remoteTranscript(body)}\n\n_Remote agent finished (stop hook @ ${turn.endedAt})._`
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

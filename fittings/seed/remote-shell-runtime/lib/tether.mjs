// Tether: the reverse+forward SSH tunnel that makes a machine behind a relay
// (csg, over its VS Code devtunnel) a full mesh node - state-service + git
// reachable FROM the tethered node (reverse: -R), the tethered node's app +
// shells reachable FROM the owner node (forward: -L). Rides the SAME
// devtunnel-forwarded ssh port the shell already uses (sshArgv/sshExec) - no
// second tunnel, no listener the tethered node opens itself. One child per
// tethered transport: `ssh -N -o ExitOnForwardFailure=yes ... -R ... -L ...`.
//
// Health, every tick: the FORWARD legs are locally observable (probeRoundTrip
// on each -L localPort, same discipline forwards.mjs already uses for the
// exact same failure mode - an accepted-but-wedged channel). The REVERSE legs
// are not: a live local listener on the -R remote port proves nothing about
// whether csg can actually reach dev-madrid through it, so that leg is
// checked by running a real curl ON THE REMOTE (exec through the transport)
// against the reverse-forwarded state-service port. Two consecutive misses on
// EITHER kind retires the child and respawns with backoff; onUp runs once per
// down->up transition, never on every healthy tick.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sshArgv, sshExec, garrisonHome } from "./transports.mjs";
import { probeRoundTrip } from "./forwards.mjs";
import { shellQuote } from "./shell-quote.mjs";

const HEALTH_INTERVAL_MS = 20_000;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const MISSES_BEFORE_RETIRE = 2;
const KILL_GRACE_MS = 2_000;
const REVERSE_PROBE_TIMEOUT_MS = 5_000;
// How often the recovery hook may re-run while the far side is reachable but
// its forwards still carry nothing. Long enough that a hook which takes a
// while (node-supervisor.sh brings a whole node up) is not stampeded, short
// enough that a hook which failed gets another go without waiting for a human.
const RECOVERY_RETRY_MS = 120_000;

/** Is this node the one a tether block is armed for? A tether transport is
 *  otherwise inert - every OTHER node in the mesh reads the same composition
 *  and must not try to dial it. */
export function tetherArmed(transport, env = process.env) {
  const t = transport?.tether;
  if (!t) return false;
  const owner = String(env.GARRISON_NODE_NAME ?? "").trim();
  return Boolean(owner) && owner === String(t.owner ?? "").trim();
}

/** ssh argv for one tether child: -R per reverseForwards entry (remote binds
 *  remotePort, forwards to THIS box's localPort), -L per forwards entry (this
 *  box binds localPort, forwards to the tethered node's remotePort). */
export function tetherArgv(transport) {
  const t = transport.tether;
  const argv = ["-N", "-o", "ExitOnForwardFailure=yes"];
  for (const rf of t.reverseForwards ?? []) {
    argv.push("-R", `127.0.0.1:${rf.remotePort}:127.0.0.1:${rf.localPort}`);
  }
  for (const f of t.forwards ?? []) {
    argv.push("-L", `127.0.0.1:${f.localPort}:127.0.0.1:${f.remotePort}`);
  }
  argv.push(...sshArgv(transport));
  return argv;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class TetherManager {
  constructor({ spawnFn = spawn, exec = sshExec, log = console, notify = null, env = process.env } = {}) {
    this.spawnFn = spawnFn;
    this.exec = exec; // (transport, command) -> Promise<{code, stdout, stderr}> — transportExec/sshExec
    this.log = log;
    this.notify = notify;
    this.env = env;
    this.entries = new Map(); // transportName -> entry
    /** Set by the server: (transport) => void, fired on a down→up transition. */
    this.onRecovered = null;
  }

  #entry(name) {
    let e = this.entries.get(name);
    if (!e) {
      e = {
        child: null,
        state: "down",
        since: Date.now(),
        lastOkAt: null,
        misses: 0,
        legs: null,
        lastError: null,
        backoffIndex: 0,
        timer: null,
        starting: false,
        ticking: false
      };
      this.entries.set(name, e);
    }
    return e;
  }

  status(transportName) {
    const e = this.entries.get(transportName);
    if (!e) return { state: "down", since: null, lastOkAt: null, misses: 0, legs: null, lastError: null };
    return {
      state: e.state,
      since: new Date(e.since).toISOString(),
      lastOkAt: e.lastOkAt ? new Date(e.lastOkAt).toISOString() : null,
      misses: e.misses,
      legs: e.legs,
      lastError: e.lastError
    };
  }

  /** Idempotent: safe to call repeatedly (a timer tick and a demand call may
   *  race). A start already in flight is awaited rather than duplicated. */
  async ensure(transport) {
    if (!tetherArmed(transport, this.env)) {
      return { ok: false, error: "tether is not armed on this node (owner mismatch or no tether block)" };
    }
    const name = transport.name;
    const e = this.#entry(name);
    if (e.starting) return { ok: false, retryable: true, error: `tether for ${name} is already starting` };
    if (e.child && e.child.exitCode === null) {
      return { ok: e.state === "up", state: e.state };
    }
    return this.#start(transport);
  }

  async #start(transport, { replace = false } = {}) {
    const name = transport.name;
    const e = this.#entry(name);
    // A live child means someone else already started one. TunnelManager's
    // #startClient has always had this guard; the tether did not, which is how
    // a raced tick could leave a second ssh fighting the first for the same
    // forwards. `replace` is the deliberate path (tick retires, then restarts).
    if (!replace && e.child && e.child.exitCode === null) {
      return { ok: e.state === "up", state: e.state };
    }
    e.starting = true;
    this.#setState(e, "connecting");
    try {
      const argv = tetherArgv(transport);
      const child = this.spawnFn("ssh", argv, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on?.("data", (d) => {
        stderr += String(d);
        if (stderr.length > 2000) stderr = stderr.slice(-2000);
      });
      e.child = child;
      e.stderrTail = () => stderr;
      child.on?.("close", () => {
        if (this.entries.get(name) === e && e.child === child) {
          e.child = null;
        }
      });

      const legs = await this.#probeAll(transport);
      if (legs.ok) {
        this.#markUp(transport, legs);
        return { ok: true, state: "up", legs: legs.detail };
      }
      e.legs = legs.detail;
      e.lastError = legs.detail?.error ?? "tether did not settle";
      this.#setState(e, "suspect");
      // Reachable but not carrying is exactly the shape a dead far-side node
      // leaves behind, and it is the shape the recovery hook exists for.
      this.#maybeRecover(transport, legs);
      return { ok: false, state: "suspect", error: e.lastError };
    } finally {
      e.starting = false;
    }
  }

  /** Both directions, once. Used at start-up and by the health tick. */
  async #probeAll(transport) {
    const t = transport.tether;
    const forwardChecks = await Promise.all(
      (t.forwards ?? []).map(async (f) => ({ name: f.name, ok: await probeRoundTrip(f.localPort, 1500) }))
    );
    let reverseOk = true;
    let reverseDetail = null;
    const state = t.reverseForwards?.find((rf) => rf.name === "state");
    if (state && this.exec) {
      try {
        const res = await this.exec(
          transport,
          `curl -sf --max-time 5 http://127.0.0.1:${state.remotePort}/v1/health`,
          { timeoutMs: REVERSE_PROBE_TIMEOUT_MS }
        );
        reverseOk = Number(res?.code) === 0;
        reverseDetail = reverseOk ? null : (res?.stderr || res?.stdout || "").trim().slice(-200);
      } catch (err) {
        reverseOk = false;
        reverseDetail = err?.message ?? String(err);
      }
    }
    const ok = forwardChecks.every((f) => f.ok) && reverseOk;
    return {
      ok,
      detail: {
        forwards: forwardChecks,
        reverse: { ok: reverseOk, error: reverseDetail },
        error: ok ? null : `tether unhealthy: ${[
          ...forwardChecks.filter((f) => !f.ok).map((f) => `-L ${f.name} not carrying`),
          reverseOk ? null : `-R state not carrying${reverseDetail ? ` (${reverseDetail})` : ""}`
        ].filter(Boolean).join("; ")}`
      }
    };
  }

  #markUp(transport, legs) {
    const e = this.#entry(transport.name);
    const wasDown = e.state !== "up";
    e.misses = 0;
    e.lastOkAt = Date.now();
    e.legs = legs.detail;
    e.lastError = null;
    e.backoffIndex = 0;
    this.#setState(e, "up");
    this.#writeTetherFile(transport);
    if (wasDown) this.#fireOnUp(transport);
  }

  // scripts/tailnet-serve-tether.mjs (running on THIS node, the owner) reads
  // this to know which local ports to publish over `tailscale serve` - the
  // forwards this tether just proved carry traffic, each with the servePort
  // its transport config declared for it.
  #writeTetherFile(transport) {
    const t = transport.tether;
    const forwards = (t.forwards ?? [])
      .filter((f) => f.publish?.servePort)
      .map((f) => ({ name: f.name, localPort: f.localPort, servePort: f.publish.servePort }));
    if (!forwards.length) return;
    try {
      const dir = path.join(garrisonHome(this.env), "remote-shell");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "tether.json"),
        JSON.stringify({ transport: transport.name, node: t.node, forwards }, null, 2),
        "utf8"
      );
    } catch (err) {
      this.log?.warn?.(`[remote-shell] could not write tether.json for ${transport.name}: ${err?.message ?? err}`);
    }
  }

  #setState(e, state) {
    if (e.state !== state) e.since = Date.now();
    e.state = state;
  }

  /**
   * Run the recovery hook, gated on the ONE precondition it actually has: that
   * we can execute commands on the far side (the -R leg carrying proves that).
   *
   * Firing it only from #markUp was a deadlock, and it cost a manual recovery
   * the day WSL died under csg. `onUp` there is `node-supervisor.sh ensure` -
   * the command that STARTS the node whose ports the -L forwards carry. So the
   * forwards could not carry until the hook ran, and the hook did not run until
   * the forwards carried. The tether sat in `suspect` with a perfectly healthy
   * reverse leg (ssh worked fine by hand) until a human ran the hook's own
   * command. Reachability, not full health, is the right trigger.
   */
  #maybeRecover(transport, legs) {
    const t = transport.tether;
    if (!t?.onUp || !this.exec) return;
    const e = this.#entry(transport.name);
    // Not reachable: nothing to run the hook through, and the next reachable
    // episode should fire immediately rather than inherit this one's cooldown.
    if (!legs?.detail?.reverse?.ok) { e.recoveryAt = 0; return; }
    if (e.recoveryAt && Date.now() - e.recoveryAt < RECOVERY_RETRY_MS) return;
    e.recoveryAt = Date.now();
    this.log?.warn?.(`[remote-shell] tether ${transport.name} is reachable - running onUp`);
    this.exec(transport, `bash -lc ${shellQuote(t.onUp)}`, { timeoutMs: 15_000 }).catch((err) => {
      this.log?.warn?.(`[remote-shell] tether ${transport.name} onUp failed: ${err?.message ?? err}`);
    });
  }

  #fireOnUp(transport) {
    // Reachable is implied by up; the cooldown inside keeps this from running
    // the hook a second time when recovery just ran it moments ago.
    this.#maybeRecover(transport, { detail: { reverse: { ok: true } } });
    if (typeof this.onRecovered === "function") {
      try { this.onRecovered(transport); } catch { /* caller's problem */ }
    }
    if (this.notify) {
      // The object shape every sink expects. This passed a bare string, which
      // capture-service rejects with a 400 - so the one piece of GOOD news the
      // tether ever sends was the only one that never arrived.
      try {
        this.notify({
          title: "Tether",
          text: `${transport.label ?? transport.name}: tether is up`,
          actions: [],
          tag: `remote-shell-tether:${transport.name}`,
          idempotencyKey: `remote-shell-tether:${transport.name}:up:${this.#entry(transport.name).since}`,
          link: null
        });
      } catch { /* best effort */ }
    }
  }

  /** One health check + act-on-evidence step. Call on a timer; skips a
   *  transport that is not armed here or has no child running. */
  async tick(transport) {
    if (!tetherArmed(transport, this.env)) return;
    const name = transport.name;
    const e = this.entries.get(name);
    if (!e || e.starting || e.ticking) return; // ensure()/a prior tick already owns bringing it up

    // No live ssh child - dead on its own (ssh exits almost immediately on
    // e.g. ECONNREFUSED - a genuinely unreachable target is NOT the same
    // failure shape as a live-but-quiet forward, which is why forwards.mjs's
    // ForwardManager can assume a still-running child) or never started.
    // Unambiguous evidence, so this restarts directly rather than waiting out
    // MISSES_BEFORE_RETIRE - found live: without this branch a dead child was
    // never retried again, ever, once its process table entry was gone.
    if (!e.child || e.child.exitCode !== null) {
      e.ticking = true;
      try {
        e.misses += 1;
        const backoff = Math.min(BASE_BACKOFF_MS * 2 ** e.backoffIndex, MAX_BACKOFF_MS);
        e.backoffIndex += 1;
        this.log?.warn?.(
          `[remote-shell] tether ${name} has no live ssh child (last error: ${e.lastError ?? "none"}) - retrying in ${backoff}ms`
        );
        await sleep(backoff);
        await this.#start(transport);
      } finally {
        e.ticking = false;
      }
      return;
    }

    // Everything from here can await for a minute or more (a retire, a backoff,
    // a fresh #start), so it runs under the same `ticking` guard as the branch
    // above. Without it a second tick walked in, saw e.child already cleared by
    // #retire, took the no-child branch and reached a SECOND #start - the loser
    // died instantly on ExitOnForwardFailure while the orphaned winner kept both
    // forwards carrying. That is F-005's exact symptom: curl to the forward
    // works while /tether insists the tether is suspect.
    e.ticking = true;
    try {
      const legs = await this.#probeAll(transport);
      if (legs.ok) {
        this.#markUp(transport, legs);
        return;
      }
      e.misses += 1;
      e.legs = legs.detail;
      e.lastError = legs.detail?.error ?? "unhealthy";
      this.#maybeRecover(transport, legs);
      if (e.misses < MISSES_BEFORE_RETIRE) {
        this.#setState(e, "suspect");
        return;
      }
      this.log?.warn?.(`[remote-shell] tether ${name} unhealthy for ${e.misses} ticks (${e.lastError}) - retiring and respawning`);
      await this.#retire(e);
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** e.backoffIndex, MAX_BACKOFF_MS);
      e.backoffIndex += 1;
      await sleep(backoff);
      await this.#start(transport, { replace: true });
    } finally {
      e.ticking = false;
    }
  }

  async #retire(e) {
    if (!e.child) return;
    const child = e.child;
    e.child = null;
    try { child.kill?.("SIGTERM"); } catch { /* already gone */ }
    await Promise.race([
      new Promise((resolve) => child.once?.("close", resolve)),
      sleep(KILL_GRACE_MS)
    ]);
    if (child.exitCode === null) {
      try { child.kill?.("SIGKILL"); } catch { /* already gone */ }
    }
  }

  async stop(transportName) {
    const e = this.entries.get(transportName);
    if (!e) return;
    if (e.timer) { clearInterval(e.timer); e.timer = null; }
    await this.#retire(e);
    this.#setState(e, "down");
  }

  /** Start the periodic health tick for one transport. Idempotent. */
  startTicking(transport, intervalMs = HEALTH_INTERVAL_MS) {
    const e = this.#entry(transport.name);
    if (e.timer) return;
    const t = setInterval(() => { this.tick(transport).catch(() => {}); }, intervalMs);
    t.unref?.();
    e.timer = t;
  }
}

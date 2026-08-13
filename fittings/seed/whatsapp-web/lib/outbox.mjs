// Outbound delay buffer — the cancel window that turns an irreversible send
// into one that is revertible in practice.
//
// CANONICAL COPY. This is the one implementation; it is copied (module syntax
// aside) into every Fitting that owns an outbound send — see
// fittings/seed/slack-channel/lib/outbox.js. Cross-fitting imports are
// forbidden, so a fix here has to be carried across by hand.
//
// An agent-triggered send is PARKED, not sent: the entry lands in
// $GARRISON_HOME/<fitting-id>/outbox.json with an executeAt, and the real send
// runs only when that window elapses uncancelled. This is the whole reason an
// autonomy band may ever grant act-without-asking on an outbound message —
// fittings/seed/orchestrator/lib/routing-autonomy.mjs gates an irreversible
// action on it staying revertible.
//
// The drain has to live in a LONG-LIVED process: a per-invocation connector CLI
// cannot hold a 60-second timer, so a Fitting whose only process is that CLI
// cannot buffer at all (it must say so rather than pretend).
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// Copied from fittings/seed/orchestrator/lib/routing-autonomy.mjs, where the
// reversibility taxonomy declares it (OUTBOUND_DELAY_SECONDS = 60). The two
// values must move together.
export const OUTBOUND_DELAY_SECONDS = 60;

const TERMINAL = new Set(["sent", "cancelled", "failed"]);
const KEEP_TERMINAL = 200;
const TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Where a call came from. Only "human" — a person acting in a UI, marked by the
 * UI process, never by an argument the caller types — skips the buffer. An
 * unmarked caller counts as an agent and is buffered: the same unknown-is-unsafe
 * default reversibilityOf() applies. GARRISON_AUTOMATION_ENGINE is set on every
 * connector child the Automations engine spawns (engine.mjs defaultRunConnector).
 */
export function resolveSendContext(env = {}) {
  // The engine's marker is checked FIRST and cannot be talked out of: an
  // automation that inherited GARRISON_SEND_CONTEXT from somewhere must not be
  // able to present itself as a human.
  if (env.GARRISON_AUTOMATION_ENGINE) return "automation";
  const explicit = String(env.GARRISON_SEND_CONTEXT ?? "").trim().toLowerCase();
  if (explicit === "human" || explicit === "agent" || explicit === "automation") return explicit;
  return "agent";
}

export class Outbox {
  /**
   * groupKey(entry) -> string names the destination a send is addressed to. Set
   * it only in a Fitting whose transport rate-limits per destination and whose
   * messages can legitimately be merged (Slack: ~1 message/second/channel).
   * Left null, every entry sends on its own — which is what a transport with
   * human-pacing discipline (whatsapp-web) requires.
   */
  constructor({
    file,
    send,
    delaySeconds = OUTBOUND_DELAY_SECONDS,
    groupKey = null,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = () => {}
  }) {
    this.file = file;
    this.send = send;
    this.delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    this.groupKey = groupKey;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    this.timers = new Map();
  }

  read() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch {
      // Missing or corrupt: an empty buffer is always the safe reading — it
      // can only ever fail to send, never send something twice.
      return [];
    }
  }

  write(entries) {
    const cutoff = this.now() - TERMINAL_TTL_MS;
    const live = entries.filter((e) => !TERMINAL.has(e.status) || Date.parse(e.settledAt ?? "") >= cutoff);
    const terminal = live.filter((e) => TERMINAL.has(e.status));
    const kept = terminal.length > KEEP_TERMINAL ? live.filter((e) => !TERMINAL.has(e.status)).concat(terminal.slice(-KEEP_TERMINAL)) : live;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: kept }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    return kept;
  }

  get(id) {
    return this.read().find((e) => e.id === id) ?? null;
  }

  pending() {
    return this.read().filter((e) => e.status === "pending");
  }

  /** Park a send. Returns the record; the caller answers the agent with it. */
  enqueue({ action, payload, summary = "", context = "agent" }) {
    const at = this.now();
    const entry = {
      id: `ob_${at.toString(36)}_${randomBytes(3).toString("hex")}`,
      action: String(action),
      payload,
      summary: String(summary).slice(0, 300),
      context,
      status: "pending",
      queuedAt: new Date(at).toISOString(),
      executeAt: new Date(at + this.delayMs).toISOString(),
      settledAt: null,
      result: null,
      error: null
    };
    this.write(this.read().concat(entry));
    this.schedule(entry);
    return entry;
  }

  schedule(entry) {
    if (this.timers.has(entry.id)) return;
    const delay = Math.max(0, Date.parse(entry.executeAt) - this.now());
    const timer = this.setTimer(() => {
      this.timers.delete(entry.id);
      this.fire(entry.id).catch((err) => this.log(`outbox ${entry.id}: ${err?.message ?? err}`));
    }, delay);
    if (typeof timer?.unref === "function") timer.unref();
    this.timers.set(entry.id, timer);
  }

  /**
   * Execute one parked send, exactly once. The pending -> sending flip is
   * written BEFORE the await, so a second timer for the same id (a double
   * schedule, a re-arm racing a live timer) finds it already claimed.
   *
   * With a groupKey, everything else already DUE for the same destination is
   * claimed in the same pass and handed to send() together, so a fitting whose
   * transport rate-limits per destination can deliver one message instead of a
   * burst. An entry whose own window has not elapsed is never pulled in early —
   * that would spend someone else's cancel window.
   */
  async fire(id) {
    const entries = this.read();
    const entry = entries.find((e) => e.id === id);
    if (!entry || entry.status !== "pending") return entry ?? null;
    const at = this.now();
    const key = this.groupKey ? this.groupKey(entry) : null;
    const claimed = [entry];
    if (key !== null && key !== undefined) {
      for (const other of entries) {
        if (other === entry || other.status !== "pending") continue;
        if (Date.parse(other.executeAt) > at) continue;
        if (this.groupKey(other) !== key) continue;
        claimed.push(other);
      }
    }
    for (const claim of claimed) claim.status = "sending";
    this.write(entries);
    // The batched-in entries must not fire again on their own timers.
    for (const claim of claimed) this.unschedule(claim.id);
    let settled;
    try {
      settled = { status: "sent", result: (await this.send(entry, claimed)) ?? null, error: null };
    } catch (err) {
      settled = { status: "failed", result: null, error: String(err?.message ?? err) };
    }
    this.settle(claimed.map((claim) => claim.id), settled);
    return this.get(id);
  }

  unschedule(id) {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    this.clearTimer(timer);
    this.timers.delete(id);
  }

  settle(ids, patch) {
    const wanted = Array.isArray(ids) ? ids : [ids];
    const entries = this.read();
    const settledAt = new Date(this.now()).toISOString();
    let found = null;
    for (const entry of entries) {
      if (!wanted.includes(entry.id)) continue;
      Object.assign(entry, patch, { settledAt });
      if (!found) found = entry;
    }
    if (!found) return null;
    this.write(entries);
    return found;
  }

  /** Idempotent. After the window it answers honestly rather than lying. */
  cancel(id) {
    const entry = this.get(id);
    if (!entry) return { ok: false, status: "unknown", error: `no outbox entry ${id}` };
    if (entry.status === "cancelled") return { ok: true, status: "cancelled", entry };
    if (entry.status !== "pending") return { ok: false, status: entry.status, error: `already ${entry.status}`, entry };
    this.unschedule(id);
    return { ok: true, status: "cancelled", entry: this.settle(id, { status: "cancelled" }) };
  }

  /**
   * On process start: re-arm what is still pending (an overdue entry fires
   * immediately) and fail anything left mid-send by a crash. A "sending" entry
   * may already have reached the wire, and sending an irreversible message
   * twice is worse than not sending it, so it is never retried.
   */
  rearm() {
    const entries = this.read();
    let dirty = false;
    for (const entry of entries) {
      if (entry.status === "sending") {
        Object.assign(entry, { status: "failed", error: "process exited mid-send; not retried", settledAt: new Date(this.now()).toISOString() });
        dirty = true;
      }
    }
    if (dirty) this.write(entries);
    const pending = entries.filter((e) => e.status === "pending");
    for (const entry of pending) this.schedule(entry);
    return pending;
  }
}

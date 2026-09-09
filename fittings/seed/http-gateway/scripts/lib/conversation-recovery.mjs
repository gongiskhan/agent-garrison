// Recovery uses the owner's ledger. It never replays a tool command: a fresh
// stretch inspects the effects first, then continues the same duty.
import fs from "node:fs";
import path from "node:path";
import { listConversations, openConversation } from "@garrison/claude-pty";

export function recoverableConversations({ env = process.env, compositionId, now = Date.now() } = {}) {
  return listConversations(env).filter((entry) => now - Date.parse(entry.mtime) < 5 * 24 * 60 * 60_000).slice(0, 40)
    .filter((entry) => {
      const store = openConversation(entry.id, { role: "gateway", env });
      if (store.currentStretch() || deploymentInFlight(store)) return false;
      const start = store.tail(1, { kinds: ["stretch-started"] })[0];
      if (!start || (compositionId && !start.runId?.startsWith(`${compositionId}@`))) return false;
      if (latestUnfinishedStretch(store)) return true;
      // A gateway can also stop after saving the handoff and before admitting
      // its successor. That work is still pending, even without a stale marker.
      const handoff = store.tail(1, { kinds: ["handoff"] })[0]?.payload;
      const next = handoff?.nextSteps?.next;
      return Boolean(next && !["done", "needs-input"].includes(next) && !handoff.cancelled);
    }).map((entry) => entry.id);
}

export function latestUnfinishedStretch(store) {
  const lifecycle = store.tail(100, { kinds: ["stretch-started", "stretch-ended"] });
  const start = lifecycle.filter((e) => e.kind === "stretch-started").at(-1);
  return start && !lifecycle.some((e) => e.kind === "stretch-ended" && e.stretch === start.stretch)
    ? start : null;
}

export function originalRequest(store) {
  const events = store.tail(Number.MAX_SAFE_INTEGER, { kinds: ["user-message", "handoff"] });
  const boundary = events.findLastIndex((event) => event.kind === "handoff"
    && (event.payload?.nextSteps?.next === "done" || event.payload?.cancelled === true));
  const first = events.slice(boundary + 1).find((event) => event.kind === "user-message");
  const text = String(first?.payload?.text ?? "");
  if (text.length <= 8000) return text;
  const saved = store.writeNamedPayload("original-request.md", text);
  return `${text.slice(0, 8000)}\n\nFull request: ${path.join(store.dir, saved.ref)}. Read it before acting; the excerpt is incomplete.`;
}

export function interruptedContext(store, start) {
  const events = store.range({ fromIndex: start.index, limit: 200_000 }).events;
  const latest = new Map();
  for (const e of events) if (e.kind === "session-event" && e.stretch === start.stretch) {
    latest.set(e.payload?.id ?? e.index, e.payload);
  }
  const lines = [];
  for (const e of latest.values()) for (const b of e?.blocks ?? []) {
    if (b.type === "text") lines.push(`Assistant: ${String(b.text ?? "").slice(0, 1800)}`);
    if (b.type === "tool_use") lines.push(`Requested ${b.name} (${b.toolUseId ?? ""}): ${String(typeof b.input === "string" ? b.input : JSON.stringify(b.input)).slice(0, 1600)}`);
    if (b.type === "tool_result") lines.push(`Result (${b.toolUseId ?? ""}): ${String(b.text ?? "").slice(0, 1600)}`);
  }
  return `The ${start.duty} stretch was interrupted before it finished. Its tools may already have changed files or external state. Verify those effects before repeating any action. Do not start over or declare success from an issued command alone.\n\nRecent observed output:\n${lines.slice(-16).join("\n\n").slice(-16_000)}\n\nFull owner record: ${store.logFile}`;
}

export function recoverInterruptedStretch(store, { reason = "The gateway restarted", maxRecoveries = 2 } = {}) {
  const start = latestUnfinishedStretch(store);
  if (!start || store.currentStretch()) return null;
  const prior = store.tail(100, { kinds: ["user-message", "stretch-recovered"] });
  const userIndex = prior.filter((e) => e.kind === "user-message").at(-1)?.index ?? -1;
  const count = prior.filter((e) => e.kind === "stretch-recovered" && e.index > userIndex).length;
  const parked = count >= maxRecoveries;
  const checkpoint = store.writeNamedPayload(`recovery-${start.stretch}.md`, interruptedContext(store, start));
  const ordinal = store.nextHandoffOrdinal();
  // A handoff can land just before the process dies. Keep its decision rather
  // than repeating an already-finished stretch.
  const committed = store.tail(5, { kinds: ["handoff"] }).find((e) => e.stretch === start.stretch)?.payload;
  const next = parked ? "needs-input" : committed?.nextSteps?.next ?? start.duty;
  const handoff = (!parked && committed) || {
    v: 1, stretchId: start.stretch, duty: start.duty, status: "partial", completion: "work",
    summary: `${reason} during ${start.duty}. Work already recorded is preserved. ${parked ? "Automatic recovery stopped after repeated interruptions." : "Resume by checking the last actions, then finish the remaining work."}`,
    evidenceRefs: [{ kind: "log", ref: path.join(store.dir, checkpoint.ref), note: "Observed partial output; not proof of completion" }],
    nextSteps: { next, why: reason, items: ["Read the recovery checkpoint, verify completed effects and continue the original request"] },
    blocker: parked ? { what: "Repeated process interruptions", needs: "restore the service and send a message to continue", who: "user" } : null,
    activeConstraints: [], failedApproaches: [{ approach: `finish ${start.duty}`, why: reason }], surprises: [], forceEscalation: null,
    synthesized: true, interrupted: true,
  };
  if (!committed || parked) {
    store.writeHandoff(ordinal, handoff);
    store.append({ kind: "handoff", duty: start.duty, stretch: start.stretch, payload: { ...handoff, ordinal } });
  }
  store.append({ kind: "stretch-recovered", duty: start.duty, stretch: start.stretch,
    payload: { reason, checkpoint: checkpoint.ref, attempt: count + 1, parked } });
  store.append({ kind: "stretch-ended", duty: start.duty, stretch: start.stretch, payload: {
    ...start.payload, outcome: "interrupted", stoppedReason: "gateway-restarted", next,
    error: reason, handoffRef: committed && !parked ? null : `handoffs/${String(ordinal).padStart(4, "0")}.json`,
  } });
  store.append({ kind: "note", payload: { origin: "gateway", text: handoff.summary } });
  return { handoff, start, parked, context: path.join(store.dir, checkpoint.ref) };
}

export function deploymentInFlight(store) {
  try {
    const job = JSON.parse(fs.readFileSync(path.join(store.dir, "deployment.json"), "utf8"));
    return ["queued", "running"].includes(job.status) && Date.now() - Date.parse(job.updatedAt) < 25 * 60_000 ? job : null;
  } catch { return null; }
}

// A limit or an external operation can finish between native stretches. It
// still needs a durable closing record; an HTTP response alone leaves the UI
// and the next gateway disagreeing about whether the conversation is running.
export function parkConversation(store, { reason, cancelled = false } = {}) {
  const last = store.tail(1, { kinds: ["stretch-started"] })[0];
  const ordinal = store.nextHandoffOrdinal();
  const duty = last?.duty ?? "triage";
  const stretchId = last?.stretch ?? "interrupted";
  const handoff = { v: 1, stretchId, duty, status: "partial", completion: "work",
    summary: reason, evidenceRefs: [], nextSteps: { next: "needs-input", why: reason, items: [] },
    blocker: { what: reason, needs: "Send a message to continue from the saved work", who: "user" },
    activeConstraints: [], failedApproaches: [], surprises: [], forceEscalation: null, synthesized: true,
    ...(cancelled ? { cancelled: true } : {}) };
  store.writeHandoff(ordinal, handoff);
  store.append({ kind: "handoff", duty, stretch: stretchId, payload: { ...handoff, ordinal } });
  store.append({ kind: "stretch-ended", duty, stretch: stretchId,
    payload: { ...last?.payload, next: "needs-input", outcome: cancelled ? "cancelled" : "paused", error: reason } });
  store.append({ kind: "note", payload: { origin: "gateway", text: reason } });
  return handoff;
}

export function cancelConversationDeployment(store) {
  const job = deploymentInFlight(store);
  if (!job) return false;
  const file = path.join(store.dir, "deployment.json");
  const next = { ...job, ...(job.status === "queued" ? { status: "cancelled" } : {}), resumeCancelled: true, updatedAt: new Date().toISOString() };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(temp, file);
  parkConversation(store, { cancelled: true, reason: job.status === "queued"
    ? "Stopped. The queued deployment was cancelled; the saved work is kept."
    : "Conversation stopped. The deployment already in progress will finish, without resuming this conversation." });
  return true;
}

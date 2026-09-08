// Tool registry for the mcp-gateway Fitting.
// Each tool shells out to the underlying Fitting's script.
// GARRISON_COMPOSITION_DIR must be set before importing this module.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStateClient } from "./state-client.mjs";

const COMPOSITION_DIR = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();

// ── Automations engine tools (own-port REST) ────────────────────────────────
// The automations fitting registers its live URL in ~/.garrison/ui-fittings/
// automations.json. These tools let the Operative list + run automations as a
// tool (E5 — provides automation-runner to the operative via MCP).
function automationsBaseUrl() {
  try {
    const home = process.env.GARRISON_HOME ?? path.join(os.homedir(), ".garrison");
    const status = JSON.parse(readFileSync(path.join(home, "ui-fittings", "automations.json"), "utf8"));
    return status.url || null;
  } catch {
    return null;
  }
}

export function automationsAvailable() {
  return automationsBaseUrl() !== null;
}

export async function callListAutomations() {
  const base = automationsBaseUrl();
  if (!base) throw new Error("automations engine not running");
  const res = await fetch(`${base}/api/automations`);
  if (!res.ok) throw new Error(`automations ${res.status}`);
  const { automations } = await res.json();
  return (automations ?? []).map((a) => ({ id: a.id, name: a.name, steps: a.steps?.length ?? 0, trigger: a.trigger?.type }));
}

export async function callRunAutomation(input) {
  const base = automationsBaseUrl();
  if (!base) throw new Error("automations engine not running");
  if (!input?.id) throw new Error("id is required");
  const res = await fetch(`${base}/api/automations/${encodeURIComponent(input.id)}/run?sync=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: input.inputs ?? {}, triggeredBy: "agent" })
  });
  if (!res.ok) throw new Error(`run ${res.status}`);
  const { run } = await res.json();
  return { runId: run.id, status: run.status, steps: run.steps?.map((s) => ({ type: s.type, status: s.status })) ?? [] };
}

// ── Kanban run-engine tools (own-port REST, WS2) ────────────────────────────
// The kanban-loop board registers its live URL in ~/.garrison/ui-fittings/
// kanban-loop.json (same discovery contract as the http-gateway's boardBase).
// fetch_evidence pulls a card's artifact (raw bytes) and create_continuation
// registers a chained successor card. This is CARD CHAINING — distinct from the
// Orchestrator policy's post-task "continuations" (store|ask|route|notify).
function kanbanBaseUrl() {
  try {
    const home = process.env.GARRISON_HOME ?? path.join(os.homedir(), ".garrison");
    const status = JSON.parse(readFileSync(path.join(home, "ui-fittings", "kanban-loop.json"), "utf8"));
    return status.url || (status.port ? `http://127.0.0.1:${status.port}` : null);
  } catch {
    return null;
  }
}

export function kanbanAvailable() {
  return kanbanBaseUrl() !== null;
}

const EVIDENCE_CAP_BYTES = 50 * 1024;

// GET <board>/cards/:id/artifact?ref=... — the board serves RAW file bytes (not
// JSON), so read text and cap it with a truncation note.
export async function callFetchEvidence(input) {
  const base = kanbanBaseUrl();
  if (!base) throw new Error("kanban board not running");
  const cardId = input?.card_id;
  const ref = input?.artifact_ref;
  if (!cardId || !ref) throw new Error("fetch_evidence requires card_id and artifact_ref");
  const url = `${base}/cards/${encodeURIComponent(cardId)}/artifact?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`fetch_evidence ${res.status}: ${t.slice(0, 200)}`);
  }
  const text = await res.text();
  if (text.length > EVIDENCE_CAP_BYTES) {
    return {
      card_id: cardId,
      ref,
      truncated: true,
      bytes: text.length,
      content: text.slice(0, EVIDENCE_CAP_BYTES) + `\n\n…[truncated at ${EVIDENCE_CAP_BYTES} bytes of ${text.length}]`
    };
  }
  return { card_id: cardId, ref, truncated: false, bytes: text.length, content: text };
}

// POST <board>/cards {continues, ...} + engine-context PATCH to plan (mirrors the
// http-gateway's createAutonomousCard move-with-rev-retry). Returns {id, url}.
export async function callCreateContinuation(input) {
  const base = kanbanBaseUrl();
  if (!base) throw new Error("kanban board not running");
  const cardId = input?.card_id;
  if (!cardId) throw new Error("create_continuation requires card_id");
  const payload = { continues: cardId, origin: "continuation", goalMode: true };
  if (typeof input.title === "string" && input.title.trim()) payload.title = input.title.trim();
  if (typeof input.description === "string" && input.description) payload.description = input.description;
  const created = await fetch(`${base}/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!created.ok) {
    const t = await created.text().catch(() => "");
    throw new Error(`create_continuation create ${created.status}: ${t.slice(0, 200)}`);
  }
  const doc = await created.json();
  const id = doc.id || doc.card?.id;
  if (!id) throw new Error("create_continuation: board returned no id");
  // Move to plan (engine-context move). The create-rev goes stale immediately for a
  // no-project card (project inference bumps it), so retry on any failed move.
  let rev = doc.rev ?? doc.card?.rev ?? 0;
  let movedOk = false;
  for (let attempt = 0; attempt < 3 && !movedOk; attempt++) {
    const moved = await fetch(`${base}/cards/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-garrison-engine": "mcp-gateway" },
      body: JSON.stringify({ list: "plan", rev })
    });
    if (moved.ok) { movedOk = true; break; }
    try {
      const fresh = await fetch(`${base}/cards/${encodeURIComponent(id)}`);
      if (fresh.ok) {
        const f = await fresh.json();
        rev = f.card?.rev ?? f.rev ?? rev;
        if ((f.card?.list ?? f.list) === "plan") { movedOk = true; break; }
      }
    } catch { /* retry with the old rev */ }
    await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
  }
  const url = `${base}/#/cards/${id}`;
  return { id, url, moved: movedOk, list: movedOk ? "plan" : "backlog" };
}

// POST <board>/cards then POST <board>/cards/:id/start - the escalation door for a
// conversation that is NOT the place to do the work (D62). The spoken `dialogue`
// duty answers the person in one pass; when what they asked for is a project, a
// bug, a feature or an automation, it makes a card here instead of opening the
// delivery loop inside a conversation someone is listening to. The card starts
// its own conversation (id == card id) and runs there from triage.
//
// `origin_id` is the idempotency key the board does NOT enforce: it has no dedupe
// of its own, so a repeated ask with the same key is looked up and returned
// rather than created twice.
export async function callCreateCard(input) {
  const base = kanbanBaseUrl();
  if (!base) throw new Error("kanban board not running");
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!title) throw new Error("create_card requires title");
  const originId = typeof input?.origin_id === "string" && input.origin_id.trim() ? input.origin_id.trim() : null;
  if (originId) {
    const found = await fetch(`${base}/cards?origin_id=${encodeURIComponent(originId)}`).catch(() => null);
    if (found?.ok) {
      const doc = await found.json().catch(() => null);
      const existing = Array.isArray(doc?.cards) ? doc.cards[0] : doc?.card;
      if (existing?.id) return { id: existing.id, url: `${base}/#/cards/${existing.id}`, started: true, existing: true };
    }
  }
  // `todo` is a manual list: `running` is launcher-only and 400s here.
  const payload = {
    title,
    description: typeof input?.description === "string" ? input.description : "",
    list: typeof input?.list === "string" && input.list === "backlog" ? "backlog" : "todo",
    origin: "dialogue",
    ...(originId ? { origin_id: originId } : {}),
    ...(typeof input?.project === "string" && input.project.trim() ? { project: input.project.trim() } : {})
  };
  const created = await fetch(`${base}/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!created.ok) {
    const t = await created.text().catch(() => "");
    throw new Error(`create_card create ${created.status}: ${t.slice(0, 200)}`);
  }
  const doc = await created.json();
  const id = doc.id || doc.card?.id;
  if (!id) throw new Error("create_card: board returned no id");
  // A card nobody started is a card nobody runs. `start` is what makes the board
  // kick the gateway, which opens the conversation at this id and runs triage.
  let started = false;
  let startNote = null;
  if (input?.start !== false && payload.list !== "backlog") {
    const kicked = await fetch(`${base}/cards/${encodeURIComponent(id)}/start`, { method: "POST" });
    started = kicked.ok || kicked.status === 409;
    if (!started) startNote = `start ${kicked.status}`;
  }
  return { id, url: `${base}/#/cards/${id}`, started, list: payload.list, ...(startNote ? { note: startNote } : {}) };
}

// GET <board>/origins/:origin_id/events?since=... - the PULL delivery a skill/terminal
// session polls for lifecycle + duty-summary events (S3e origin parity). The board
// serves JSON; we render compact lines the operative reads. `since` is a line offset
// (integer) or an ISO timestamp; poll again with the returned next_since to see only
// new events.
export async function callPollOriginEvents(input) {
  const base = kanbanBaseUrl();
  if (!base) throw new Error("kanban board not running");
  const originId = input?.origin_id;
  if (!originId) throw new Error("poll_origin_events requires origin_id");
  const qs = input?.since != null && input.since !== "" ? `?since=${encodeURIComponent(String(input.since))}` : "";
  const url = `${base}/origins/${encodeURIComponent(originId)}/events${qs}`;
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`poll_origin_events ${res.status}: ${t.slice(0, 200)}`);
  }
  const doc = await res.json();
  const events = Array.isArray(doc.events) ? doc.events : [];
  const lines = events.map((e) => {
    const at = e?.at ?? "?";
    const kind = e?.kind ?? "?";
    const cardId = e?.cardId ?? "-";
    const msg = typeof e?.message === "string" ? e.message.replace(/\s+/g, " ").slice(0, 120) : "";
    return `${at} ${kind} ${cardId}${msg ? ` - ${msg}` : ""}`;
  });
  return {
    origin_id: originId,
    count: events.length,
    total: doc.total ?? events.length,
    next_since: doc.nextSince ?? String(doc.total ?? events.length),
    events: lines.join("\n") || "(no events yet)"
  };
}

// ── Card scheduling tools (Omi reminder round-trip) ─────────────────────────
// The board's reminders tell the user exactly "run card <REF>" / "snooze card
// <REF> for 2 hours"; these tools make those phrases executable from ANY
// session. A spoken ref resolves via the board's GET /cards/resolve (full
// ULID, ULID suffix >= 3 chars - the notification short ref is the last 4 -
// or a title fragment). Ambiguity is an ANSWER, never a guess: the 409
// candidate list comes back as text so the model can ask the user.

function shortCardRef(id) {
  return String(id || "").slice(-4).toUpperCase();
}

// GET <board>/cards/resolve?ref=... -> { card } | { ambiguous, candidates, result }.
// The ambiguous shape is a tool RESULT (not a thrown error) so the model relays
// the candidates instead of retrying blind.
async function resolveCardRef(base, ref, toolName) {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new Error(`${toolName} requires card (a card id, id suffix, or title fragment)`);
  }
  const res = await fetch(`${base}/cards/resolve?ref=${encodeURIComponent(ref.trim())}`);
  if (res.status === 409) {
    const doc = await res.json().catch(() => ({}));
    const candidates = Array.isArray(doc.candidates) ? doc.candidates : [];
    const lines = candidates.map((c) => `  ${shortCardRef(c.id)} = ${c.id} [${c.list}] ${c.title ?? "(untitled)"}`);
    return {
      ambiguous: true,
      candidates,
      result: `"${ref.trim()}" is ambiguous - ask the user which card they meant:\n${lines.join("\n")}`
    };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`${toolName} resolve ${res.status}: ${t.slice(0, 200)}`);
  }
  const doc = await res.json().catch(() => ({}));
  if (!doc?.card?.id) throw new Error(`${toolName} resolve: board returned no card`);
  return { card: doc.card };
}

// schedule_card - set, move, or clear a card's schedule. clear=true PATCHes
// scheduledFor null (with the resolved card's rev); otherwise POST /snooze with
// exactly one of until (ISO) / in_minutes (relative). The board re-arms the
// reminder itself (scheduleNotifiedAt resets on snooze).
export async function callScheduleCard(input) {
  const base = kanbanBaseUrl();
  if (!base) throw new Error("kanban board not running");
  const resolved = await resolveCardRef(base, input?.card, "schedule_card");
  if (resolved.ambiguous) return resolved;
  const card = resolved.card;
  const label = `"${card.title ?? "(untitled)"}" (${card.id})`;

  if (input?.clear === true) {
    const res = await fetch(`${base}/cards/${encodeURIComponent(card.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduledFor: null, rev: card.rev ?? 0 })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`schedule_card clear ${res.status}: ${t.slice(0, 200)}`);
    }
    const was = card.scheduledFor ? ` (was ${card.scheduledFor})` : " (it had no schedule)";
    return { card_id: card.id, cleared: true, result: `Cleared the schedule on ${label}${was}` };
  }

  if (input?.pause === true || input?.resume === true) {
    if (!card.schedule) throw new Error("schedule_card pause/resume requires a v5 schedule on the card");
    const enabled = input.resume === true;
    const schedule = { ...card.schedule, enabled };
    if (enabled && !schedule.nextAt && schedule.kind === "once") schedule.nextAt = schedule.at;
    const res = await fetch(`${base}/cards/${encodeURIComponent(card.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schedule, rev: card.rev ?? 0 })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`schedule_card ${enabled ? "resume" : "pause"} ${res.status}: ${t.slice(0, 200)}`);
    }
    return { card_id: card.id, enabled, result: `${enabled ? "Resumed" : "Paused"} ${label}` };
  }

  if (typeof input?.cron === "string" && input.cron.trim()) {
    if (input?.until != null || input?.in_minutes != null) {
      throw new Error("schedule_card cron cannot be combined with until or in_minutes");
    }
    const schedule = {
      kind: "cron",
      action: input?.action === "run" ? "run" : "notify",
      cron: input.cron.trim(),
      timezone: typeof input?.timezone === "string" && input.timezone.trim() ? input.timezone.trim() : "Europe/Lisbon",
      enabled: true,
      targetList: typeof input?.target_list === "string" && input.target_list.trim()
        ? input.target_list.trim()
        : card.list === "scheduled" ? card.schedule?.targetList ?? "backlog" : card.list
    };
    const res = await fetch(`${base}/cards/${encodeURIComponent(card.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schedule, rev: card.rev ?? 0 })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`schedule_card cron ${res.status}: ${t.slice(0, 200)}`);
    }
    const doc = await res.json().catch(() => ({}));
    return {
      card_id: card.id,
      cron: doc.card?.schedule?.cron ?? schedule.cron,
      timezone: doc.card?.schedule?.timezone ?? schedule.timezone,
      next_at: doc.card?.schedule?.nextAt ?? null,
      result: `Scheduled ${label} on cron ${schedule.cron} (${schedule.timezone})`
    };
  }

  const hasUntil = typeof input?.until === "string" && input.until.trim() !== "";
  const hasMinutes = input?.in_minutes != null;
  if (hasUntil === hasMinutes) {
    throw new Error("schedule_card requires exactly one of until (ISO date-time) or in_minutes (positive number) - or clear=true");
  }
  const payload = hasUntil ? { until: input.until.trim() } : { minutes: Number(input.in_minutes) };
  if (input?.action != null) payload.action = input.action;
  const res = await fetch(`${base}/cards/${encodeURIComponent(card.id)}/snooze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`schedule_card snooze ${res.status}: ${t.slice(0, 200)}`);
  }
  const doc = await res.json().catch(() => ({}));
  const scheduledFor = doc.card?.scheduledFor ?? null;
  const action = doc.card?.scheduleAction ?? "notify";
  return {
    card_id: card.id,
    scheduled_for: scheduledFor,
    action,
    result: `Scheduled ${label} for ${scheduledFor} (${action === "run" ? "auto-run" : "notify"})`
  };
}

// run_card - start/advance a card NOW. POST /cards/:id/start clears any
// schedule itself (the start IS the run-it-now override), then either advances
// a manual-list card to its next list or dispatches an agent-list card.
export async function callRunCard(input) {
  const base = kanbanBaseUrl();
  if (!base) throw new Error("kanban board not running");
  const resolved = await resolveCardRef(base, input?.card, "run_card");
  if (resolved.ambiguous) return resolved;
  const card = resolved.card;
  const label = `"${card.title ?? "(untitled)"}" (${card.id})`;
  const runPath = card.list === "scheduled" || card.schedule ? "run-now" : "start";
  const res = await fetch(`${base}/cards/${encodeURIComponent(card.id)}/${runPath}`, { method: "POST" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`run_card start ${res.status}: ${t.slice(0, 200)}`);
  }
  const doc = await res.json().catch(() => ({}));
  const after = doc.card ?? {};
  let what;
  if (doc.occurrence) what = `created occurrence ${doc.card?.id ?? ""}`.trim();
  else if (doc.advanced) what = `advanced to ${doc.advanced}`;
  else if (doc.dispatched) what = doc.batched ? "dispatched (batched with its project group)" : "dispatched to the engine (running)";
  else what = `started (now on ${after.list ?? card.list})`;
  const clearedNote = card.scheduledFor ? " - its schedule was cleared" : "";
  return {
    card_id: card.id,
    list: after.list ?? card.list,
    advanced: doc.advanced ?? null,
    dispatched: doc.dispatched ?? false,
    result: `Started ${label}: ${what}${clearedNote}`
  };
}

// list_scheduled_cards - GET /cards filtered to scheduledFor != null, rendered
// as a compact text table (short ref = last 4 of the ULID, the same ref the
// reminder speaks).
export async function callListScheduledCards() {
  const base = kanbanBaseUrl();
  if (!base) throw new Error("kanban board not running");
  const res = await fetch(`${base}/cards`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`list_scheduled_cards ${res.status}: ${t.slice(0, 200)}`);
  }
  const doc = await res.json().catch(() => ({}));
  const cards = (Array.isArray(doc.cards) ? doc.cards : []).filter((c) => c?.schedule != null || c?.scheduledFor != null);
  if (!cards.length) return { count: 0, result: "no scheduled cards" };
  cards.sort((a, b) => String(a.schedule?.nextAt ?? a.scheduledFor ?? "~").localeCompare(String(b.schedule?.nextAt ?? b.scheduledFor ?? "~")));
  const rows = cards.map((c) => {
    const notified = c.scheduleNotifiedAt ? " (reminder sent)" : "";
    const when = c.schedule?.kind === "cron"
      ? `cron ${c.schedule.cron} (${c.schedule.timezone}) next=${c.schedule.nextAt ?? "paused"}`
      : c.schedule?.nextAt ?? c.scheduledFor;
    return `${shortCardRef(c.id)}  ${c.title ?? "(untitled)"}  ${when}  ${c.schedule?.action ?? c.scheduleAction ?? "notify"}${notified}  [${c.list}]`;
  });
  return { count: cards.length, result: `ref  title  scheduledFor  action  list\n${rows.join("\n")}` };
}

function resolveScript(fittingId, scriptName) {
  return path.join(COMPOSITION_DIR, "apm_modules", "_local", fittingId, "scripts", scriptName);
}

export async function checkProbe(fittingId, scriptName) {
  const scriptPath = resolveScript(fittingId, scriptName);
  if (!existsSync(scriptPath)) return false;
  return new Promise((resolve) => {
    const child = spawn("node", [scriptPath, "--probe"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("exit", (code) => resolve(code === 0 && stdout.trim() === "ok"));
    child.on("error", () => resolve(false));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(false); }, 5000);
  });
}

function callScript(scriptPath, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error(`script timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `script exited with code ${code}`));
      } else {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error(`invalid JSON from script: ${stdout.slice(0, 200)}`));
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`spawn failed: ${err.message}`));
    });
  });
}

// ── Improver Probe capture-fallback (GARRISON-FLOW-V2 S8, D26/E13) ───────────
// Record ONE probe answer into the shared feedback queue — the state service's
// `feedback_queue` since mesh phase 2 (§4.5), where it used to be
// ~/.garrison/improver/feedback-queue.jsonl. Same D26 schema the PostToolUse
// capture and the gateway override writer use, and the payload is that record
// verbatim. This is the belt for surfaces without a PostToolUse hook.
//
// It now stamps an id, which it never did on the file: the id is what makes a
// record deletable from the Signals view. FORMAT SOURCE OF TRUTH:
// improver/lib/feedback-signals.mjs `mintFeedbackId` —
// `fq-<9 chars base36 millis>-<8 hex random>`, replicated rather than imported
// because that module lives in another fitting and cross-fitting imports break
// containment (the same reason the gateway's writer replicates it).
//
// FAILS LOUD: no local fallback file. A feedback loop that silently splits in
// two is worse than one that stops and says so.
function mintFeedbackId(at) {
  const parsed = Date.parse(at ?? "");
  const ms = Number.isFinite(parsed) ? parsed : Date.now();
  const stamp = Math.max(0, ms).toString(36).padStart(9, "0").slice(-9);
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `fq-${stamp}-${rand}`;
}

let cachedStateClient = null;
function stateClient(client = null) {
  if (client) return client;
  cachedStateClient ??= createStateClient({ readFileSync });
  return cachedStateClient;
}

/** Drop the cached client (token rotation, tests). */
export function resetFeedbackClient() {
  cachedStateClient = null;
}

export async function callRecordImproverFeedback(input, { client } = {}) {
  const { session_id, area, question, answer } = input || {};
  if (!area || !question || answer == null) {
    throw new Error("record_improver_feedback requires area, question, answer");
  }
  const at = new Date().toISOString();
  const rec = {};
  rec.id = mintFeedbackId(at);
  if (session_id != null && String(session_id).length) rec.session_id = String(session_id);
  rec.area = String(area);
  rec.question = String(question);
  rec.answer = String(answer);
  rec.timestamp = at;
  rec.provenance = "probe";
  rec.classification = { kind: null, tier: null, plan: null };
  const { id, seq } = await stateClient(client).appendFeedback({
    id: rec.id,
    kind: rec.provenance,
    area: rec.area,
    ...(rec.session_id ? { sessionId: rec.session_id } : {}),
    payload: rec
  });
  return { recorded: true, id, seq };
}

export async function callClassifyTier(input) {
  const scriptPath = resolveScript("tier-classifier", "classify_tier.mjs");
  if (!existsSync(scriptPath)) throw new Error("classify_tier script not found");
  return callScript(scriptPath, input, 30_000);
}

export async function callRunTests(input) {
  const scriptPath = resolveScript("testing", "run_tests.mjs");
  if (!existsSync(scriptPath)) throw new Error("run_tests script not found");
  return callScript(scriptPath, input, 5 * 60_000);
}

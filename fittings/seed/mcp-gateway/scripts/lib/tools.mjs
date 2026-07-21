// Tool registry for the mcp-gateway Fitting.
// Each tool shells out to the underlying Fitting's script.
// GARRISON_COMPOSITION_DIR must be set before importing this module.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
// Append ONE probe answer to ~/.garrison/improver/feedback-queue.jsonl directly.
// Same queue + D26 schema the PostToolUse capture and the gateway override writer
// use; a single O_APPEND write per record keeps concurrent appends from
// interleaving. This is the belt for surfaces without a PostToolUse hook.
export async function callRecordImproverFeedback(input) {
  const { session_id, area, question, answer } = input || {};
  if (!area || !question || answer == null) {
    throw new Error("record_improver_feedback requires area, question, answer");
  }
  const home = process.env.GARRISON_HOME ?? path.join(os.homedir(), ".garrison");
  const file = path.join(home, "improver", "feedback-queue.jsonl");
  const rec = {};
  if (session_id != null && String(session_id).length) rec.session_id = String(session_id);
  rec.area = String(area);
  rec.question = String(question);
  rec.answer = String(answer);
  rec.timestamp = new Date().toISOString();
  rec.provenance = "probe";
  rec.classification = { kind: null, tier: null, plan: null };
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(rec) + "\n", { encoding: "utf8", flag: "a" });
  return { recorded: true, queue: file };
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

// ───────────────────────────────────────────────────────── garrison-control
// Thin HTTP forwarders to the http-gateway's internal endpoints. Only present
// when GARRISON_HTTP_GATEWAY_BASE_URL is set at boot.

const HTTP_GATEWAY_BASE_URL = process.env.GARRISON_HTTP_GATEWAY_BASE_URL ?? "";

function httpGatewayUrl(pathSuffix) {
  if (!HTTP_GATEWAY_BASE_URL) {
    throw new Error("GARRISON_HTTP_GATEWAY_BASE_URL not set");
  }
  return `${HTTP_GATEWAY_BASE_URL.replace(/\/+$/, "")}${pathSuffix}`;
}

async function httpRequest(method, pathSuffix, body) {
  const url = httpGatewayUrl(pathSuffix);
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  let lastErr;
  const delays = [100, 500, 2000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return await response.json().catch(() => ({}));
      const text = await response.text().catch(() => "");
      lastErr = new Error(`${method} ${pathSuffix} → ${response.status}: ${text.slice(0, 200)}`);
      if (response.status >= 500) throw lastErr; // retry
      throw lastErr;
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

export function isGarrisonControlEnabled() {
  return Boolean(HTTP_GATEWAY_BASE_URL);
}

export async function callTalkTo(input) {
  return httpRequest("POST", "/sessions/spawn", {
    soul: input.soul,
    message: input.message,
    project: input.project,
    mode: input.mode,
    tier_hint: input.tier_hint,
    task_title: input.task_title,
    channel: input.channel,
    cwd: input.cwd
  });
}

export async function callWaitFor(input) {
  return httpRequest(
    "POST",
    `/sessions/${encodeURIComponent(input.session_id)}/wait`,
    { timeout_seconds: input.timeout_seconds }
  );
}

export async function callListActiveSessions(input = {}) {
  const params = new URLSearchParams();
  if (input.parent) params.set("parent", input.parent);
  if (input.mode) params.set("mode", input.mode);
  if (input.soul) params.set("soul", input.soul);
  const suffix = params.toString() ? `?${params}` : "";
  return httpRequest("GET", `/sessions${suffix}`);
}

export async function callEndSession(input) {
  return httpRequest("POST", `/sessions/by-soul/${encodeURIComponent(input.soul)}/end`);
}

export async function callListWorkdirs(input) {
  return httpRequest("GET", `/workdirs?soul=${encodeURIComponent(input.soul)}`);
}

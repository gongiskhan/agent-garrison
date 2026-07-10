// coord-mail.mjs — the coordination mail abstraction (GARRISON-FLOW-V2 S2, Q9).
//
// Dual transport with a durable file record FIRST: every coordination notice (a
// light-overlap courtesy, an interference alert, an offender notification) is
// written as a JSON record into BOTH the sender's and recipient's runDirs — that
// is the evidence (D4) and it never depends on agent-mail being up. We then make a
// bounded best-effort attempt to also push it through the shared agent-mail MCP
// (the exact status-file + streamable-http pattern coord-mcp's agentmail.mjs
// proved); the resolved transport ("agent-mail" | "file") is recorded honestly in
// both copies. Finally a mail event lands on both cards and a kind:"mail" row on
// the intents ledger so external sessions' digests surface it.
//
// agent-mail is ABSENT on this box (A1); everything here works fully without it —
// only cross-session push visibility is lost, and the ledger row partially covers
// that.
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { atomicWriteJSON, updateCardCAS } from "./board.mjs";
import { appendMailLedgerRow } from "./coordination.mjs";
import { ulid } from "./ulid.mjs";

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".garrison");
}

// The own-port status file coord-agentmail writes when it is up (same contract
// agentmail.mjs reads). Returns the record or null.
function agentMailRecord() {
  try {
    const r = JSON.parse(readFileSync(path.join(garrisonHome(), "ui-fittings", "coord-agentmail.json"), "utf8"));
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}

// Parse a streamable-http MCP body (plain JSON or SSE data: frames) — the last
// parseable data frame wins (mirrors agentmail.mjs:parseMcpBody).
function parseMcpBody(text, contentType) {
  if (contentType && contentType.includes("text/event-stream")) {
    for (const line of text.split("\n").reverse()) {
      const m = line.match(/^data:\s*(.*)$/);
      if (m) {
        try { return JSON.parse(m[1]); } catch { /* keep scanning */ }
      }
    }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

// Best-effort push through agent-mail. Session-less streamable-http: initialize,
// then tools/call send_message with kanban:<cardId> identities. Bounded by
// timeoutMs; ANY failure (no status file, down, error result) returns false so the
// caller falls back to the file transport. Returns true only on a non-error result.
async function tryAgentMail({ fromCard, toCard, subject, body }, timeoutMs = 2500) {
  const rec = agentMailRecord();
  const base = rec && rec.mcpUrl ? rec.mcpUrl : null;
  if (!base) return false;
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const post = async (payload) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base, { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal });
      return parseMcpBody(await res.text(), res.headers.get("content-type"));
    } finally {
      clearTimeout(t);
    }
  };
  try {
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "kanban-loop", version: "0.1" } } });
    const r = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: {
          from: `kanban:${fromCard.id}`,
          to: `kanban:${toCard.id}`,
          subject: subject || "",
          body: body || ""
        }
      }
    });
    return Boolean(r && !r.error);
  } catch {
    return false;
  }
}

const mailFile = (runDir, id) => path.join(runDir, "coordination", "mail", `${id}.json`);

// Send a coordination notice. Writes the durable record into both runDirs, tries
// agent-mail (bounded), records the transport honestly, appends a mail event to
// both cards, and appends a ledger mail row. Returns the record.
export async function sendCoordMail({ root, fromCard, toCard, subject, body, repoPath = null, now = () => new Date().toISOString() }) {
  const at = typeof now === "function" ? now() : now;
  const id = ulid();
  // Try agent-mail first (bounded), so the persisted record carries the true
  // transport. The bound guarantees the file write is never blocked indefinitely.
  const delivered = await tryAgentMail({ fromCard, toCard, subject, body });
  const transport = delivered ? "agent-mail" : "file";
  const record = { id, at, fromCardId: fromCard.id, toCardId: toCard.id, subject: subject || "", body: body || "", transport };

  for (const runDir of [fromCard.runDir, toCard.runDir]) {
    if (!runDir) continue;
    try { await atomicWriteJSON(mailFile(runDir, id), record); } catch { /* evidence best-effort */ }
  }

  // A mail event on both cards (best-effort CAS-retry — never clobbers a concurrent
  // engine write).
  if (root) {
    const evt = (dir) => ({ at, kind: "mail", message: `Mail ${dir} ${dir === "to" ? short(fromCard) : short(toCard)}: ${subject || "(no subject)"} [${transport}]`, detail: body || null });
    await updateCardCAS(root, fromCard.id, (c) => ({ ...c, events: appendEvent(c, evt("to")) })).catch(() => {});
    await updateCardCAS(root, toCard.id, (c) => ({ ...c, events: appendEvent(c, evt("from")) })).catch(() => {});
  }

  // Outward-facing ledger row (Q9 step 3) — best-effort.
  try { appendMailLedgerRow({ repoPath, fromCard, toCard, subject, body, now: at }); } catch { /* best-effort */ }

  return record;
}

function short(card) {
  const title = card?.title || card?.id || "card";
  const tail = String(card?.id || "").slice(-6);
  return tail ? `${title} (${tail})` : String(title);
}

const MAX_EVENTS = 60;
function appendEvent(card, event) {
  const events = Array.isArray(card?.events) ? card.events.slice() : [];
  events.push(event);
  return events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
}

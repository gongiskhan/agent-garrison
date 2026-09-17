// Read the real board and equipped connector catalog through existing APIs.
// Connector credentials are resolved internally and never become tool output.
import path from "node:path";
import { existsSync } from "node:fs";
import { kanbanBaseUrl, resolveCardRef } from "./tools.mjs";

async function readJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Garrison request failed (HTTP ${res.status})`);
  return res.json();
}

export async function callListCards(input = {}) {
  const base = kanbanBaseUrl();
  if (!base) throw new Error("Kanban board is not running");
  const doc = await readJson(`${base}/cards`);
  if (!Array.isArray(doc.cards)) throw new Error("Kanban returned no card list");
  const query = String(input.query ?? "").trim().toLowerCase();
  const cards = doc.cards.filter((c) => {
    if (!input.include_closed && !input.list && ["done", "archived"].includes(c.list)) return false;
    if (input.list && c.list !== input.list) return false;
    if (input.project && c.project !== input.project) return false;
    return !query || `${c.id} ${c.title ?? ""} ${c.description ?? ""}`.toLowerCase().includes(query);
  });
  const offset = Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 100) : 50;
  const page = cards.slice(offset, offset + limit).map((c) => ({
    id: c.id, title: c.title, list: c.list, status: c.status, project: c.project,
    priority: c.priority, due: c.due, dueDate: c.dueDate, scheduledFor: c.scheduledFor,
    schedule: c.schedule, labels: c.labels, duty: c.duty,
    attentionReason: c.attentionReason,
    url: `/embed/kanban-loop?card=${encodeURIComponent(c.id)}`,
  }));
  return { cards: page, total: cards.length, offset,
    next_offset: offset + page.length < cards.length ? offset + page.length : null };
}

export async function callGetCard(input = {}) {
  const base = kanbanBaseUrl();
  if (!base) throw new Error("Kanban board is not running");
  const resolved = await resolveCardRef(base, input.card, "garrison_get_card");
  if (resolved.ambiguous) return resolved;
  const doc = await readJson(`${base}/cards/${encodeURIComponent(resolved.card.id)}`);
  const c = doc.card ?? doc;
  return { card: { id: c.id, title: c.title, description: c.description,
    list: c.list, status: c.status, project: c.project, priority: c.priority,
    due: c.due, dueDate: c.dueDate, scheduledFor: c.scheduledFor, schedule: c.schedule,
    labels: c.labels, checklist: c.checklist, duty: c.duty,
    attentionReason: c.attentionReason, completionSummary: c.completionSummary,
    url: `/embed/kanban-loop?card=${encodeURIComponent(c.id)}` } };
}

async function connectorCatalog({ env = process.env, fetchImpl = fetch } = {}) {
  const base = env.GARRISON_APP_URL?.trim() || env.GARRISON_BASE_URL?.trim()
    || (/^[0-9]+$/.test(env.GARRISON_APP_PORT ?? "") ? `http://127.0.0.1:${env.GARRISON_APP_PORT}` : null);
  if (!base) throw new Error("Garrison app URL is not configured for this session");
  const [status, library] = await Promise.all([
    readJson(`${base.replace(/\/+$/, "")}/api/connectors`, fetchImpl),
    readJson(`${base.replace(/\/+$/, "")}/api/library`, fetchImpl),
  ]);
  const entries = library.fittings ?? library.library ?? library.entries ?? library;
  if (!Array.isArray(entries) || !Array.isArray(status.connectors)) {
    throw new Error("Garrison returned an invalid connector catalog");
  }
  return status.connectors.filter((c) => c.equipped === true).map((c) => {
    const entry = entries.find((e) => e.id === c.fittingId
      && e.metadata?.provides?.some((p) => p.kind === "connector" && p.name === c.id));
    const fittingId = entry?.id;
    const script = env.GARRISON_COMPOSITION_DIR && /^[a-zA-Z0-9_-]+$/.test(fittingId ?? "")
      ? path.join(env.GARRISON_COMPOSITION_DIR, "apm_modules", "_local", fittingId, "scripts", "connector.mjs") : null;
    return { id: c.id, name: c.name, summary: c.summary, auth: c.auth,
      connected: c.statusKnown === false ? null : c.sealed === true,
      callable: !!script && existsSync(script), actions: entry?.metadata?.connector?.actions ?? [], script };
  });
}

export async function callListConnectors(input = {}, deps = {}) {
  const catalog = await connectorCatalog(deps);
  return { connectors: catalog.filter((c) => !input.connector || c.id === input.connector)
    .map(({ script, ...c }) => c),
    guidance: "Use garrison_connector_read for actions explicitly marked mutates=false. Credentials stay internal. A disconnected service needs connecting in /connectors." };
}

export async function callConnectorRead(input = {}, deps = {}) {
  const catalog = await connectorCatalog(deps);
  const connector = catalog.find((c) => c.id === input.connector);
  if (!connector) throw new Error("Connector is not equipped in the active composition; use garrison_list_connectors");
  const action = connector.actions.find((a) => a.name === input.action);
  if (!action) throw new Error(`Unknown action for ${connector.id}; use garrison_list_connectors`);
  // Fail closed on missing metadata as well as known writes. This MCP only reads.
  if (action.mutates !== false) throw new Error("This connector tool accepts only actions explicitly declared read-only");
  if (!connector.callable) throw new Error(`The ${connector.id} connector has no installed callable script`);
  if (input.args != null && (typeof input.args !== "object" || Array.isArray(input.args))) throw new Error("args must be an object");
  // Load the shared invoker only for a connector read. A composition without
  // Automations still has working board reads and connector discovery.
  const invoker = deps.authEnv && deps.runConnector ? {} : await import("../../../automations/lib/connector-invoke.mjs");
  const authEnv = await (deps.authEnv ?? invoker.defaultConnectorAuthEnv)(connector.id);
  if (authEnv.__awaiting_connector) return { ok: false, awaiting_connector: true, connector: connector.id, url: "/connectors" };
  const result = await (deps.runConnector ?? invoker.defaultRunConnector)({ scriptPath: connector.script,
    action: action.name, args: input.args ?? {}, authEnv });
  // A faulty provider must not echo its delivered token into the conversation.
  let serialized = JSON.stringify(result ?? { ok: false, error: "Connector returned no result" });
  for (const secret of Object.values(authEnv)) {
    if (typeof secret === "string" && secret) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
  }
  return JSON.parse(serialized);
}

export const ASSISTANT_TOOL_DEFINITIONS = [
  { name: "garrison_list_cards", description: "Read the real Kanban board to answer questions about tasks, priorities and due work. Open cards by default; page through next_offset. Inspect details with garrison_get_card. Calendar events are separate connector data.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, list: { type: "string" }, project: { type: "string" }, include_closed: { type: "boolean" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } } }, annotations: { readOnlyHint: true } },
  { name: "garrison_get_card", description: "Read a card's description, checklist, due dates and progress by full ID, ID suffix or title fragment. Ambiguity returns candidates; never guess.",
    inputSchema: { type: "object", properties: { card: { type: "string" } }, required: ["card"] }, annotations: { readOnlyHint: true } },
  { name: "garrison_list_connectors", description: "Discover equipped Garrison connectors, actual connection state and available actions/arguments (Google Calendar/Drive/Gmail, messaging and other services). No credentials are returned.",
    inputSchema: { type: "object", properties: { connector: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "garrison_connector_read", description: "Read connected service data through a discovered catalog action. For today's agenda use google calendar.list_events with time_min/time_max covering the user's local day. Only actions explicitly marked mutates=false are accepted; no writes.",
    inputSchema: { type: "object", properties: { connector: { type: "string" }, action: { type: "string" }, args: { type: "object", additionalProperties: true } }, required: ["connector", "action"] }, annotations: { readOnlyHint: true } },
];

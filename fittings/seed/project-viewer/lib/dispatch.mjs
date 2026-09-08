// Dispatching prompts to the operative, server-to-server.
//
// Why the server relays instead of the browser posting directly: kanban-loop and
// the gateway both enforce same-origin on mutations, so a button in this
// fitting's page cannot POST to them. It posts here, and this module makes the
// loopback call — which is exactly what the drill fitting does for its testing
// tasks.
//
// Two transports, chosen by how long the work takes:
//   card  — a kanban card. Everything real goes here, because a chat turn caps
//           out around five minutes and an analysis run takes longer than that.
//   chat  — a gateway turn. Only for a short question with an answer to show
//           in the page.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CARD_LIMIT = 3800; // stay clear of the ~4000-char argument ceiling

function garrisonHome(env = process.env) {
  const home = env.GARRISON_HOME ? expandHome(env.GARRISON_HOME) : path.join(os.homedir(), ".garrison");
  return home;
}

function expandHome(p) {
  const s = String(p);
  return s.startsWith("~") ? path.join(os.homedir(), s.slice(1)) : s;
}

/**
 * Which instance this fitting is running as, for error messages that would
 * otherwise be misleading. A peer "not running" is usually a peer running under a
 * different profile's home, and saying which home we looked in turns a dead end into
 * a diagnosis.
 */
export function instanceName(env = process.env) {
  if (env.GARRISON_INSTANCE_ID) return env.GARRISON_INSTANCE_ID;
  const home = garrisonHome(env);
  const base = path.basename(home);
  if (base === ".garrison") return "prod";
  if (base.startsWith(".garrison-")) return base.slice(".garrison-".length);
  return home;
}

/**
 * Find a peer own-port fitting through its status file. The status file is the
 * single source of truth for a fitting's port — never probe or guess, and never
 * hardcode.
 */
export async function peerUrl(fittingId, env = process.env) {
  const file = path.join(garrisonHome(env), "ui-fittings", `${fittingId}.json`);
  try {
    const status = JSON.parse(await readFile(file, "utf8"));
    if (!status?.port) return null;
    return status.url ?? `http://127.0.0.1:${status.port}`;
  } catch {
    return null;
  }
}

export function gatewayUrl(env = process.env) {
  if (env.GARRISON_GATEWAY_URL) return env.GARRISON_GATEWAY_URL.replace(/\/$/, "");
  if (env.GARRISON_GATEWAY_PORT) return `http://127.0.0.1:${env.GARRISON_GATEWAY_PORT}`;
  return null;
}

/**
 * Create a kanban card carrying the prompt.
 *
 * Only the stable core of the card payload is sent. handleCreateCard accepts a
 * long and fast-moving list of optional fields; sending the minimum keeps this
 * from breaking every time that list grows.
 */
/** Lists on the board that mean the job is finished or abandoned. */
const CLOSED_LISTS = new Set(["done", "archived", "cancelled"]);

const pendingCards = new Map();
const MAX_REPLY_BYTES = 1024 * 1024;

/** One deadline covers connection, response body and all calls in an action. */
async function withDeadline(timeoutMs, operation) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("request deadline exceeded"));
    }, Math.max(1, Math.min(timeoutMs, 120_000)));
  });
  try { return await Promise.race([operation(controller.signal), expired]); }
  finally { clearTimeout(timer); }
}

async function requestJson(url, options, signal) {
  signal?.throwIfAborted();
  const res = await fetch(url, { ...options, signal });
  if (!res.ok) throw new Error("peer refused request");
  let text = "";
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_REPLY_BYTES) throw new Error("peer response limit exceeded");
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString("utf8");
    } finally { void reader.cancel().catch(() => {}); }
  } else {
    text = await res.text();
    if (Buffer.byteLength(text) > MAX_REPLY_BYTES) throw new Error("peer response limit exceeded");
  }
  signal?.throwIfAborted();
  return JSON.parse(text);
}

/** A failed duplicate check must never start another expensive job. */
export async function openCardWithOrigin(base, originId, { signal } = {}) {
  if (!originId) return null;
  const read = async deadlineSignal => {
    const body = await requestJson(`${base}/cards`, { headers: { accept: "application/json" } }, deadlineSignal);
    const cards = Array.isArray(body) ? body : body?.cards;
    if (!Array.isArray(cards)) throw new Error("invalid board response");
    return cards.find(c => typeof c?.id === "string" && c.id &&
      (c.origin_id ?? c.originId) === originId && !c.deleted && !c.deletedAt &&
      !CLOSED_LISTS.has(String(c.list ?? ""))) ?? null;
  };
  return signal ? read(signal) : withDeadline(10_000, read);
}

export async function dispatchCard(input, env = process.env) {
  const key = input.originId ? `${garrisonHome(env)}\0${input.originId}` : null;
  if (key && pendingCards.has(key)) return pendingCards.get(key);
  const work = dispatchCardOnce(input, env);
  if (key) pendingCards.set(key, work);
  try { return await work; }
  finally { if (key && pendingCards.get(key) === work) pendingCards.delete(key); }
}

async function dispatchCardOnce({ title, prompt, project, originId, timeoutMs = 10_000 }, env) {
  const base = await peerUrl("kanban-loop", env);
  if (!base) return {
    ok: false, status: 502, code: "noKanban", instance: instanceName(env),
    error: `no kanban-loop is running in this instance (${instanceName(env)}), so there is nowhere to put the card. ` +
      "A kanban under a different profile's home is invisible from here by design.",
  };
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > CARD_LIMIT) {
    return { ok: false, status: 400, error: `prompt must contain 1–${CARD_LIMIT} characters` };
  }
  return withDeadline(timeoutMs, async signal => {
    const existing = await openCardWithOrigin(base, originId, { signal });
    if (existing) return { ok: true, transport: "card", duplicate: true,
      code: "alreadyQueued", cardId: existing.id, list: existing.list ?? null };
    const body = await requestJson(`${base}/cards`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, description: prompt, project, targetList: "todo",
        origin: "project-viewer", origin_id: originId }),
    }, signal);
    const card = body?.card ?? body;
    if (typeof card?.id !== "string" || !card.id.trim()) throw new Error("missing card receipt");
    return { ok: true, transport: "card", cardId: card.id, list: card.list ?? "todo" };
  }).catch(() => ({ ok: false, status: 502,
    error: "The board request could not be confirmed. Check the board before retrying; no automatic retry was made." }));
}

/** A short gateway turn, with the same bound on connection and body consumption. */
export async function dispatchChat({ prompt, timeoutMs = 90_000 }, env = process.env) {
  const base = gatewayUrl(env);
  if (!base) return { ok: false, status: 502, code: "noGateway",
    error: "no gateway is configured for this composition" };
  try {
    const body = await withDeadline(timeoutMs, signal => requestJson(`${base}/chat`, {
      method: "POST", headers: { "content-type": "application/json", "x-garrison-origin": "channel" },
      body: JSON.stringify({ channel: "project-viewer", message: prompt,
        classification: { taskType: "other", tier: "T0-trivial" }, suppressContinuations: true, timeoutMs }),
    }, signal));
    const reply = body?.reply ?? body?.message;
    if (typeof reply !== "string") throw new Error("missing gateway reply");
    return { ok: true, transport: "chat", reply };
  } catch { return { ok: false, status: 502, error: "The gateway reply could not be confirmed." }; }
}

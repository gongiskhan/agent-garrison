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

/**
 * An unfinished card already carrying this origin, or null.
 *
 * Deliberately forgiving: if the board cannot be listed, or answers something this
 * does not understand, the answer is "no duplicate" and the card gets created. A
 * duplicate card is a nuisance; refusing to queue real work because a GET failed
 * would be worse.
 */
export async function openCardWithOrigin(base, originId) {
  if (!originId) return null;
  let cards;
  try {
    const res = await fetch(`${base}/cards`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    cards = Array.isArray(body) ? body : (body?.cards ?? null);
  } catch {
    return null;
  }
  if (!Array.isArray(cards)) return null;
  return (
    cards.find(
      (c) => (c?.origin_id ?? c?.originId) === originId && !CLOSED_LISTS.has(String(c?.list ?? ""))
    ) ?? null
  );
}

export async function dispatchCard({ title, prompt, project, originId }, env = process.env) {
  const base = await peerUrl("kanban-loop", env);
  if (!base) {
    // `code` so the client can translate it. The English `error` stays as the
    // fallback for anything without a translation and for the logs, but a reader on
    // a Portuguese page must not be handed an English sentence — which is exactly
    // what this path did until a screenshot showed it.
    return {
      ok: false,
      status: 502,
      code: "noKanban",
      // Naming the instance matters: a kanban IS usually running, just under the
      // other profile's home, and "not running" sent people looking for a dead
      // process instead of at the isolation between instances.
      instance: instanceName(env),
      error:
        `no kanban-loop is running in this instance (${instanceName(env)}), so there is nowhere to put the card. ` +
        "A kanban under a different profile's home is invisible from here by design.",
    };
  }
  if (prompt.length > CARD_LIMIT) {
    return {
      ok: false,
      status: 400,
      error: `prompt is ${prompt.length} characters, over the ${CARD_LIMIT} limit — reference store paths instead of inlining content`,
    };
  }

  // Do not queue the same job twice. `origin_id` was already being sent and the
  // board already stored it — it was just never read back, so pressing the button
  // twice put two identical cards in the backlog. For a run whose whole point is
  // that it costs real money once, that is the expensive kind of bug.
  const existing = await openCardWithOrigin(base, originId);
  if (existing) {
    return {
      ok: true,
      transport: "card",
      duplicate: true,
      code: "alreadyQueued",
      cardId: existing.id,
      list: existing.list ?? null,
    };
  }

  let res;
  try {
    res = await fetch(`${base}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        description: prompt,
        project,
        origin: "project-viewer",
        origin_id: originId,
      }),
    });
  } catch (err) {
    return { ok: false, status: 502, error: `could not reach kanban-loop: ${err.message}` };
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: `kanban refused the card: ${text.slice(0, 300)}` };
  }
  let card = null;
  try {
    card = JSON.parse(text);
  } catch {
    card = null;
  }
  const id = card?.card?.id ?? card?.id ?? null;
  return { ok: true, transport: "card", cardId: id, card };
}

/** A short gateway turn, for the one button that shows its answer in the page. */
export async function dispatchChat({ prompt, timeoutMs = 90000 }, env = process.env) {
  const base = gatewayUrl(env);
  if (!base) {
    return {
      ok: false,
      status: 502,
      code: "noGateway",
      error: "no gateway is configured for this composition",
    };
  }
  let res;
  try {
    res = await fetch(`${base}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-origin": "channel" },
      body: JSON.stringify({
        channel: "project-viewer",
        message: prompt,
        classification: { taskType: "other", tier: "T0-trivial" },
        suppressContinuations: true,
        timeoutMs,
      }),
    });
  } catch (err) {
    return { ok: false, status: 502, error: `could not reach the gateway: ${err.message}` };
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: `gateway refused the turn: ${text.slice(0, 300)}` };
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { reply: text };
  }
  return { ok: true, transport: "chat", reply: body?.reply ?? body?.message ?? text };
}

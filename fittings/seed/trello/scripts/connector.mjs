#!/usr/bin/env node
// Trello connector — the uniform Garrison connector executor contract every
// connector Fitting implements, so the Automations engine can call any catalog
// action the same way:
//
//   node connector.mjs --probe                    -> "connectorOk" (verify; no secrets)
//   node connector.mjs catalog                    -> JSON { service, auth, actions[] }
//   node connector.mjs call <action> [argsJson]   -> JSON { ok, result }
//                                                    | { ok:false, error, awaiting_connector }
//
// Secrets are delivered SCOPED via env (the Vault materializes only this
// connector's secret_scope): TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID. They
// reach this call's env one of two ways — injected by the Automations engine, or
// self-resolved here (a direct call, e.g. the Operative over bash) from
// Garrison's /api/connectors/trello/auth-env route. The values never appear in
// the manifest and are redacted from logs.

import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CATALOG = {
  service: "trello",
  auth: "api_key",
  actions: [
    { name: "lists", args: [], mutates: false, description: "List the board's lists" },
    { name: "list_cards", args: ["list_id"], mutates: false, description: "Open cards in a list" },
    { name: "create_card", args: ["list_id", "name", "desc"], mutates: true, description: "Create a card" },
    { name: "move_card", args: ["card_id", "to_list_id"], mutates: true, description: "Move a card between lists" },
    { name: "archive_card", args: ["card_id"], mutates: true, description: "Archive (complete) a card" },
    { name: "comment", args: ["card_id", "text"], mutates: true, description: "Add a comment to a card" }
  ]
};

class NotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.awaiting_connector = true;
  }
}

// The 0600 per-machine capability token that gates Garrison's auth-env route.
// Same file the Automations engine reads; absent (or unreadable) => "" and we
// simply can't self-resolve, which surfaces as awaiting_connector below.
function internalToken() {
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const file = process.env.GARRISON_INTERNAL_TOKEN_PATH || path.join(home, "internal-token");
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

// Self-resolve this connector's scoped secrets from Garrison when nothing
// pre-injected them. Mirrors the engine's auth-env fetch: POST with the internal
// token; a non-2xx (incl. 409 not-connected) yields {} so the caller falls
// through to awaiting_connector. Never throws — auth failures are the caller's
// to signal.
async function fetchInjectedEnv(fetchImpl) {
  const tok = internalToken();
  if (!tok) return {};
  const base = process.env.GARRISON_BASE_URL || "http://127.0.0.1:7777";
  try {
    const res = await fetchImpl(`${base}/api/connectors/trello/auth-env`, {
      method: "POST",
      headers: { "x-garrison-internal": tok }
    });
    if (!res.ok) return {};
    const json = await res.json();
    return json.env ?? {};
  } catch {
    return {};
  }
}

async function resolveCreds(env, fetchImpl) {
  let key = env.TRELLO_KEY;
  let token = env.TRELLO_TOKEN;
  let board = env.TRELLO_BOARD_ID;
  if (!key || !token) {
    const injected = await fetchInjectedEnv(fetchImpl);
    key = key || injected.TRELLO_KEY;
    token = token || injected.TRELLO_TOKEN;
    board = board || injected.TRELLO_BOARD_ID;
  }
  if (!key || !token) {
    throw new NotConnectedError("Trello not connected (seal TRELLO_KEY/TRELLO_TOKEN in the Vault)");
  }
  return { key, token, board };
}

export async function runAction({ action, args = {}, env = process.env, fetchImpl = fetch }) {
  const { key, token, board } = await resolveCreds(env, fetchImpl);
  const auth = `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
  const api = "https://api.trello.com/1";
  const jsonHeaders = { "content-type": "application/json" };
  const call = async (url, opts) => {
    const res = await fetchImpl(url, opts);
    if (!res.ok) throw new Error(`trello ${res.status}: ${await res.text()}`);
    return res.json();
  };
  // Encode every id placed in a URL path so an action arg cannot rewrite the
  // requested path/query.
  const seg = (v) => encodeURIComponent(String(v ?? ""));
  switch (action) {
    case "lists":
      if (!board) throw new Error("TRELLO_BOARD_ID not configured for this connector");
      return call(`${api}/boards/${seg(board)}/lists?${auth}`);
    case "list_cards":
      return call(`${api}/lists/${seg(args.list_id)}/cards?${auth}`);
    case "create_card":
      return call(`${api}/cards?${auth}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ idList: args.list_id, name: args.name, desc: args.desc ?? "" })
      });
    case "move_card":
      return call(`${api}/cards/${seg(args.card_id)}?${auth}`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ idList: args.to_list_id })
      });
    case "archive_card":
      return call(`${api}/cards/${seg(args.card_id)}?${auth}`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ closed: true })
      });
    case "comment":
      return call(`${api}/cards/${seg(args.card_id)}/actions/comments?${auth}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ text: args.text })
      });
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === "--probe") {
    // Verify must not require live secrets — just confirm the executor + catalog.
    if (!Array.isArray(CATALOG.actions) || CATALOG.actions.length === 0) {
      console.error("catalog empty");
      return 1;
    }
    console.log("connectorOk");
    return 0;
  }
  if (cmd === "catalog") {
    process.stdout.write(JSON.stringify(CATALOG));
    return 0;
  }
  if (cmd === "call") {
    const action = argv[1];
    let args = {};
    if (argv[2]) {
      try { args = JSON.parse(argv[2]); }
      catch { console.error("args must be JSON"); return 2; }
    }
    try {
      const result = await runAction({ action, args });
      process.stdout.write(JSON.stringify({ ok: true, result }));
      return 0;
    } catch (err) {
      process.stdout.write(JSON.stringify({ ok: false, error: err.message, awaiting_connector: Boolean(err.awaiting_connector) }));
      return 1;
    }
  }
  console.error("usage: connector.mjs --probe | catalog | call <action> [argsJson]");
  return 2;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => { console.error(err.stack ?? err.message); process.exit(1); }
  );
}

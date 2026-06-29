#!/usr/bin/env node
// Slack connector — the connector half of Slack's dual role (it is also a
// Channel). Exposes outbound Slack Web API actions as a catalog:
//
//   node connector.mjs --probe                    -> "connectorOk" (verify; no secrets)
//   node connector.mjs catalog                    -> JSON { service, auth, actions[] }
//   node connector.mjs call <action> [argsJson]   -> JSON { ok, result } | { ok:false, awaiting_connector }
//
// SLACK_BOT_TOKEN arrives scoped via env (the Vault materializes only this
// connector's secret_scope); it never appears in the manifest or logs.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CATALOG = {
  service: "slack",
  auth: "api_key",
  actions: [
    { name: "send_message", args: ["channel", "text"], mutates: true, description: "Post a message to a channel." },
    { name: "list_channels", args: ["limit"], mutates: false, description: "List conversations the bot can see." }
  ]
};

class NotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.awaiting_connector = true;
  }
}

function token(env) {
  const t = env.SLACK_BOT_TOKEN;
  if (!t) throw new NotConnectedError("Slack not connected (seal SLACK_BOT_TOKEN in the Vault)");
  return t;
}

export async function runAction({ action, args = {}, env = process.env, fetchImpl = fetch }) {
  const auth = { Authorization: `Bearer ${token(env)}` };
  // Slack returns HTTP 200 with { ok:false, error } on logical failures.
  const slack = async (method, body, httpMethod = "POST") => {
    const url = `https://slack.com/api/${method}`;
    const res =
      httpMethod === "GET"
        ? await fetchImpl(`${url}?${new URLSearchParams(body)}`, { headers: auth })
        : await fetchImpl(url, { method: "POST", headers: { ...auth, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(`slack ${method}: ${json.error ?? res.status}`);
    return json;
  };
  switch (action) {
    case "send_message":
      return slack("chat.postMessage", { channel: args.channel, text: args.text });
    case "list_channels":
      return slack("conversations.list", { limit: String(args.limit ?? 100) }, "GET");
    default:
      throw new Error(`unknown action: ${action}`);
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === "--probe") {
    if (!Array.isArray(CATALOG.actions) || CATALOG.actions.length === 0) { console.error("catalog empty"); return 1; }
    console.log("connectorOk");
    return 0;
  }
  if (cmd === "catalog") { process.stdout.write(JSON.stringify(CATALOG)); return 0; }
  if (cmd === "call") {
    const action = argv[1];
    let args = {};
    if (argv[2]) { try { args = JSON.parse(argv[2]); } catch { console.error("args must be JSON"); return 2; } }
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

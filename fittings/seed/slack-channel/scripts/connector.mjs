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
//
// send_message is buffered: an agent-triggered post is parked in the adapter's
// outbox for a cancel window and only posted when it elapses uncancelled (see
// ../lib/outbox.js). A human acting in a UI bypasses the buffer; nothing else
// does.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import outbox from "../lib/outbox.js";

const { resolveSendContext } = outbox;

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

// The running adapter announces itself in ~/.garrison/ui-fittings/slack-channel.json
// (scripts/slack-adapter.js writeStatusFile) — the same discovery contract
// kanban-loop's fan-out uses, and the same one whatsapp-web's connector uses to
// find its daemon. SLACK_CHANNEL_STATUS_FILE is a test-only override so tests
// never touch the real ~/.garrison.
function adapterBaseUrl(env) {
  const file =
    env.SLACK_CHANNEL_STATUS_FILE ||
    path.join(env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "ui-fittings", "slack-channel.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed?.url === "string" ? parsed.url.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

// Park an agent-triggered post instead of sending it. The cancel window lives in
// the adapter, not here: this process exits in milliseconds and could not hold a
// 60-second timer, let alone answer a cancel. With no adapter running there is
// nowhere to park it AND nothing to drain it, so this fails closed rather than
// falling back to an immediate, uncancellable post.
async function queueSend({ env, fetchImpl, channel, text, context }) {
  const base = adapterBaseUrl(env);
  if (!base) {
    throw new Error(
      "send_message is buffered for a cancel window and the Slack adapter (which owns that window) is not running — start scripts/slack-adapter.js, or have a human send it from a UI."
    );
  }
  const res = await fetchImpl(`${base}/outbox`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "send_message", payload: { channel, text }, summary: `Slack to ${channel}`, context })
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) {
    throw new Error("the running Slack adapter has no /outbox route (it predates the send buffer); restart it before sending");
  }
  if (!res.ok || body.ok === false) throw new Error(`slack outbox: ${body.error ?? res.status}`);
  return {
    sent: false,
    queued: true,
    id: body.id,
    executeAt: body.executeAt,
    message: `NOT SENT YET. This Slack message to ${channel} is parked and goes out at ${body.executeAt} (${body.delaySeconds}s cancel window) unless it is cancelled before then.`,
    cancelHint: body.cancelHint
  };
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
    case "send_message": {
      // A message to another person is the irreversible category, so an
      // agent-triggered one is parked for a cancel window (../lib/outbox.js)
      // rather than posted now. Only a human acting in a UI posts immediately,
      // and only because that UI's process marked the env — never because a
      // caller typed a flag.
      const context = resolveSendContext(env);
      if (context !== "human") {
        return queueSend({ env, fetchImpl, channel: args.channel, text: args.text, context });
      }
      return slack("chat.postMessage", { channel: args.channel, text: args.text });
    }
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

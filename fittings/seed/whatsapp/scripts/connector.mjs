#!/usr/bin/env node
// WhatsApp connector — the uniform Garrison connector executor contract every
// connector Fitting implements, so the Automations engine can call any catalog
// action the same way:
//
//   node connector.mjs --probe                    -> "connectorOk" (verify; no secrets)
//   node connector.mjs catalog                    -> JSON { service, auth, actions[] }
//   node connector.mjs call <action> [argsJson]   -> JSON { ok, result }
//                                                    | { ok:false, error, awaiting_connector }
//
// Secrets are delivered SCOPED via env (the Vault materializes only this
// connector's secret_scope): WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
// WHATSAPP_BUSINESS_ACCOUNT_ID. They reach this call's env one of two ways —
// injected by the Automations engine, or self-resolved here (a direct call,
// e.g. the Operative over bash) from Garrison's
// /api/connectors/whatsapp/auth-env route. The values never appear in the
// manifest and are redacted from logs.

import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GRAPH_API_VERSION = "v25.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export const CATALOG = {
  service: "whatsapp",
  auth: "api_key",
  actions: [
    {
      name: "send_text",
      args: ["to", "body"],
      mutates: true,
      description: "Send a free-form text message (only within a customer's 24h service window)"
    },
    {
      name: "send_template",
      args: ["to", "template", "language", "components"],
      mutates: true,
      description: "Send a pre-approved template message (works outside the 24h window; components is optional)"
    },
    {
      name: "list_templates",
      args: [],
      mutates: false,
      description: "List the business account's message templates and their approval status"
    }
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
    const res = await fetchImpl(`${base}/api/connectors/whatsapp/auth-env`, {
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
  let token = env.WHATSAPP_ACCESS_TOKEN;
  let phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  let businessAccountId = env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!token || !phoneNumberId) {
    const injected = await fetchInjectedEnv(fetchImpl);
    token = token || injected.WHATSAPP_ACCESS_TOKEN;
    phoneNumberId = phoneNumberId || injected.WHATSAPP_PHONE_NUMBER_ID;
    businessAccountId = businessAccountId || injected.WHATSAPP_BUSINESS_ACCOUNT_ID;
  }
  if (!token || !phoneNumberId) {
    throw new NotConnectedError(
      "WhatsApp not connected (seal WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID in the Vault)"
    );
  }
  return { token, phoneNumberId, businessAccountId };
}

export async function runAction({ action, args = {}, env = process.env, fetchImpl = fetch }) {
  const { token, phoneNumberId, businessAccountId } = await resolveCreds(env, fetchImpl);
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const call = async (url, opts) => {
    const res = await fetchImpl(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`whatsapp ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  };
  // Encode every id placed in a URL path so an action arg cannot rewrite the
  // requested path.
  const seg = (v) => encodeURIComponent(String(v ?? ""));
  switch (action) {
    case "send_text":
      return call(`${GRAPH_API_BASE}/${seg(phoneNumberId)}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: args.to,
          type: "text",
          text: { body: args.body }
        })
      });
    case "send_template":
      return call(`${GRAPH_API_BASE}/${seg(phoneNumberId)}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: args.to,
          type: "template",
          template: {
            name: args.template,
            language: { code: args.language ?? "en_US" },
            ...(args.components ? { components: args.components } : {})
          }
        })
      });
    case "list_templates":
      if (!businessAccountId) {
        throw new Error("WHATSAPP_BUSINESS_ACCOUNT_ID not configured for this connector");
      }
      return call(
        `${GRAPH_API_BASE}/${seg(businessAccountId)}/message_templates?fields=${encodeURIComponent(
          "name,status,category,language"
        )}`,
        { headers }
      );
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

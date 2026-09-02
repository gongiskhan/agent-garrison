// Connector invocation — the vault-token dance, extracted so it has exactly one
// implementation.
//
// This module was carved out of engine.mjs unchanged. It exists as a LEAF (node
// builtins only, no store/browser/fixer chain) so a second consumer can reuse it
// without importing the whole automations run engine. The kanban-loop fitting's
// Google Calendar sync is that consumer: it needs a scoped Google access token
// and a connector.mjs child, and reimplementing either inside kanban-loop would
// mean a second place that knows how to ask the Vault for a credential.
//
// The sibling-relative path from another fitting resolves identically in both
// layouts — `fittings/seed/<id>/lib/` in the repo and `apm_modules/_local/<id>/lib/`
// once installed — because both put fittings side by side.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

export function internalToken() {
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const file = process.env.GARRISON_INTERNAL_TOKEN_PATH || path.join(home, "internal-token");
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

// The Garrison app's base URL. NO literal port fallback (HARD RULE: never
// hardcode a port — the old `http://127.0.0.1:27777` literal mapped to NO
// instance after the 2026-08-24 port re-axis, so every call from an env
// without GARRISON_BASE_URL was silently eaten as ECONNREFUSED). The scheduler
// daemon's env carries GARRISON_APP_PORT, so a tick-spawned child resolves
// through that; an unresolvable port throws loudly instead of guessing.
export function resolveGarrisonBaseUrl(env = process.env) {
  const explicit = (env.GARRISON_BASE_URL || "").trim();
  if (explicit) return explicit;
  const port = (env.GARRISON_APP_PORT || "").trim();
  if (/^[0-9]+$/.test(port)) return `http://127.0.0.1:${port}`;
  return null;
}

// Legacy connector ids, resolved ONCE at the top of the invoke path - before the
// auth-env fetch and before the script lookup - so no manifest has to declare
// the old name. `deepgram` was the retired deepgram-voice connector; its actions
// (transcribe, synthesize) now live on the voice layer's `voice` connector.
export const CONNECTOR_ID_ALIASES = Object.freeze({ deepgram: "voice" });

export function canonicalConnectorId(connectorId) {
  return CONNECTOR_ID_ALIASES[connectorId] ?? connectorId;
}

// Resolve a connector's scoped auth env from the Garrison backend (which owns the
// Vault). api_key connectors get their scoped secrets; oauth2 connectors get a
// freshly-refreshed <SERVICE>_ACCESS_TOKEN. The token never returns to a log.
export async function defaultConnectorAuthEnv(rawConnectorId, fetchImpl = fetch) {
  // Alias first: auth-env resolves the connector by the name a fitting PROVIDES,
  // and no fitting provides a legacy alias.
  const connectorId = canonicalConnectorId(rawConnectorId);
  const base = resolveGarrisonBaseUrl();
  if (!base) {
    throw new Error(
      `connector auth-env ${connectorId}: neither GARRISON_BASE_URL nor GARRISON_APP_PORT is set — refusing to guess an instance`
    );
  }
  const res = await fetchImpl(`${base}/api/connectors/${encodeURIComponent(connectorId)}/auth-env`, {
    method: "POST",
    headers: { "x-garrison-internal": internalToken() }
  });
  if (!res.ok) {
    if (res.status === 409) return { __awaiting_connector: true };
    throw new Error(`connector auth-env ${connectorId}: ${res.status}`);
  }
  const json = await res.json();
  return json.env ?? {};
}

// Spawn the connector Fitting's uniform connector.mjs with the scoped auth env.
//
// GARRISON_AUTOMATION_ENGINE marks every connector.mjs child spawned from
// here — i.e. every call that did NOT originate from a direct, attended
// invocation (the Operative's own bash/tool path). It exists so a connector
// whose action catalog includes something that must only ever happen with a
// live human in the loop (e.g. whatsapp-web's send_text — see its
// connector.mjs) can refuse that action outright when it sees this flag,
// rather than relying on the automation's author having left it out of a
// hand-authored automation. Unset by default; harmless to every connector
// that doesn't check it.
export function defaultRunConnector({ scriptPath, action, args, authEnv }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, "call", action, JSON.stringify(args ?? {})], {
      env: { ...process.env, ...authEnv, GARRISON_AUTOMATION_ENGINE: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve({ ok: false, error: err.trim() || out.trim() || "connector produced no JSON" });
      }
    });
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}

// Default connector.mjs path for a connector id (mirrors the installed layout).
export function connectorScriptPath(rawConnectorId) {
  const connectorId = canonicalConnectorId(rawConnectorId);
  const base = process.env.GARRISON_COMPOSITION_DIR || process.cwd();
  // installed connectors live at apm_modules/_local/<id>/scripts/connector.mjs;
  // the connector id and the fitting directory differ where one fitting hosts
  // the connector under another name (capture-service provides `voice`).
  const id = connectorId === "google" ? "google" : connectorId === "slack" ? "slack-channel" : connectorId === "voice" ? "capture-service" : connectorId;
  return `${base}/apm_modules/_local/${id}/scripts/connector.mjs`;
}

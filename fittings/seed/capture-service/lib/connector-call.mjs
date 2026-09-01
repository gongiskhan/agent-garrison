// Calling another Fitting's connector from the wake path.
//
// Deliberately NOT automations/lib/connector-invoke.mjs, and this is the whole
// reason the file exists: defaultRunConnector sets GARRISON_AUTOMATION_ENGINE=1,
// and whatsapp-web's connector REFUSES send_text outright when that flag is
// present ("only a direct call in a live conversation with the user may send a
// WhatsApp message"). Reusing that invoker would make every spoken send fail
// closed, and the failure would look like a connector bug rather than a policy
// one.
//
// A spoken send IS a live conversation with the user - they are standing there
// wearing the microphone - so this lane declares GARRISON_SEND_CONTEXT=agent
// instead. That resolves to the connector's "agent" context, which parks the
// send in its 60-second outbox rather than sending immediately. Parked is
// exactly what we want: the ConfirmBus announces it out loud and the user can
// say "cancela".

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const DEFAULT_TIMEOUT_MS = 20_000;

// Same layout the automations invoker resolves against; the composition dir is
// where APM installs every local fitting.
export function connectorScriptPath(connectorId, env = process.env) {
  const dir = env.GARRISON_COMPOSITION_DIR?.trim();
  if (!dir) return null;
  return path.join(dir, "apm_modules", "_local", connectorId, "scripts", "connector.mjs");
}

export function garrisonBaseUrl(env = process.env) {
  const base = env.GARRISON_BASE_URL?.trim();
  return base ? base.replace(/\/$/, "") : null;
}

// The connector's own auth env, minted by the shell. A 409 means the connector
// is not connected yet, which is a state to report, not an error to throw.
export async function connectorAuthEnv(connectorId, { env = process.env, fetchImpl = fetch } = {}) {
  const base = garrisonBaseUrl(env);
  const home = env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
  if (!base) return {};
  try {
    const { readFileSync } = await import("node:fs");
    const token = readFileSync(path.join(home, "internal-token"), "utf8").trim();
    const res = await fetchImpl(`${base}/api/connectors/${encodeURIComponent(connectorId)}/auth-env`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-internal": token },
      signal: AbortSignal.timeout(5000)
    });
    if (res.status === 409) return { __awaiting_connector: true };
    if (!res.ok) return {};
    const data = await res.json().catch(() => ({}));
    return data?.env ?? data ?? {};
  } catch {
    return {};
  }
}

export function makeConnectorFn({ env = process.env, spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return async function callConnector(connectorId, action, args = {}) {
    const script = connectorScriptPath(connectorId, env);
    if (!script) throw new Error("no composition dir - cannot resolve connector");
    const authEnv = await connectorAuthEnv(connectorId, { env });
    if (authEnv.__awaiting_connector) throw new Error(`${connectorId} is not connected`);
    return await new Promise((resolve, reject) => {
      const child = spawnImpl("node", [script, "call", action, JSON.stringify(args)], {
        env: {
          ...env,
          ...authEnv,
          // NOT GARRISON_AUTOMATION_ENGINE. See the header.
          GARRISON_SEND_CONTEXT: "agent"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${connectorId} ${action} timed out`));
      }, timeoutMs);
      timer.unref?.();
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`${connectorId} ${action} exited ${code}: ${err.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(out.trim() || "{}");
          if (parsed.ok === false) reject(new Error(String(parsed.error ?? "connector refused")));
          else resolve(parsed);
        } catch (e) {
          reject(new Error(`${connectorId} ${action} returned unparseable output`));
        }
      });
    });
  };
}

// Config for the email-channel daemon. Composition config arrives NAMESPACED:
// GARRISON_<ID>_<KEY> with the fitting id stripped of non-alphanumerics (see
// ownPortConfigEnv in src/lib/own-port-lifecycle.ts) - email-channel + `port`
// -> GARRISON_EMAILCHANNEL_PORT. A loopback bind_host is deliberately never
// projected; the instance-wide GARRISON_BIND_HOST governs.

import os from "node:os";
import path from "node:path";

export const FITTING_ID = "email-channel";

// The committed default port. 8081: free in the 80xx family on every node
// (8080 is squatted by an unrelated java service on dev-madrid); serve port
// 8481 is collision-free. Must match x-garrison.default_port.
const DEFAULT_PORT = 8081;

function num(value, fallback) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function bool(value, fallback) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return fallback;
}

function str(value, fallback) {
  const s = String(value ?? "").trim();
  return s || fallback;
}

export function loadConfig(env = process.env) {
  const cfg = (key) => env[`GARRISON_EMAILCHANNEL_${key}`];
  const home = str(env.GARRISON_HOME, path.join(os.homedir(), ".garrison"));
  const pollSeconds = Math.min(Math.max(num(cfg("POLL_SECONDS"), 30), 15), 3600);
  return {
    fittingId: FITTING_ID,
    home,
    port: num(cfg("PORT"), DEFAULT_PORT),
    bindHost: str(cfg("BIND_HOST"), str(env.GARRISON_BIND_HOST, "127.0.0.1")),
    enabled: bool(cfg("ENABLED"), false),
    pollSeconds,
    allowedSenders: str(cfg("ALLOWED_SENDERS"), ""),
    targetList: str(cfg("TARGET_LIST"), "todo"),
    defaultProject: str(cfg("DEFAULT_PROJECT"), "") || null,
    stateDir: path.join(home, "email-channel"),
    statusFile: path.join(home, "ui-fittings", `${FITTING_ID}.json`)
  };
}

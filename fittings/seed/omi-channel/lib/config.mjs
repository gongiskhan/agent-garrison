// Omi channel Fitting — config resolution.
//
// Everything comes from the spawn env the runner projects
// (GARRISON_OMICHANNEL_<KEY> per composition config key, vault secrets under
// their exact names per secret_scope). No literal port fallback beyond the
// committed default_port; no gateway port literal at all — an unresolvable
// gateway means the dependent feature is skipped with a logged reason, never
// silently pointed at another instance's port.

import os from "node:os";
import path from "node:path";

export const FITTING_ID = "omi-channel";
export const CHANNEL_ID = "omi";
export const DEFAULT_PORT = 7094; // base-family (dev); prod arrives shifted via GARRISON_OMICHANNEL_PORT

// Mirrors garrisonDir() in src/lib/claude-home.ts: GARRISON_HOME (when set) IS
// the .garrison root, else ~/.garrison. Sandboxed tests set it so state and
// status files never collide with a live instance.
export function garrisonDir(env = process.env) {
  const override = env.GARRISON_HOME?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".garrison");
}

// Durable state root for this fitting (inbox events, counters, pinned uid,
// backfeed ledger). Convention: $GARRISON_HOME/<fitting>, dedicated override.
export function omiDir(env = process.env) {
  const override = env.GARRISON_OMI_DIR?.trim();
  return override && override.length > 0 ? override : path.join(garrisonDir(env), "omi");
}

export function statusFilePath(env = process.env) {
  return path.join(garrisonDir(env), "ui-fittings", `${FITTING_ID}.json`);
}

function parseBool(raw, fallback = false) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

function parseIntOr(raw, fallback) {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCsv(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Gateway URL resolution — GARRISON_GATEWAY_URL, else HOST/PORT pair when the
// port is explicitly numeric. NEVER a baked port literal (every baked port
// literal in this repo has crossed instances). null = gateway-dependent
// features skip with a reason.
export function resolveGatewayUrl(env = process.env) {
  const direct = (env.GARRISON_GATEWAY_URL || "").trim();
  if (direct) return direct.replace(/\/$/, "");
  const p = (env.GARRISON_GATEWAY_PORT || "").trim();
  if (/^\d+$/.test(p)) {
    const h = (env.GARRISON_GATEWAY_HOST || "127.0.0.1").trim();
    return `http://${h}:${p}`;
  }
  return null;
}

export function loadConfig(env = process.env) {
  return {
    port: parseIntOr(env.GARRISON_OMICHANNEL_PORT, DEFAULT_PORT),
    bindHost:
      (env.GARRISON_OMICHANNEL_BIND_HOST || "").trim() ||
      (env.GARRISON_BIND_HOST || "").trim() ||
      "127.0.0.1",
    gatewayUrl: resolveGatewayUrl(env),

    // Resolved instance paths, carried ON the config. Every consumer derives
    // state from the config it was handed; nothing re-reads process.env behind
    // the caller's back. A caller holding a sandboxed cfg must never resolve to
    // the real ~/.garrison — server.mjs doing so let a test delete a LIVE
    // instance's status file (2026-07-30), which in turn breaks `down` (it kills
    // by pid from that file) and funnel-ensure (it reads the live port from it).
    home: garrisonDir(env),
    stateDir: omiDir(env),
    statusFile: statusFilePath(env),

    // Independent kill switches (invariant I9) — every pipe defaults OFF.
    enabled: parseBool(env.GARRISON_OMICHANNEL_ENABLED, false), // master: webhook ingress
    triageEnabled: parseBool(env.GARRISON_OMICHANNEL_TRIAGE_ENABLED, false),
    wakeEnabled: parseBool(env.GARRISON_OMICHANNEL_WAKE_ENABLED, false),
    notifyEnabled: parseBool(env.GARRISON_OMICHANNEL_NOTIFY_ENABLED, false),
    chatEnabled: parseBool(env.GARRISON_OMICHANNEL_CHAT_ENABLED, false),
    backfeedEnabled: parseBool(env.GARRISON_OMICHANNEL_BACKFEED_ENABLED, false),
    tipsEnabled: parseBool(env.GARRISON_OMICHANNEL_TIPS_ENABLED, false),

    // Public HTTPS base the human hands to Omi (the Funnel address, e.g.
    // https://<host>:8443). Used to build absolute URLs in the chat-tools
    // manifest; empty = manifest served with relative endpoints.
    publicBaseUrl: (env.GARRISON_OMICHANNEL_PUBLIC_BASE_URL || "").trim().replace(/\/$/, ""),

    // Triage (M2)
    triageCron: (env.GARRISON_OMICHANNEL_TRIAGE_CRON || "").trim() || "*/5 * * * *",
    triageBatchCap: parseIntOr(env.GARRISON_OMICHANNEL_TRIAGE_BATCH_CAP, 20),

    // Scope filters (rule layer — zero model cost)
    allowedCategories: parseCsv(env.GARRISON_OMICHANNEL_ALLOWED_CATEGORIES), // empty = all
    blockedFolders: parseCsv(env.GARRISON_OMICHANNEL_BLOCKED_FOLDERS),
    dropDiscarded: parseBool(env.GARRISON_OMICHANNEL_DROP_DISCARDED, true),

    // Wake bus (M4)
    wakeVariants: (() => {
      const v = parseCsv(env.GARRISON_OMICHANNEL_WAKE_VARIANTS);
      return v.length > 0 ? v : ["gary", "garry", "gerry", "géri"];
    })(),
    wakeSilenceCloseMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_SILENCE_CLOSE_MS, 4000),
    wakeMaxCaptureMs: parseIntOr(env.GARRISON_OMICHANNEL_WAKE_MAX_CAPTURE_MS, 20000),

    // Outbound caps (M3)
    notifyMaxPerDay: parseIntOr(env.GARRISON_OMICHANNEL_NOTIFY_MAX_PER_DAY, 50),
    tipsMaxPerDay: parseIntOr(env.GARRISON_OMICHANNEL_TIPS_MAX_PER_DAY, 3),

    // Backfeed (M6)
    backfeedKinds: (() => {
      const v = parseCsv(env.GARRISON_OMICHANNEL_BACKFEED_KINDS);
      return v.length > 0 ? v : ["completed_cards", "decisions"];
    })(),

    // Vault-scoped secrets (exact vault key names, delivered at spawn).
    secrets: {
      appId: (env.OMI_APP_ID || "").trim(),
      appSecret: (env.OMI_APP_SECRET || "").trim(),
      importApiKey: (env.OMI_IMPORT_API_KEY || "").trim(),
      webhookSecret: (env.OMI_WEBHOOK_SECRET || "").trim()
    }
  };
}

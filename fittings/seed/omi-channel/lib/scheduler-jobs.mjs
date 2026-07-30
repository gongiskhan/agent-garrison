// omi-triage scheduler job registration - kanban-loop's registerTick pattern:
// the scheduler daemon runs jobs via `sh -c` with ITS OWN env (no instance
// identity), so the job command must carry the resolved gateway URL, home, and
// every triage-relevant projected config value itself. NO literal port
// fallback anywhere (the dev-port-literal-in-a-prod-job failure mode killed
// the kanban tick for weeks).
//
// Composition config is the source of truth for the flag: server boot with
// triage_enabled=true registers (idempotent `register`, preserving the user's
// enable/disable choice); boot with it false removes the job (a baked-env job
// left behind would keep running with stale flag values).

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const TRIAGE_JOB_ID = "omi-triage";

export function schedulerCli(env = process.env) {
  const explicit = (env.GARRISON_SCHEDULER_CLI || "").trim();
  if (explicit) return explicit;
  // Sibling fitting in the same install tree (apm_modules/_local/<id>/ or
  // fittings/seed/<id>/ in the checkout).
  return path.resolve(here, "..", "..", "scheduler", "scripts", "scheduler.mjs");
}

// Env baked into the job command. Single-quoted for `sh -c`; values containing
// a quote are dropped rather than escaped (ports, URLs, paths, csv - never
// quoted strings).
export function triageEnvPrefix(cfg, env = process.env) {
  const vars = {
    GARRISON_GATEWAY_URL: cfg.gatewayUrl,
    GARRISON_HOME: env.GARRISON_HOME,
    GARRISON_OMI_DIR: env.GARRISON_OMI_DIR,
    GARRISON_OMICHANNEL_TRIAGE_ENABLED: "true",
    GARRISON_OMICHANNEL_TRIAGE_BATCH_CAP: String(cfg.triageBatchCap),
    GARRISON_OMICHANNEL_ALLOWED_CATEGORIES: cfg.allowedCategories.join(","),
    GARRISON_OMICHANNEL_BLOCKED_FOLDERS: cfg.blockedFolders.join(","),
    GARRISON_OMICHANNEL_DROP_DISCARDED: String(cfg.dropDiscarded),
    GARRISON_OMICHANNEL_TIPS_ENABLED: String(cfg.tipsEnabled),
    GARRISON_OMICHANNEL_TIPS_MAX_PER_DAY: String(cfg.tipsMaxPerDay),
    BASIC_MEMORY_VAULT_DIR: env.BASIC_MEMORY_VAULT_DIR,
    BASIC_MEMORY_MEMORY_DIR: env.BASIC_MEMORY_MEMORY_DIR
  };
  return Object.entries(vars)
    .filter(([, v]) => typeof v === "string" && v.trim() !== "" && !v.includes("'"))
    .map(([k, v]) => `${k}='${v.trim()}'`);
}

export function registerTriageJob(cfg, { env = process.env, log = console } = {}) {
  const cli = schedulerCli(env);
  if (!existsSync(cli)) {
    log.log(`[omi-channel] scheduler CLI not found at ${cli} (skipping ${TRIAGE_JOB_ID} registration)`);
    return false;
  }
  if (!cfg.gatewayUrl) {
    // Never register a gateway-less triage job; the server re-registers on the
    // next boot once the runner projects GARRISON_GATEWAY_URL.
    log.log(`[omi-channel] no gateway URL in scope; NOT registering ${TRIAGE_JOB_ID}`);
    return false;
  }
  const self = path.resolve(here, "..", "scripts", "triage.mjs");
  const prefix = triageEnvPrefix(cfg, env);
  const reg = spawnSync(
    "node",
    [cli, "register", TRIAGE_JOB_ID, cfg.triageCron, "--description", "Omi inbox triage (batched, one model call per non-empty tick)", "--", ...prefix, "node", self, "--tick"],
    { encoding: "utf8" }
  );
  if (reg.status === 0) {
    log.log(`[omi-channel] registered ${TRIAGE_JOB_ID} @ '${cfg.triageCron}'`);
    return true;
  }
  log.log(`[omi-channel] scheduler register failed (non-fatal): ${reg.stderr || reg.stdout || reg.status}`);
  return false;
}

export function removeTriageJob({ env = process.env, log = console } = {}) {
  const cli = schedulerCli(env);
  if (!existsSync(cli)) return false;
  const rm = spawnSync("node", [cli, "remove", TRIAGE_JOB_ID], { encoding: "utf8" });
  if (rm.status === 0) log.log(`[omi-channel] removed ${TRIAGE_JOB_ID} (triage disabled)`);
  return rm.status === 0;
}

export function syncTriageJob(cfg, opts = {}) {
  if (cfg.triageEnabled) return registerTriageJob(cfg, opts);
  return removeTriageJob(opts);
}

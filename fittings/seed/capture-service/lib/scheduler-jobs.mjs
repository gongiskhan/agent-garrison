// One job per node: capture artifacts live on their owner, while the scheduler
// registry is shared. No credentials are stored in the registered command.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const TRIAGE_JOB_ID = "capture-triage";
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function schedulerCli(env = process.env) {
  return env.GARRISON_SCHEDULER_CLI?.trim()
    || path.resolve(here, "..", "..", "scheduler", "scripts", "scheduler.mjs");
}
export function triageJobId(cfg, env = process.env) {
  let node = env.GARRISON_NODE_NAME?.trim();
  if (!node) {
    try { const identity = JSON.parse(readFileSync(path.join(cfg.home, "node.json"), "utf8")); node = identity.id || identity.name; } catch {}
  }
  if (node && !/^[a-z][a-z0-9-]{1,31}$/.test(node)) throw new Error("Invalid capture triage node identity");
  return node ? `${TRIAGE_JOB_ID}-${node}` : TRIAGE_JOB_ID;
}
export function triageEnvPrefix(cfg, env = process.env) {
  const vars = {
    GARRISON_HOME: cfg.home,
    GARRISON_CAPTURE_DIR: cfg.stateDir,
    GARRISON_GATEWAY_URL: cfg.gatewayUrl,
    GARRISON_APP_URL: env.GARRISON_APP_URL,
    GARRISON_CAPTURESERVICE_CLASSIFY_TARGET: cfg.classifyTarget,
    GARRISON_CAPTURESERVICE_TRIAGE_CLASSIFY_TARGET: cfg.triageClassifyTarget,
    GARRISON_CAPTURESERVICE_TRIAGE_ENABLED: "true",
    GARRISON_CAPTURESERVICE_TRIAGE_BATCH_CAP: String(cfg.triageBatchCap),
    GARRISON_CAPTURESERVICE_ALLOWED_CATEGORIES: cfg.allowedCategories.join(","),
    GARRISON_CAPTURESERVICE_BLOCKED_FOLDERS: cfg.blockedFolders.join(","),
    GARRISON_CAPTURESERVICE_DROP_DISCARDED: String(cfg.dropDiscarded),
    GARRISON_CAPTURESERVICE_TIPS_ENABLED: String(cfg.tipsEnabled),
    GARRISON_CAPTURESERVICE_TIPS_MAX_PER_DAY: String(cfg.tipsMaxPerDay),
    BASIC_MEMORY_VAULT_DIR: env.BASIC_MEMORY_VAULT_DIR,
    BASIC_MEMORY_MEMORY_DIR: env.BASIC_MEMORY_MEMORY_DIR
  };
  return Object.entries(vars).filter(([,v]) => typeof v === "string")
    .map(([key,value]) => `${key}=${quote(value)}`);
}
export function syncTriageJob(cfg, { env = process.env, log = console, run = spawnSync } = {}) {
  const cli = schedulerCli(env);
  if (!existsSync(cli)) return false;
  const id = triageJobId(cfg, env);
  const args = cfg.triageEnabled
    ? [cli, "register", id, cfg.triageCron, "--description", "Phone and pendant capture triage", "--",
      ...triageEnvPrefix(cfg, env), quote(process.execPath), quote(path.resolve(here, "..", "scripts", "triage.mjs")), "--tick"]
    : [cli, "remove", id];
  if (cfg.triageEnabled && !cfg.gatewayUrl) {
    log.error("[capture-service] capture triage requires a gateway URL");
    return false;
  }
  const result = run(process.execPath, args, { encoding: "utf8", timeout: 15000, env: { ...env, GARRISON_HOME: cfg.home } });
  if (result.status !== 0) {
    log.error(`[capture-service] ${id} scheduler sync failed: ${result.error?.message || result.stderr || result.status}`);
    return false;
  }
  log.log(`[capture-service] ${id} ${cfg.triageEnabled ? "registered" : "removed"}`);
  return true;
}

import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const deploymentHome = (env = process.env) => env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
export const deploymentGuardPath = (env = process.env) => path.join(deploymentHome(env), "deployment-guard.json");
export function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
export function deploymentDraining(env = process.env) {
  try {
    const guard = JSON.parse(readFileSync(deploymentGuardPath(env), "utf8"));
    return guard.expiresAt > Date.now() && processExists(guard.pid);
  } catch (error) {
    // A partially written or unreadable guard must not admit work during a stop.
    return error.code !== "ENOENT";
  }
}

/** Read only activity metadata. Dead stretch markers do not block recovery. */
export function localConversationActivity(env = process.env) {
  const home = deploymentHome(env);
  const active = new Set();
  const entries = (dir) => {
    try { return readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  for (const entry of entries(path.join(home, "conversations"))) {
    if (!entry.isDirectory()) continue;
    try {
      const [id, rawPid] = readFileSync(path.join(home, "conversations", entry.name, ".current-stretch"), "utf8").split("\n");
      if (id?.trim() && (!rawPid?.trim() || processExists(Number(rawPid)))) active.add(entry.name);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const entry of entries(path.join(home, "web-channel", "threads"))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const thread = JSON.parse(readFileSync(path.join(home, "web-channel", "threads", entry.name), "utf8"));
    if (thread.pendingInputs?.some((input) => ["queued", "starting", "running", "stopping"].includes(input.state))) active.add(entry.name.slice(0, -5));
  }
  return [...active];
}

export const DEPLOYMENT_ADMISSION_PATHS = new Set([
  "/chat", "/chat/stream", "/conversation/open", "/conversation/advance",
  "/conversation/message", "/conversation/kick", "/conversation/card-inference",
  "/jobs", "/claude/message", "/escalate",
]);

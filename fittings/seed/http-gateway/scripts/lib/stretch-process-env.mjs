import { execFileSync } from "node:child_process";

let hostPids;
function ancestors() {
  if (hostPids) return hostPids;
  const ids = [];
  let pid = process.pid;
  for (let i = 0; i < 16 && pid > 1; i++) {
    ids.push(pid);
    try { pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim()); }
    catch { break; }
  }
  return hostPids = ids.join(",");
}
export function stretchProcessEnv(base, { conversationId, stretchId } = {}) {
  if (!conversationId || !stretchId) return base;
  const env = { ...base, GARRISON_CONVERSATION_ID: conversationId, GARRISON_STRETCH_ID: stretchId, GARRISON_HOST_PIDS: ancestors() };
  // A normal project build must not overwrite the live Next artifact merely
  // because its gateway inherited the node launcher's dist projection.
  delete env.NEXT_DIST_DIR;
  return env;
}

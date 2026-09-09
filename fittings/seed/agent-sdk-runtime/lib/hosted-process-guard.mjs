// Protect the service hosting this session. Project commands keep their
// existing permissions; node deployment has an independently supervised path.
export function hostedCommandRejection(tool, input, env = {}) {
  if (tool !== "Bash" || !env.GARRISON_STRETCH_ID) return null;
  const command = typeof input?.command === "string" ? input.command : "";
  const boundary = "(?:^\\s*|[;&|\\n]\\s*|\\b(?:sudo|command)\\s+)";
  const broadKill = new RegExp(`${boundary}(?:pkill|killall)\\b[^\\n;&|]*(?:garrison|node|next|npm)`, "i");
  const serviceStop = new RegExp(`${boundary}(?:systemctl|launchctl)\\b[^\\n;&|]*(?:restart|stop|kill|kickstart|bootout)[^\\n;&|]*(?:garrison|io\\.garrison)`, "i");
  const protectedPids = new Set(String(env.GARRISON_HOST_PIDS ?? "").split(",").filter(Boolean));
  const kill = new RegExp(`${boundary}kill\\b([^\\n;&|]*)`, "g");
  const killsHost = [...command.matchAll(kill)].some((m) => (m[1].match(/\b\d+\b/g) ?? []).some((id) => protectedPids.has(id)));
  if (!broadKill.test(command) && !serviceStop.test(command) && !killsHost) return null;
  return "This command would stop the service running your conversation and lose the handoff. Use npm run node:reload or npm run node:redeploy in the Garrison checkout. That command queues an independently supervised job. Write your handoff immediately after it returns; the conversation resumes after deployment. Do not replace this with another kill or manual restart.";
}

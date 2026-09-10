// Protect the service hosting this session. Project commands keep their
// existing permissions; node deployment must preserve the working Conversation.
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
  return "This command would stop the node running your Conversation. Deploy another mesh node with npm run node:reload or npm run node:redeploy and verify it there. Defer this node until the Conversation finishes; do not bypass the guard with a direct restart."
}

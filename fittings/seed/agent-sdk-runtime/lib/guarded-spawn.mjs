// guarded-spawn.mjs — the Claude Code child process, spawned so that its death
// can never take the host process down with it.
//
// The SDK's own spawnLocalProcess pipes stdin and attaches NO 'error' listener
// to it. Any write that races the child's exit — the SDK's close() after an MCP
// readiness timeout (./mcp-readiness.mjs) is the proven one — then surfaces as
// `Error: write EPIPE` / "Unhandled 'error' event" on the process, and there is
// no try/catch that can reach an async stream error. On 2026-09-11 that killed
// the whole http-gateway: one chat turn whose `garrison` MCP server was slow to
// start left the gateway dead for four days, and every scheduled job with it.
//
// The child's exit is already reported through its 'exit' listener (the SDK
// turns it into the query's error), so a stdin error carries nothing a caller
// needs. It is recorded, never thrown.
import { spawn } from "node:child_process";

/**
 * Drop-in for the SDK's `spawnClaudeCodeProcess` option. Mirrors the SDK's
 * default spawn (stdin/stdout piped, stderr piped only when someone reads it).
 *
 * @param {{command: string, args: string[], cwd?: string, env: Record<string,string>, signal?: AbortSignal}} spawnOptions
 * @param {{stderr?: (chunk: string) => void, onStdinError?: (error: Error) => void, spawnImpl?: typeof spawn}} [hooks]
 */
export function spawnGuardedClaudeProcess({ command, args, cwd, env, signal }, hooks = {}) {
  const { stderr, onStdinError = () => {}, spawnImpl = spawn } = hooks;
  const child = spawnImpl(command, args, {
    cwd,
    env,
    signal,
    stdio: ["pipe", "pipe", stderr ? "pipe" : "ignore"],
    windowsHide: true,
  });
  child.stdin.on("error", (error) => onStdinError(error));
  if (stderr) child.stderr.on("data", (chunk) => stderr(chunk.toString()));
  return child;
}

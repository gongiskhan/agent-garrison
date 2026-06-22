import { execFile } from "node:child_process";
import path from "node:path";
import { ROOT_DIR } from "./paths";

// Bridge from the web layer to the coordination CLI. The Coordination view reads
// state by running the EXACT same `coord state --json` the CLI renders — this is
// what guarantees the UI can never disagree with the CLI (one state source). All
// coord work is mechanical + PTY-safe (no model call).

const COORD_CLI = path.join(ROOT_DIR, "fittings", "seed", "coord-mcp", "scripts", "coord.mjs");

export interface CoordRun {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCoord(args: string[], timeoutMs = 8000): Promise<CoordRun> {
  return new Promise((resolve) => {
    execFile(process.execPath, [COORD_CLI, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}

// Fetch the unified coordination state (same object the CLI + digest consume).
// Throws on failure so the route can render an honest "unknown" verdict rather
// than stale green.
export async function coordState(repo?: string): Promise<unknown> {
  const args = ["state", "--json", ...(repo ? [`--repo=${repo}`] : [])];
  const { code, stdout, stderr } = await runCoord(args);
  if (code !== 0) throw new Error(stderr.trim() || `coord state exited ${code}`);
  return JSON.parse(stdout);
}

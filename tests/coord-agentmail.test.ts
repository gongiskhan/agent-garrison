import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// coord-agentmail gate. The always-on portion tests the MCP registration writer
// (register-mcp.mjs) against a sandbox ~/.claude.json: add/remove, preservation,
// and the never-clobber-on-corrupt discipline. A live server round-trip is gated
// behind GARRISON_LIVE_AGENTMAIL=1 (needs uv + the external clone) so the normal
// suite stays fast + deterministic — mirroring the U-wave live-test pattern.

const FITTING = path.resolve(__dirname, "..", "fittings", "seed", "coord-agentmail");
const REGISTER = path.join(FITTING, "scripts", "register-mcp.mjs");
const START = path.join(FITTING, "scripts", "start.mjs");
const SETUP = path.join(FITTING, "scripts", "setup.sh");

let sb: string;
let cjPath: string;

function runRegister(args: string[], extraEnv: Record<string, string> = {}): void {
  execFileSync(process.execPath, [REGISTER, ...args], {
    env: { ...process.env, GARRISON_CLAUDE_JSON: cjPath, ...extraEnv },
    stdio: "pipe"
  });
}
function readCj(): { mcpServers?: Record<string, unknown> } & Record<string, unknown> {
  return JSON.parse(readFileSync(cjPath, "utf8"));
}

beforeEach(() => {
  sb = mkdtempSync(path.join(tmpdir(), "coord-agentmail-"));
  cjPath = path.join(sb, ".claude.json");
});
afterEach(() => rmSync(sb, { recursive: true, force: true }));

describe("coord-agentmail register-mcp", () => {
  it("registers the http MCP server pointing at /mcp", () => {
    runRegister(["add", "28765"]);
    const cj = readCj();
    expect(cj.mcpServers?.["coord-agentmail"]).toEqual({ type: "http", url: "http://127.0.0.1:28765/mcp" });
  });

  it("honors a custom port", () => {
    runRegister(["add", "8799"]);
    expect((readCj().mcpServers?.["coord-agentmail"] as { url: string }).url).toBe("http://127.0.0.1:8799/mcp");
  });

  it("preserves existing mcpServers + unrelated keys", () => {
    writeFileSync(cjPath, JSON.stringify({ mcpServers: { other: { command: "x" } }, projects: { a: 1 } }));
    runRegister(["add", "28765"]);
    const cj = readCj();
    expect((cj.mcpServers as Record<string, unknown>).other).toEqual({ command: "x" });
    expect((cj.mcpServers as Record<string, unknown>)["coord-agentmail"]).toBeDefined();
    expect((cj as { projects?: Record<string, number> }).projects?.a).toBe(1);
  });

  it("remove deletes only its own entry", () => {
    writeFileSync(cjPath, JSON.stringify({ mcpServers: { other: { command: "x" }, "coord-agentmail": { type: "http", url: "u" } } }));
    runRegister(["remove"]);
    const cj = readCj();
    expect((cj.mcpServers as Record<string, unknown>)["coord-agentmail"]).toBeUndefined();
    expect((cj.mcpServers as Record<string, unknown>).other).toBeDefined();
  });

  it("never clobbers a corrupt ~/.claude.json — aborts, leaves bytes untouched", () => {
    const corrupt = "{ not json :: ";
    writeFileSync(cjPath, corrupt);
    expect(() => runRegister(["add", "28765"])).toThrow();
    expect(readFileSync(cjPath, "utf8")).toBe(corrupt);
  });
});

describe("coord-agentmail setup license-isolation guard", () => {
  it("aborts BEFORE any clone/write when GARRISON_HOME is inside the MIT tree", () => {
    // Point GARRISON_HOME inside the repo → EXT would be repo/<x>/external/... .
    const insideHome = path.join(__dirname, "..", "tmp-co2-guard-home");
    rmSync(insideHome, { recursive: true, force: true });
    expect(() => execFileSync("bash", [SETUP], { env: { ...process.env, GARRISON_HOME: insideHome }, stdio: "pipe" })).toThrow();
    // The guard ran before mkdir/clone — no external bytes were written.
    expect(existsSync(path.join(insideHome, "external"))).toBe(false);
    rmSync(insideHome, { recursive: true, force: true });
  });
});

// Live round-trip — gated. Proves the own-port supervisor brings agent_mail up,
// writes the status file, registers the MCP, and stops cleanly. Requires the
// external clone synced (setup.sh) + uv.
const LIVE = process.env.GARRISON_LIVE_AGENTMAIL === "1";
describe.runIf(LIVE)("coord-agentmail live supervisor", () => {
  it("starts the server, writes status + MCP, then stops cleanly", async () => {
    const port = "8788";
    const gh = mkdtempSync(path.join(tmpdir(), "co2-live-"));
    mkdirSync(path.join(gh, "external"), { recursive: true });
    symlinkSync(path.join(homedir(), ".garrison", "external", "mcp_agent_mail"), path.join(gh, "external", "mcp_agent_mail"));
    const cj = path.join(gh, ".claude.json");
    const { spawn } = await import("node:child_process");
    const sup = spawn(process.execPath, [START], {
      env: { ...process.env, GARRISON_HOME: gh, GARRISON_CLAUDE_JSON: cj, COORD_AGENTMAIL_PORT: port },
      stdio: "ignore"
    });
    const statusFile = path.join(gh, "ui-fittings", "coord-agentmail.json");
    try {
      // wait for status file (server up)
      for (let i = 0; i < 40 && !existsSync(statusFile); i++) await new Promise((r) => setTimeout(r, 1000));
      expect(existsSync(statusFile)).toBe(true);
      const status = JSON.parse(readFileSync(statusFile, "utf8"));
      expect(status.mcpUrl).toBe(`http://127.0.0.1:${port}/mcp`);
      expect(JSON.parse(readFileSync(cj, "utf8")).mcpServers["coord-agentmail"]).toBeDefined();
    } finally {
      sup.kill("SIGTERM");
      for (let i = 0; i < 10 && existsSync(statusFile); i++) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(existsSync(statusFile)).toBe(false); // clean stop removed the status file
    rmSync(gh, { recursive: true, force: true });
  }, 60000);
});

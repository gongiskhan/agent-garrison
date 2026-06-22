import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setEagerBoot, isEagerBoot } from "../src/lib/eager-boot";

// C2-3 (agent_mail standing/eager lifecycle) + C2-4 (durable backups).

const SEED = path.resolve(__dirname, "..", "fittings", "seed");
let gh: string;

beforeEach(() => {
  gh = mkdtempSync(path.join(tmpdir(), "coord-lifecycle-"));
  process.env.GARRISON_HOME = gh;
});
afterEach(() => {
  rmSync(gh, { recursive: true, force: true });
  delete process.env.GARRISON_HOME;
});

describe("C2-3 agent_mail standing/eager lifecycle", () => {
  it("eager-boot toggles for coord-agentmail (standing on select, off on deselect)", async () => {
    expect(await isEagerBoot("coord-agentmail")).toBe(false);
    await setEagerBoot("coord-agentmail", true); // what runner does when coord-agentmail is SELECTED
    expect(await isEagerBoot("coord-agentmail")).toBe(true);
    await setEagerBoot("coord-agentmail", false); // what runner does when DESELECTED
    expect(await isEagerBoot("coord-agentmail")).toBe(false);
  });
});

describe("C2-4 durable backups (~/.garrison/snapshots, not /tmp)", () => {
  function snapPath(owner: string) {
    return path.join(gh, "snapshots", `claude-json.before-${owner}.json`);
  }
  function registerMcp(fitting: string, args: string[], cjPath: string) {
    execFileSync(process.execPath, [path.join(SEED, fitting, "scripts", "register-mcp.mjs"), ...args], {
      env: { ...process.env, GARRISON_HOME: gh, GARRISON_CLAUDE_JSON: cjPath },
      stdio: "pipe"
    });
  }

  it("coord-mcp register-mcp snapshots ~/.claude.json durably before first write, idempotently", () => {
    const cj = path.join(gh, ".claude.json");
    writeFileSync(cj, JSON.stringify({ mcpServers: { existing: { command: "x" } } }));
    registerMcp("coord-mcp", ["add"], cj);
    expect(existsSync(snapPath("coord-mcp"))).toBe(true);
    const snap = JSON.parse(readFileSync(snapPath("coord-mcp"), "utf8"));
    // snapshot captured the PRE-coord state (no coord-mcp entry)
    expect(snap.mcpServers.existing).toBeDefined();
    expect(snap.mcpServers["coord-mcp"]).toBeUndefined();
    // idempotent: a second register does not overwrite the snapshot with post-coord state
    registerMcp("coord-mcp", ["add"], cj);
    const snap2 = JSON.parse(readFileSync(snapPath("coord-mcp"), "utf8"));
    expect(snap2.mcpServers["coord-mcp"]).toBeUndefined();
  });

  it("coord-agentmail register-mcp snapshots durably too", () => {
    const cj = path.join(gh, ".claude.json");
    writeFileSync(cj, JSON.stringify({ mcpServers: {} }));
    registerMcp("coord-agentmail", ["add", "8765"], cj);
    expect(existsSync(snapPath("coord-agentmail"))).toBe(true);
  });

  it("snapshots are NOT written under /tmp", () => {
    const cj = path.join(gh, ".claude.json");
    writeFileSync(cj, JSON.stringify({ mcpServers: {} }));
    registerMcp("coord-mcp", ["add"], cj);
    expect(snapPath("coord-mcp")).toContain(path.join(gh, "snapshots"));
    expect(snapPath("coord-mcp")).not.toContain(`${path.sep}tmp${path.sep}settings`);
  });
});

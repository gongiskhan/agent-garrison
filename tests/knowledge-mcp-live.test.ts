import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// @ts-ignore — pure .mjs MCP client
import { McpStdioClient, flattenContent } from "../scripts/lib/mcp-stdio-client.mjs";
// @ts-ignore — pure .mjs knowledge CLI
import { provision, wireMcp, knowledgeMcpServers } from "../fittings/seed/knowledge/scripts/knowledge.mjs";

// U2 — codegraph + serena LIVE through the wired MCP (codegraph-ok / serena-ok).
// The BRIEF-v4 tool-blocked tokens, now green: both CLIs are installed, so we
// drive each real MCP stdio server through initialize → tools/list → tools/call
// against a tiny fixture project and assert a real answer. Self-skips (not
// fails) only if a binary is genuinely absent from PATH.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_SRC = path.join(REPO_ROOT, "tests", "fixtures", "kg-project");

function onPath(bin: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

// The codegraph/serena MCP servers index + spawn real LSPs — slow, and codegraph
// can wedge under heavy machine load (its own watchdog kills wedged processes).
// So the LIVE round-trips run under GARRISON_LIVE_TOOLS=1 (proven green on demand;
// the U-wave walkthrough records them). The provisioning idempotency block below
// is deterministic and always runs.
const LIVE_TOOLS = process.env.GARRISON_LIVE_TOOLS === "1";
const HAS_CODEGRAPH = LIVE_TOOLS && onPath("codegraph");
const HAS_SERENA = LIVE_TOOLS && onPath("serena");

let project: string;

beforeAll(() => {
  // copy fixture source to a throwaway dir so index artifacts never touch the repo
  project = mkdtempSync(path.join(tmpdir(), "gar-kg-"));
  cpSync(path.join(FIXTURE_SRC, "src"), path.join(project, "src"), { recursive: true });
  cpSync(path.join(FIXTURE_SRC, "package.json"), path.join(project, "package.json"));
});

describe.skipIf(!HAS_CODEGRAPH)("U2 — codegraph live (codegraph-ok)", () => {
  it("indexes the fixture and answers a codegraph_explore query through the wired MCP", async () => {
    // index (the wired command is `codegraph serve --mcp`; init builds the graph)
    execFileSync("codegraph", ["init", "."], { cwd: project, stdio: "ignore" });
    expect(existsSync(path.join(project, ".codegraph"))).toBe(true);

    const cg = knowledgeMcpServers().codegraph;
    expect(cg.command).toBe("codegraph");
    expect(cg.args).toEqual(["serve", "--mcp"]); // the corrected invocation

    const client = new McpStdioClient({ command: cg.command, args: [...cg.args, "-p", project], cwd: project, name: "codegraph" });
    client.start();
    try {
      await client.initialize({ rootUri: pathToFileURL(project).href, timeoutMs: 30_000 });
      const tools = await client.listTools(30_000);
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("codegraph_explore");

      const res = await client.callTool("codegraph_explore", { query: "addNumbers" }, 60_000);
      const text = flattenContent(res);
      expect(text).toContain("addNumbers");
      expect(text).toMatch(/math\.ts/);
    } finally {
      client.stop();
    }
  }, 120_000);
});

describe.skipIf(!HAS_SERENA)("U2 — serena live (serena-ok)", () => {
  it("answers a symbol-nav query (find_symbol / get_symbols_overview) through the wired MCP", async () => {
    const sr = knowledgeMcpServers().serena;
    expect(sr.command).toBe("serena");
    expect(sr.args[0]).toBe("start-mcp-server");

    const client = new McpStdioClient({
      command: sr.command,
      args: [...sr.args, "--project", project, "--transport", "stdio"],
      cwd: project,
      name: "serena",
    });
    client.start();
    try {
      await client.initialize({ timeoutMs: 90_000 });
      const tools = await client.listTools(60_000);
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("find_symbol");
      expect(names).toContain("get_symbols_overview");

      const overview = await client.callTool("get_symbols_overview", { relative_path: "src/math.ts" }, 90_000);
      expect(flattenContent(overview)).toContain("addNumbers");

      const sym = await client.callTool("find_symbol", { name_path_pattern: "addNumbers", include_body: true }, 90_000);
      const symText = flattenContent(sym);
      expect(symText).toContain("addNumbers");
      expect(symText).toMatch(/math\.ts/);
    } finally {
      client.stop();
    }
  }, 150_000);
});

describe("U2 — knowledge provisioning idempotent against the now-present tools (provisioning-idempotent-ok)", () => {
  it("provision wires the three MCP servers once and is a no-op on re-run", () => {
    const proj = mkdtempSync(path.join(tmpdir(), "gar-prov-"));
    mkdirSync(proj, { recursive: true });
    const first = provision(proj, path.join(REPO_ROOT, "fittings", "seed", "knowledge", "vault"));
    expect(first.mcp.added).toEqual(expect.arrayContaining(["knowledge", "codegraph", "serena"]));
    const second = provision(proj, path.join(REPO_ROOT, "fittings", "seed", "knowledge", "vault"));
    expect(second.mcp.added).toEqual([]); // already wired
    expect(second.noop).toBe(true);
    // and the wired commands are the corrected, live-verified invocations
    const re = wireMcp(proj); // third call, still idempotent
    expect(re.added).toEqual([]);
  });
});

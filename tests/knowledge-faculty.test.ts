import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { projectAll, writeProjections, SENTINELS } from "../fittings/seed/knowledge/lib/projections.mjs";
// @ts-ignore
import { parseMemoryIndex, planHarvest, harvestIntoVault, harvestedName } from "../fittings/seed/knowledge/lib/harvest.mjs";
// @ts-ignore
import { provision, knowledgeMcpServers } from "../fittings/seed/knowledge/scripts/knowledge.mjs";
// @ts-ignore
import { recall, TOOLS } from "../fittings/seed/knowledge/scripts/mcp-server.mjs";

const SEED_VAULT = join(__dirname, "..", "fittings", "seed", "knowledge", "vault");

function seedVault() {
  const dir = mkdtempSync(join(tmpdir(), "gar-vault-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "conventions.md"), "- Local-first, verify or don't ship.", "utf8");
  writeFileSync(join(dir, "architecture.md"), "- Compose, don't own.", "utf8");
  return dir;
}

describe("Knowledge projections (MRk-knowledge — projection-ok)", () => {
  it("projects AGENTS.md (canonical) + CLAUDE.md + GEMINI.md (thin @AGENTS.md imports) with sentinels", () => {
    const p = projectAll(SEED_VAULT);
    expect(p["AGENTS.md"]).toContain(SENTINELS.agents);
    expect(p["AGENTS.md"]).toContain("Compose, don't own");
    expect(p["CLAUDE.md"]).toContain(SENTINELS.claude);
    expect(p["CLAUDE.md"]).toContain("@AGENTS.md");
    expect(p["GEMINI.md"]).toContain(SENTINELS.gemini);
    expect(p["GEMINI.md"]).toContain("@AGENTS.md");
  });

  it("projection is deterministic (same vault → identical bytes)", () => {
    expect(projectAll(SEED_VAULT)).toEqual(projectAll(SEED_VAULT));
  });
});

describe("Knowledge provisioning idempotency (MRk-knowledge — provisioning-idempotent-ok)", () => {
  it("first provision writes projections + wires MCP; second is a no-op", () => {
    const project = mkdtempSync(join(tmpdir(), "gar-proj-"));
    const vault = seedVault();
    const first = provision(project, vault);
    expect(first.projections.written).toEqual(expect.arrayContaining(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]));
    expect(first.mcp.added).toEqual(expect.arrayContaining(["knowledge", "codegraph", "serena"]));
    expect(first.verify["AGENTS.md"]).toBe(true);
    expect(first.noop).toBe(false);

    const second = provision(project, vault);
    expect(second.projections.written).toEqual([]); // nothing rewritten
    expect(second.mcp.added).toEqual([]); // MCP already wired
    expect(second.noop).toBe(true);

    // .mcp.json lists the three endpoints (knowledge-mcp-wired baseline)
    const mcp = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(expect.arrayContaining(["knowledge", "codegraph", "serena"]));
  });
});

describe("Knowledge harvest idempotency (MRk-knowledge — harvest-idempotent-ok)", () => {
  it("parses the MEMORY.md index", () => {
    const entries = parseMemoryIndex("# Memory\n- [PTY screen detection](garrison-pty.md) — why it reads the screen\n- [Pool](pool.md) — warm pool");
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toBe("PTY screen detection");
  });

  it("harvest twice on the same MEMORY.md leaves the vault unchanged the second time", () => {
    const vault = mkdtempSync(join(tmpdir(), "gar-harvest-"));
    const memory = join(vault, "MEMORY.md");
    writeFileSync(memory, "- [Alpha](alpha.md) — hook a\n- [Beta](beta.md) — hook b", "utf8");
    const first = harvestIntoVault(memory, vault);
    expect(first.added.sort()).toEqual([harvestedName("alpha"), harvestedName("beta")].sort());
    const second = harvestIntoVault(memory, vault);
    expect(second.added).toEqual([]); // idempotent
    expect(second.skipped).toBe(2);
  });

  it("planHarvest skips entries already in the vault", () => {
    const entries = parseMemoryIndex("- [Alpha](alpha.md) — a");
    expect(planHarvest(entries, [harvestedName("alpha")])).toEqual([]);
  });
});

describe("Knowledge MCP server (recall)", () => {
  it("exposes a recall tool that searches the vault", () => {
    expect(TOOLS.map((t: any) => t.name)).toContain("recall");
    const hits = recall("compose");
    expect(Array.isArray(hits)).toBe(true);
  });

  it("the wired MCP servers include knowledge + codegraph + serena", () => {
    expect(Object.keys(knowledgeMcpServers())).toEqual(["knowledge", "codegraph", "serena"]);
  });
});

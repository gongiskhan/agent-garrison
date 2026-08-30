// The boot prefix is what a stretch pays before it does any work. These tests
// pin the two cuts measured in bench/prefix-2026-08-29: a per-duty tool
// allow-list instead of the CLI's whole inventory, and a capability catalogue
// carried as an index instead of every provider's full guidance.
import { describe, it, expect } from "vitest";
// @ts-ignore - pure .mjs module (single-line: TS reports TS7016 on the CLOSING line of a multi-line import, which the ignore above would not cover)
import { applyDutyHarnessProfile, toolProfileForDuty, narrowToolProfileForDuty, NARROW_DUTY_TOOL_PROFILES, SHARED_MCP_TOOLS, TOOL_PROFILES } from "../fittings/seed/http-gateway/scripts/lib/harness-profiles.mjs";
import { renderCapabilitiesBlock } from "../src/lib/runner";
import type { LibraryEntry } from "../src/lib/types";

const agentSdkRoute = (extra: Record<string, unknown> = {}) => ({
  targetId: "cc-sonnet",
  target: { id: "cc-sonnet", runtime: "agent-sdk", model: "claude-sonnet-5", ...extra },
  duty: "implement",
  level: 1,
});

describe("duty harness profiles", () => {
  it("gives every profile Write and Read, because every duty ends by writing its handoff", () => {
    for (const [name, tools] of Object.entries(TOOL_PROFILES)) {
      if (name === "none") continue;
      expect(tools, name).toContain("Write");
      expect(tools, name).toContain("Read");
    }
  });

  it("replaces the preset inventory with the shared measured tool set", () => {
    const route = applyDutyHarnessProfile(agentSdkRoute(), "implement");
    expect(route.target.tools).toEqual(["Bash", "Read", "Write", "Edit", "Agent", "TaskOutput", "AskUserQuestion"]);
    expect(route.target.toolProfile).toBe("shared");
  });

  // The cache prefix hashes tools -> system -> messages. A tools block that
  // varies by duty forks the prefix, and no stretch can then read another
  // stretch's cached boot. Sharing is worth ~10x what narrowing is.
  it("gives EVERY duty a byte-identical tools block", () => {
    const duties = ["implement", "test", "review", "triage", "adversarial-review", "plan", "research", "unmapped"];
    const blocks = duties.map((d) => JSON.stringify(applyDutyHarnessProfile(agentSdkRoute(), d).target.tools));
    expect(new Set(blocks).size).toBe(1);
  });

  it("gives EVERY duty a byte-identical MCP tool set, for the same reason", () => {
    const duties = ["implement", "test", "review", "triage", "report", "unmapped"];
    const sets = duties.map((d) => JSON.stringify(applyDutyHarnessProfile(agentSdkRoute(), d).target.mcpTools));
    expect(new Set(sets).size).toBe(1);
    expect(JSON.parse(sets[0])).toEqual(SHARED_MCP_TOOLS);
  });

  it("keeps the narrow per-duty sets as a record, to return to when deferral lands", () => {
    expect(narrowToolProfileForDuty("review")).toBe("read");
    expect(narrowToolProfileForDuty("implement")).toBe("code");
    for (const [duty, profile] of Object.entries(NARROW_DUTY_TOOL_PROFILES)) {
      expect(TOOL_PROFILES[profile], `${duty} -> ${profile}`).toBeDefined();
    }
  });

  it("still honours an explicit profile override", () => {
    const route = applyDutyHarnessProfile(agentSdkRoute(), "review", { profile: "read" });
    expect(route.target.tools).toEqual(["Bash", "Read", "Write"]);
  });

  it("leaves a manifest-pinned inventory alone - an operator who pinned it meant it", () => {
    const route = applyDutyHarnessProfile(agentSdkRoute({ tools: ["Bash"] }), "implement");
    expect(route.target.tools).toEqual(["Bash"]);
    expect(route.target.toolProfile).toBeUndefined();
  });

  it("does not touch a non-agent-sdk target - the inventory is an SDK concept", () => {
    const route = { targetId: "sol", target: { runtime: "codex", model: "gpt-5.6-sol" }, duty: "x", level: 1 };
    expect(applyDutyHarnessProfile(route, "adversarial-review").target.tools).toBeUndefined();
  });

  it("does not narrow a lean target, which already carries no tools", () => {
    const route = applyDutyHarnessProfile(agentSdkRoute({ promptMode: "lean" }), "dispatch");
    expect(route.target.tools).toBeUndefined();
  });

  it("falls back to the shared profile for a duty nobody mapped", () => {
    expect(toolProfileForDuty("some-new-duty")).toBe("shared");
    expect(applyDutyHarnessProfile(agentSdkRoute(), "some-new-duty").target.tools).toContain("Edit");
  });

  it("keeps Write and Read in the shared profile - every duty writes its handoff", () => {
    expect(TOOL_PROFILES.shared).toContain("Write");
    expect(TOOL_PROFILES.shared).toContain("Read");
  });
});

const entry = (id: string, guidance?: string): LibraryEntry =>
  ({
    id,
    summary: `${id} summary`,
    faculty: "memory",
    metadata: {
      summary: `${id} summary`,
      provides: [{ kind: "memory-store", name: id }],
      consumes: [],
      ...(guidance ? { for_consumers: guidance } : {}),
    },
  }) as unknown as LibraryEntry;

describe("capability catalogue detail", () => {
  const entries = [entry("alpha", "ALPHA GUIDANCE BODY\nsecond line"), entry("beta")];

  it("inlines every provider's guidance in full mode", () => {
    const block = renderCapabilitiesBlock(entries, "full");
    expect(block).toContain("ALPHA GUIDANCE BODY");
    expect(block).toContain("memory-store:beta");
  });

  it("keeps the whole inventory but drops the bodies in index mode", () => {
    const block = renderCapabilitiesBlock(entries, "index");
    expect(block).toContain("memory-store:alpha");
    expect(block).toContain("memory-store:beta");
    expect(block).not.toContain("ALPHA GUIDANCE BODY");
    // A stretch has to be able to tell WHICH lines have something more to read.
    expect(block).toContain("[usage guidance available]");
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("defaults to full, so nothing changes for a composition that did not opt in", () => {
    expect(renderCapabilitiesBlock(entries)).toBe(renderCapabilitiesBlock(entries, "full"));
  });

  it("is substantially smaller in index mode - that is the entire point", () => {
    const big = entry("gamma", "x".repeat(20_000));
    const full = renderCapabilitiesBlock([big], "full");
    const index = renderCapabilitiesBlock([big], "index");
    expect(index.length).toBeLessThan(full.length / 50);
  });
});

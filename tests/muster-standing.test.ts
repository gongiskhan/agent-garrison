import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

import {
  assembleStandingModel,
  buildStandingPayload,
  createRuntime,
  setPrimaryRuntime,
  setStandingConfig,
  swapStandingFitting,
  testRuntimeConnection
} from "@/app/api/muster/model";
import { getCompositionDirectory } from "@/lib/compositions";
import type { GarrisonMetadata, LibraryEntry } from "@/lib/types";

// A fixture composition written into compositions/<id> so the fs-backed standing
// helpers have a real manifest + real library fittings to read/write. Selections
// are all real seed fittings: the swap/config/runtime paths validate against the
// live library, and the orphan case needs a real named capability edge
// (morning-briefing consumes channel:slack, provided only by slack-channel).
const FIXTURE_ID = `muster-standing-fixture-${process.pid}`;
const FIXTURE_DIR = getCompositionDirectory(FIXTURE_ID);

function fixtureManifest() {
  return {
    name: FIXTURE_ID,
    version: "0.1.0",
    target: "claude",
    dependencies: { apm: [] },
    "x-garrison": {
      composition: {
        schema: 4,
        id: FIXTURE_ID,
        name: "Muster Standing Fixture",
        global_config: {
          projects_root: "~/dev",
          vault: "default",
          platform: "claude-code",
          guardrails: { max_tasks_per_tick: 5, max_spend_per_day: 25, max_tool_calls_per_tick: 30 },
          permissions_mode: "auto",
          observability_config: { log_sink: "runner" }
        },
        selections: {
          gateway: [{ id: "http-gateway", config: { port: 4777 } }],
          runtimes: [
            { id: "claude-code-runtime", config: {} },
            { id: "agent-sdk-runtime", config: {} }
          ],
          observability: [{ id: "scheduler", config: {} }],
          // vault-git-sync (sessions) consumes automation-runner:scheduler (one),
          // provided ONLY by `scheduler` — so swapping scheduler out orphans it.
          sessions: [{ id: "vault-git-sync", config: {} }]
        },
        prompt_sources: { orchestrator: ".garrison/prompts/orchestrator.md", soul: ".garrison/prompts/soul.md" }
      }
    }
  };
}

async function writeFixture(): Promise<void> {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  const target = path.join(FIXTURE_DIR, "apm.yml");
  const tmp = path.join(FIXTURE_DIR, `apm.yml.tmp-${process.pid}`);
  await fs.writeFile(tmp, yaml.dump(fixtureManifest()), "utf8");
  await fs.rename(tmp, target);
}

async function readManifestComposition(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(FIXTURE_DIR, "apm.yml"), "utf8");
  const doc = yaml.load(raw) as { "x-garrison": { composition: Record<string, unknown> } };
  return doc["x-garrison"].composition;
}

function selectionsOf(block: Record<string, unknown>): Record<string, Array<{ id: string; config?: Record<string, unknown> }>> {
  return block.selections as Record<string, Array<{ id: string; config?: Record<string, unknown> }>>;
}

beforeEach(writeFixture);
afterAll(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
});

// A minimal LibraryEntry factory for the pure-core test (no fs).
function entry(id: string, faculty: string, metadata: Partial<GarrisonMetadata>, localPath?: string): LibraryEntry {
  return {
    id,
    name: id.replace(/-/g, " "),
    faculty: faculty as LibraryEntry["faculty"],
    repo: `local:fittings/seed/${id}`,
    localPath,
    summary: `${id} summary`,
    platforms: ["all"],
    ratings: {},
    metadata: {
      faculty: faculty as GarrisonMetadata["faculty"],
      cardinality_hint: "multi",
      component_shape: "script",
      platforms: ["all"],
      config_schema: [],
      provides: [],
      consumes: [],
      verify: { command: "true", expect: "", timeout_ms: 1000 },
      ...metadata
    } as GarrisonMetadata
  };
}

describe("buildStandingPayload (pure)", () => {
  const channelEntry = entry("web-channel-default", "channels", {
    component_shape: "plugin",
    own_port: true,
    config_schema: [{ key: "port", type: "integer", default: 7083, description: "port" }],
    provides: [{ kind: "channel", name: "web" }]
  });
  const runtimeEntry = entry(
    "agent-sdk-runtime",
    "runtimes",
    { component_shape: "cli-skill", provides: [{ kind: "runtime", name: "agent-sdk" }] },
    "fittings/seed/agent-sdk-runtime"
  );
  const dutyEntry = entry("dispatcher", "gateway", {
    component_shape: "script",
    provides: [{ kind: "duty", name: "dispatch" }]
  });
  const orchestratorEntry = entry("orchestrator", "orchestrator", {
    faculty: "orchestrator",
    provides: [{ kind: "orchestrator", name: "main" }]
  });

  const library = [channelEntry, runtimeEntry, dutyEntry, orchestratorEntry];

  it("returns the standing (non-duty) slots with config schema + values, excluding orchestrator", () => {
    const payload = buildStandingPayload({
      composition: {
        id: "c",
        name: "C",
        selections: {
          channels: [{ id: "web-channel-default", config: { port: 9000 } }],
          runtimes: [{ id: "agent-sdk-runtime", config: {} }],
          gateway: [{ id: "dispatcher", config: {} }],
          orchestrator: [{ id: "orchestrator", config: {} }]
        },
        primaryRuntime: "agent-sdk-runtime"
      },
      entries: library,
      library
    });

    // orchestrator is NOT a standing slot.
    expect(payload.slots.some((s) => s.faculty === "orchestrator")).toBe(false);
    // the eight infrastructure slots are present.
    expect(payload.slots.map((s) => s.faculty)).toEqual([
      "channels",
      "gateway",
      "runtimes",
      "memory",
      "observability",
      "sessions",
      "surfaces",
      "connectors"
    ]);

    const channels = payload.slots.find((s) => s.faculty === "channels")!;
    expect(channels.fittings).toHaveLength(1);
    expect(channels.fittings[0].configSchema[0].key).toBe("port");
    expect(channels.fittings[0].config.port).toBe(9000); // current value, not the default
    expect(channels.fittings[0].ownPort).toBe(true);

    // a duty-providing fitting is filtered OUT of its standing slot.
    const gateway = payload.slots.find((s) => s.faculty === "gateway")!;
    expect(gateway.fittings).toHaveLength(0);

    const runtimes = payload.slots.find((s) => s.faculty === "runtimes")!;
    expect(runtimes.fittings[0].providesRuntime).toBe(true);
    expect(runtimes.fittings[0].isPrimaryRuntime).toBe(true);

    // runtime templates come from the library's runtime fittings.
    expect(payload.runtimeTemplates.map((t) => t.id)).toContain("agent-sdk-runtime");
    expect(payload.primaryRuntime).toBe("agent-sdk-runtime");
  });
});

describe("standing model (fs-backed)", () => {
  it("assembles the standing model with the live selection state", async () => {
    const model = await assembleStandingModel(FIXTURE_ID);
    expect(model.compositionId).toBe(FIXTURE_ID);
    const gateway = model.slots.find((s) => s.faculty === "gateway")!;
    expect(gateway.fittings.map((f) => f.id)).toEqual(["http-gateway"]);
    expect(gateway.fittings[0].config.port).toBe(4777);
    // candidates for the swap picker are the library's gateway fittings.
    expect(gateway.candidates.some((c) => c.id === "mcp-gateway")).toBe(true);
  });

  it("(b) swap validates faculty compatibility and persists atomically", async () => {
    // gateway is multi; swapping http-gateway → mcp-gateway (both gateway) is valid.
    const { model } = await swapStandingFitting(FIXTURE_ID, "gateway", "mcp-gateway", "http-gateway");
    expect(model.slots.find((s) => s.faculty === "gateway")!.fittings.map((f) => f.id)).toEqual(["mcp-gateway"]);

    const block = await readManifestComposition();
    expect(selectionsOf(block).gateway.map((s) => s.id)).toEqual(["mcp-gateway"]);

    // a cross-faculty target is rejected (memory fitting cannot go in channels).
    await expect(swapStandingFitting(FIXTURE_ID, "channels", "basic-memory")).rejects.toThrow(/channels/);
    // a non-standing faculty is rejected.
    await expect(swapStandingFitting(FIXTURE_ID, "orchestrator", "orchestrator")).rejects.toThrow(/standing/);
  });

  it("re-authors apm dependencies on a membership swap", async () => {
    await swapStandingFitting(FIXTURE_ID, "gateway", "mcp-gateway", "http-gateway");
    const raw = await fs.readFile(path.join(FIXTURE_DIR, "apm.yml"), "utf8");
    const doc = yaml.load(raw) as { dependencies?: { apm?: unknown[] } };
    // mcp-gateway now appears in the dependency list (path or repo string).
    expect(JSON.stringify(doc.dependencies?.apm ?? [])).toContain("mcp-gateway");
  });

  it("(c) autosaves a config value into selections[].config", async () => {
    const model = await setStandingConfig(FIXTURE_ID, "gateway", "http-gateway", "port", 5555);
    const gateway = model.slots.find((s) => s.faculty === "gateway")!;
    expect(gateway.fittings[0].config.port).toBe(5555);

    const block = await readManifestComposition();
    expect(selectionsOf(block).gateway[0].config?.port).toBe(5555);

    // rejects a config write to a fitting not stationed in the slot.
    await expect(setStandingConfig(FIXTURE_ID, "gateway", "not-there", "port", 1)).rejects.toThrow(/not stationed/);
  });

  it("(d) a reference-loss swap OFFERS removal (returns orphaned) and never auto-removes", async () => {
    // `scheduler` provides automation-runner:scheduler, required by vault-git-sync
    // (sessions). Swapping it out for monitor-default (provides monitor) orphans it.
    const { model, orphaned } = await swapStandingFitting(
      FIXTURE_ID,
      "observability",
      "monitor-default",
      "scheduler"
    );

    // the swap DID persist (that is what the user asked for)…
    expect(model.slots.find((s) => s.faculty === "observability")!.fittings.map((f) => f.id)).toEqual([
      "monitor-default"
    ]);
    // …and the orphaned consumer is SURFACED, not removed.
    expect(orphaned.some((o) => o.fittingId === "vault-git-sync")).toBe(true);

    // vault-git-sync is STILL stationed — the removal was only offered.
    const block = await readManifestComposition();
    expect(selectionsOf(block).sessions.map((s) => s.id)).toContain("vault-git-sync");
  });

  it("removing an orphan is a real removal via the swap path (fromId only)", async () => {
    await swapStandingFitting(FIXTURE_ID, "observability", "monitor-default", "scheduler");
    await swapStandingFitting(FIXTURE_ID, "sessions", undefined, "vault-git-sync");
    const block = await readManifestComposition();
    expect(selectionsOf(block).sessions ?? []).toEqual([]);
  });

  it("sets the primary runtime and rejects a non-stationed runtime", async () => {
    const model = await setPrimaryRuntime(FIXTURE_ID, "agent-sdk-runtime");
    expect(model.primaryRuntime).toBe("agent-sdk-runtime");
    const runtimes = model.slots.find((s) => s.faculty === "runtimes")!;
    expect(runtimes.fittings.find((f) => f.id === "agent-sdk-runtime")!.isPrimaryRuntime).toBe(true);

    const block = await readManifestComposition();
    expect((block.global_config as { primary_runtime?: string }).primary_runtime).toBe("agent-sdk-runtime");

    await expect(setPrimaryRuntime(FIXTURE_ID, "gemini-runtime")).rejects.toThrow(/not a stationed runtime/);
  });

  it("test-connection is a static readiness check (stationed runtime passes; a non-runtime fails)", async () => {
    const ok = await testRuntimeConnection(FIXTURE_ID, "agent-sdk-runtime");
    expect(ok.ok).toBe(true);
    expect(ok.checks.find((c) => c.label === "Is a runtime")!.ok).toBe(true);
    expect(ok.note).toMatch(/static readiness|live model handshake/i);

    const bad = await testRuntimeConnection(FIXTURE_ID, "http-gateway");
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c) => c.label === "Stationed")!.ok).toBe(false);
  });

  // create-runtime's guard runs BEFORE any clone, so it writes no shared state
  // (clone.test.ts owns the ONLY test writes to data/library.json — the full
  // clone+station round-trip is covered there + by the swap/config write path).
  it("create-runtime rejects a non-runtime template before cloning anything", async () => {
    await expect(createRuntime(FIXTURE_ID, "http-gateway")).rejects.toThrow(/not a runtime template/);
    await expect(createRuntime(FIXTURE_ID, "does-not-exist")).rejects.toThrow(/unknown runtime template/);
    // no clone was created and the registry was untouched.
    expect(await fs.readdir(path.join(process.cwd(), "fittings", "local")).catch(() => [])).not.toContain(
      "http-gateway-copy"
    );
  });
});

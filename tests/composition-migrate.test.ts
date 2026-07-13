import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { migrateCompositionV3ToV4, unifiedDiff } from "@/lib/composition-migrate";

const DUMP_OPTS = { lineWidth: 100, noRefs: true, sortKeys: false } as const;

function fixtureManifest(compositionSelections: Record<string, unknown>) {
  return {
    name: "fixture",
    version: "0.1.0",
    target: "claude",
    dependencies: { apm: [] },
    "x-garrison": {
      composition: {
        id: "fixture",
        name: "Fixture",
        global_config: {
          projects_root: "~/dev",
          vault: "default",
          platform: "claude-code",
          guardrails: { max_tasks_per_tick: 5, max_spend_per_day: 25, max_tool_calls_per_tick: 30 },
          permissions_mode: "auto",
          observability_config: { log_sink: "runner" }
        },
        selections: compositionSelections
      }
    }
  };
}

async function writeFixture(dir: string, selections: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(dir, "apm.yml"), yaml.dump(fixtureManifest(selections), DUMP_OPTS), "utf8");
}

async function readComposition(file: string): Promise<Record<string, any>> {
  const raw = await fs.readFile(file, "utf8");
  return (yaml.load(raw) as any)["x-garrison"].composition;
}

describe("migrateCompositionV3ToV4", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-migrate-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("backs up, stamps schema 4, and extracts machine-local selection config", async () => {
    await writeFixture(dir, {
      gateway: [
        {
          id: "http-gateway",
          config: {
            port: 4777,
            bind_host: "127.0.0.1",
            gateway_url: "http://127.0.0.1:4777",
            public_url: "https://example.com"
          }
        }
      ],
      memory: [
        {
          id: "basic-memory",
          config: { vault_dir: "~/ObsidianVault", board_dir: "/home/tester/.garrison/kanban" }
        }
      ],
      observability: [{ id: "monitor", config: { slack_port: 9512, empty_url: "" } }]
    });
    const original = await fs.readFile(path.join(dir, "apm.yml"), "utf8");

    const result = await migrateCompositionV3ToV4(dir);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);

    // (b) backup holds the exact original bytes.
    const backup = await fs.readFile(path.join(dir, "apm.yml.v3.bak"), "utf8");
    expect(backup).toBe(original);

    // (c) schema: 4 stamped.
    const migrated = await readComposition(path.join(dir, "apm.yml"));
    expect(migrated.schema).toBe(4);

    // (d) ports / host / localhost url kept in apm.yml as portable defaults.
    expect(migrated.selections.gateway[0].config.port).toBe(4777);
    expect(migrated.selections.gateway[0].config.bind_host).toBe("127.0.0.1");
    expect(migrated.selections.gateway[0].config.gateway_url).toBe("http://127.0.0.1:4777");
    // non-localhost url stays put and is not machine-local.
    expect(migrated.selections.gateway[0].config.public_url).toBe("https://example.com");
    // paths removed from the committed manifest.
    expect(migrated.selections.memory[0].config).not.toHaveProperty("vault_dir");
    expect(migrated.selections.memory[0].config).not.toHaveProperty("board_dir");
    // global_config path values ARE extracted (codex S3b1 finding): a home path
    // like projects_root must not stay in the committed manifest — it moves to
    // the overlay. Portable scalars/nested config (vault, guardrails) stay.
    expect(migrated.global_config).not.toHaveProperty("projects_root");
    expect(migrated.global_config.vault).toBe("default");

    // local.yml carries the machine-local values (ports copied, paths moved).
    const overlay = yaml.load(await fs.readFile(path.join(dir, "local.yml"), "utf8")) as any;
    expect(overlay.global_config.projects_root).toBe("~/dev");
    expect(overlay.selections.gateway[0].config).toEqual({
      port: 4777,
      bind_host: "127.0.0.1",
      gateway_url: "http://127.0.0.1:4777"
    });
    expect(overlay.selections.gateway[0].config).not.toHaveProperty("public_url");
    expect(overlay.selections.memory[0].config).toEqual({
      vault_dir: "~/ObsidianVault",
      board_dir: "/home/tester/.garrison/kanban"
    });
    expect(overlay.selections.observability[0].config).toEqual({ slack_port: 9512 });

    // (e) a unified diff was produced showing the added marker + removed path.
    expect(result.diff).toContain("schema: 4");
    expect(result.diff).toMatch(/\n-\s+vault_dir: ~\/ObsidianVault/);
    expect(result.diff.startsWith("--- a/apm.yml")).toBe(true);
  });

  it("stamps schema 4 with no local.yml when there is nothing machine-local", async () => {
    // A composition with no machine-local values anywhere: portable global_config
    // (no path-shaped keys) + portable selection config.
    const manifest = fixtureManifest({
      observability: [{ id: "monitor", config: { log_level: "info", enabled: true } }]
    }) as any;
    manifest["x-garrison"].composition.global_config = {
      vault: "default",
      platform: "claude-code",
      permissions_mode: "auto"
    };
    await fs.writeFile(path.join(dir, "apm.yml"), yaml.dump(manifest, DUMP_OPTS), "utf8");

    const result = await migrateCompositionV3ToV4(dir);
    expect(result.ok).toBe(true);
    expect(result.localYml).toBeNull();
    await expect(fs.access(path.join(dir, "local.yml"))).rejects.toThrow();

    const migrated = await readComposition(path.join(dir, "apm.yml"));
    expect(migrated.schema).toBe(4);
    expect(migrated.selections.observability[0].config).toEqual({ log_level: "info", enabled: true });
  });

  it("refuses to run twice (the .v3.bak marker is the idempotence guard)", async () => {
    await writeFixture(dir, {
      gateway: [{ id: "http-gateway", config: { port: 4777 } }]
    });

    const first = await migrateCompositionV3ToV4(dir);
    expect(first.ok).toBe(true);
    const afterFirst = await fs.readFile(path.join(dir, "apm.yml"), "utf8");

    const second = await migrateCompositionV3ToV4(dir);
    expect(second.ok).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.reason).toMatch(/already/i);
    // the second (refused) run left the migrated file untouched.
    expect(await fs.readFile(path.join(dir, "apm.yml"), "utf8")).toBe(afterFirst);
  });

  it("throws on a file with no x-garrison.composition block", async () => {
    await fs.writeFile(path.join(dir, "apm.yml"), yaml.dump({ name: "x", version: "1" }), "utf8");
    await expect(migrateCompositionV3ToV4(dir)).rejects.toThrow(/composition block/i);
  });
});

describe("unifiedDiff", () => {
  it("emits standard unified headers and +/- lines", () => {
    const diff = unifiedDiff("f.txt", "a\nb\nc\n", "a\nB\nc\n");
    expect(diff).toContain("--- a/f.txt");
    expect(diff).toContain("+++ b/f.txt");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(diff).toContain(" a");
    expect(diff).toContain(" c");
  });

  it("reports no changes for identical input", () => {
    expect(unifiedDiff("f.txt", "same\n", "same\n")).toContain("(no changes)");
  });
});

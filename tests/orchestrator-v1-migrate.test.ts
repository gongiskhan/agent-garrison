import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FIX 2 — v1→v2 migrate-at-load in the orchestrator own-port server. A live
// composition can carry a v1 (role-based) routing.json on disk; the composer UI
// renders v2 only and crashes on v1. The server migrates ONCE at startup
// (backup + atomic write-back + policy recompile) and, in the GET path, serves
// v2 even if the file drifts back to v1 externally (without persisting there).
//
// Sandbox the config/policy/home to temp files BEFORE importing the server.
const dir = mkdtempSync(join(tmpdir(), "gar-v1-migrate-"));
const CONFIG = join(dir, "routing.json");
const POLICY = join(dir, "policy.json");
process.env.ORCHESTRATOR_CONFIG = CONFIG;
process.env.GARRISON_POLICY_PATH = POLICY;
process.env.GARRISON_HOME = join(dir, "garrison-home");

// A valid v1 config that migrates cleanly (same shape as the pure-lib
// migrateRoutingConfig test in orchestrator-policy.test.ts).
const V1_CONFIG = {
  version: 1,
  activeProfile: "balanced",
  taskTypes: ["code", "review", "research", "image", "video", "writing", "ops", "other"],
  tiers: ["T0-trivial", "T1-standard", "T2-deep"],
  exceptions: [{ id: "ex-x", when: "x", role: "review" }],
  matrix: {
    defaults: { role: "standard" },
    columns: { "T2-deep": "expert" },
    rows: { code: { default: "standard", cells: { "T0-trivial": "fast" } } }
  },
  discipline: {
    "T0-trivial": { review: "none", testing: "none", evidence: "none", distribution: "none" },
    "T1-standard": { review: "self-review", testing: "tests", evidence: "text", distribution: "none" },
    "T2-deep": { review: "review-by:default", testing: "full-gates", evidence: "video", distribution: "link" }
  },
  continuations: [],
  targets: [
    { id: "a-low", type: "runtime-target", runtime: "claude-code", model: "haiku", effort: "low" },
    { id: "a-med", type: "runtime-target", runtime: "claude-code", model: "sonnet", effort: "medium" },
    { id: "a-high", type: "runtime-target", runtime: "claude-code", model: "opus", effort: "high" },
    // v1 secondaries carried informational provider ids the v2 providers
    // section does not know — migration must drop them (CLI-native auth), or
    // the migrated config fails its own v2 validation on the first PUT.
    { id: "sec-codex", type: "secondary", runtime: "codex", provider: "openai", model: "gpt-5-codex" }
  ],
  profiles: {
    balanced: {
      preRoute: "on",
      roleMap: { expert: "a-high", standard: "a-med", fast: "a-low", image: "a-med", video: "a-med", review: "a-med" },
      disciplineOverrides: {}
    }
  }
};

// Write the v1 config to disk BEFORE the server starts, so the startup migration
// sees an existing v1 file (not the fresh-box seed path).
writeFileSync(CONFIG, JSON.stringify(V1_CONFIG, null, 2) + "\n", "utf8");

// Dynamic import: a static import hoists above the env sandbox lines.
// @ts-ignore — pure .mjs server
const { startServer } = await import("../fittings/seed/orchestrator/scripts/server.mjs");

let base = "";
let handle: any;

beforeAll(async () => {
  handle = await startServer({ port: 0 });
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(async () => {
  await handle?.close?.();
});

describe("orchestrator server — v1→v2 migrate-at-load (FIX 2)", () => {
  it("migrates the on-disk v1 routing.json to v2 at startup, preserving a .v1.bak", () => {
    const onDisk = JSON.parse(readFileSync(CONFIG, "utf8"));
    expect(onDisk.version).toBe(2);

    // the original v1 is preserved verbatim as <path>.v1.bak
    const bak = `${CONFIG}.v1.bak`;
    expect(existsSync(bak)).toBe(true);
    expect(JSON.parse(readFileSync(bak, "utf8")).version).toBe(1);
  });

  it("recompiles policy.json from the migrated config at startup", () => {
    expect(existsSync(POLICY)).toBe(true);
    const policy = JSON.parse(readFileSync(POLICY, "utf8"));
    // compilePolicy stamps the v2 policy version; a non-empty object proves a
    // real compile, not a truncated write.
    expect(policy).toBeTruthy();
    expect(typeof policy).toBe("object");
  });

  it("GET /routing returns the v2 config after migration", async () => {
    const j = await (await fetch(`${base}/routing`)).json();
    expect(j.config.version).toBe(2);
    expect(j.config.activeProfile).toBe("balanced");
    expect(j.baselineSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("drops unknown provider ids from migrated targets (v1 secondaries auth CLI-natively)", async () => {
    const j = await (await fetch(`${base}/routing`)).json();
    const sec = j.config.targets.find((t: any) => t.id === "sec-codex");
    expect(sec).toBeTruthy();
    expect(sec.provider).toBeUndefined();
    expect(sec.model).toBe("gpt-5-codex");
    // and the migrated config round-trips through the v2 validator: a no-op PUT
    // must be accepted (422 here would mean migration emitted an invalid config).
    const put = await fetch(`${base}/routing?baseline=${j.baselineSha}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(j.config)
    });
    expect(put.status).toBe(200);
  });

  it("GET /routing serves v2 even when the file drifts back to v1, without persisting", async () => {
    // Simulate an external write that reverts the file to v1 AFTER startup.
    writeFileSync(CONFIG, JSON.stringify(V1_CONFIG, null, 2) + "\n", "utf8");
    const j = await (await fetch(`${base}/routing`)).json();
    // served config is migrated to v2 in-memory...
    expect(j.config.version).toBe(2);
    // ...but the GET path never persists, so the file stays v1 on disk.
    expect(JSON.parse(readFileSync(CONFIG, "utf8")).version).toBe(1);
  });
});

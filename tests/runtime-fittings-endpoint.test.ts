import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// S3 (GARRISON-RUNTIMES-V1): the composer's /runtime-fittings feed and the PUT
// primaryRuntime guard — pure file reads over the composition on disk, no
// gateway. Sandbox a fake composition BEFORE importing the server (env is read
// at module load).
const dir = mkdtempSync(join(tmpdir(), "gar-runtimes-"));
const COMP = join(dir, "composition");
const CONFIG = join(dir, "routing.json");
const POLICY = join(dir, "policy.json");
process.env.MODEL_ROUTER_CONFIG = CONFIG;
process.env.MODEL_ROUTER_DECISIONS = join(dir, "decisions.jsonl");
process.env.GARRISON_POLICY_PATH = POLICY;
process.env.GARRISON_HOME = join(dir, "garrison-home");
process.env.GARRISON_COMPOSITION_DIR = COMP;

// Fake composition: two selected runtimes — one installed (codex-runtime, with
// a D3 mechanism), one selected-but-NOT-installed (ghost-runtime).
mkdirSync(join(COMP, "apm_modules", "_local", "codex-runtime"), { recursive: true });
writeFileSync(
  join(COMP, "apm.yml"),
  [
    "name: test-comp",
    "x-garrison:",
    "  composition:",
    "    id: test",
    "    selections:",
    "      runtimes:",
    "        - id: codex-runtime",
    "          config: {}",
    "        - id: ghost-runtime",
    "          config: {}",
    ""
  ].join("\n")
);
writeFileSync(
  join(COMP, "apm_modules", "_local", "codex-runtime", "apm.yml"),
  [
    "name: codex-runtime",
    "x-garrison:",
    "  faculty: runtimes",
    "  provides:",
    "    - kind: runtime",
    "      name: codex",
    "  provider_mechanism:",
    "    type: config-file",
    "    config_file: ~/.codex/config.toml",
    "    config_format: toml",
    "    config_key: model_providers",
    ""
  ].join("\n")
);

// @ts-ignore — pure .mjs server
const { startServer } = await import("../fittings/seed/orchestrator/scripts/server.mjs");

let base = "";
let handle: { close: () => Promise<void> | void } | null = null;

beforeAll(async () => {
  const s: any = await startServer({ port: 0 });
  handle = s;
  base = `http://${s.host}:${s.port}`;
});

afterAll(async () => {
  await handle?.close?.();
});

async function getRouting() {
  return (await fetch(`${base}/routing`)).json();
}
async function putRouting(config: unknown, baselineSha: string) {
  return fetch(`${base}/routing?baseline=${encodeURIComponent(baselineSha)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config })
  });
}

describe("GET /runtime-fittings (P3/D3)", () => {
  it("lists composed runtimes with engine, install state, and declared mechanism", async () => {
    const j = await (await fetch(`${base}/runtime-fittings`)).json();
    expect(j.available).toBe(true);
    expect(j.defaultPrimary).toBe("claude-code-runtime");
    const codex = j.runtimes.find((r: any) => r.id === "codex-runtime");
    expect(codex.installed).toBe(true);
    expect(codex.engine).toBe("codex");
    expect(codex.providerMechanism).toMatchObject({ type: "config-file", config_format: "toml" });
    const ghost = j.runtimes.find((r: any) => r.id === "ghost-runtime");
    expect(ghost.installed).toBe(false);
    expect(ghost.warning).toMatch(/not installed|unreadable/);
  });
});

describe("PUT /routing primaryRuntime guard (P3/D4)", () => {
  it("rejects an uninstalled primary loudly, naming the installed set and the fix", async () => {
    const { config, baselineSha } = await getRouting();
    const r = await putRouting({ ...config, primaryRuntime: "ghost-runtime" }, baselineSha);
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.errors.join(" ")).toMatch(/ghost-runtime.*not an installed runtime fitting/);
    expect(j.errors.join(" ")).toMatch(/codex-runtime/); // names what IS installed
  });

  it("accepts an installed primary and compiles it into policy.json", async () => {
    const { config, baselineSha } = await getRouting();
    const r = await putRouting({ ...config, primaryRuntime: "codex-runtime" }, baselineSha);
    expect(r.status).toBe(200);
    const { readFileSync } = await import("node:fs");
    const policy = JSON.parse(readFileSync(POLICY, "utf8"));
    expect(policy.primaryRuntime).toBe("codex-runtime");
    expect(policy.providers.map((p: any) => p.id)).toContain("anthropic-plan");
  });

  it("always allows the default id (claude-code is synthesizable without its fitting)", async () => {
    const { config, baselineSha } = await getRouting();
    const r = await putRouting({ ...config, primaryRuntime: "claude-code-runtime" }, baselineSha);
    expect(r.status).toBe(200);
  });
});

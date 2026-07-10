import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the server's config + decisions to temp files BEFORE importing it.
const dir = mkdtempSync(join(tmpdir(), "gar-router-srv-"));
const CONFIG = join(dir, "routing.json");
const DECISIONS = join(dir, "decisions.jsonl");
process.env.MODEL_ROUTER_CONFIG = CONFIG;
process.env.MODEL_ROUTER_DECISIONS = DECISIONS;
process.env.GARRISON_HOME = join(dir, "garrison-home");

// @ts-ignore — pure .mjs server
import { startServer } from "../fittings/seed/orchestrator/scripts/server.mjs";

let base = "";
let handle: any;

beforeAll(async () => {
  handle = await startServer({ port: 0 });
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(async () => {
  await handle?.close?.();
});

describe("model-router own-port server (MR2)", () => {
  it("GET /health → ok", async () => {
    const j = await (await fetch(`${base}/health`)).json();
    expect(j.ok).toBe(true);
  });

  it("GET /routing seeds from the seed config + returns a baselineSha", async () => {
    const j = await (await fetch(`${base}/routing`)).json();
    expect(j.config.activeProfile).toBe("balanced");
    expect(j.baselineSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PUT /routing with the correct baseline persists; GET reflects it", async () => {
    const cur = await (await fetch(`${base}/routing`)).json();
    const next = { ...cur.config, activeProfile: "economy" };
    const put = await fetch(`${base}/routing?baseline=${cur.baselineSha}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: next })
    });
    expect(put.status).toBe(200);
    const after = await (await fetch(`${base}/routing`)).json();
    expect(after.config.activeProfile).toBe("economy");
    // and the file on disk changed
    expect(readFileSync(CONFIG, "utf8")).toContain('"economy"');
  });

  it("PUT /routing with a stale baseline → 409 conflict", async () => {
    const put = await fetch(`${base}/routing?baseline=deadbeef`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { version: 1, activeProfile: "balanced", profiles: {} } })
    });
    expect(put.status).toBe(409);
    const j = await put.json();
    expect(j.error).toBe("conflict");
  });

  it("PUT /routing with an invalid config → 422", async () => {
    const cur = await (await fetch(`${base}/routing`)).json();
    const put = await fetch(`${base}/routing?baseline=${cur.baselineSha}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { version: 1, activeProfile: "nope", profiles: {} } })
    });
    expect(put.status).toBe(422);
  });

  it("POST /simulate (manual taskType/tier) resolves the real route", async () => {
    // reset to balanced first
    const cur = await (await fetch(`${base}/routing`)).json();
    await fetch(`${base}/routing?baseline=${cur.baselineSha}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { ...cur.config, activeProfile: "balanced" } })
    });
    const sim = await (
      await fetch(`${base}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskType: "code", tier: "T2-deep", profile: "balanced" })
      })
    ).json();
    expect(sim.route.role).toBe("expert");
    expect(sim.route.targetId).toBe("cc-opus-high");
  });

  it("GET /telemetry reads decisions.jsonl + aggregates by target", async () => {
    writeFileSync(
      DECISIONS,
      [
        JSON.stringify({ targetId: "cc-opus-high", ruleId: "cell:code/T2-deep", profile: "balanced" }),
        JSON.stringify({ targetId: "cc-opus-high", ruleId: "cell:code/T2-deep", profile: "balanced" }),
        JSON.stringify({ targetId: "cc-haiku-low", ruleId: "row:other", profile: "balanced" })
      ].join("\n") + "\n",
      "utf8"
    );
    const j = await (await fetch(`${base}/telemetry`)).json();
    expect(j.count).toBe(3);
    expect(j.byTarget["cc-opus-high"]).toBe(2);
    expect(j.byTarget["cc-haiku-low"]).toBe(1);
  });

  it("serves the built UI index", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<div id="root">');
  });
});

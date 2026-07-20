import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitExit } from "./helpers/wait-exit";

// Spotter capture core (Drill Evidence V2, S1): a real drill over a
// live-reloading build-style page captures frames on step boundaries, visual
// change (phash), console bursts, and message-region growth; near-duplicates
// collapse locally; the candidates manifest indexes every kept frame. Runs
// through the REAL browser-default + automations + drill servers.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7361;
const AUTOMATIONS_PORT = 7362;
const DRILL_PORT = 7363;
const STUB_PORT = 7364;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-spotter-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-spotter-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-spotter-target-"));

let browserSrv: ChildProcess | null = null;
let automationsSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let stubSrv: http.Server | null = null;

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function startVisionStub(): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: { passed: false, reasoning: "stub" } }));
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve(srv));
  });
}

// A "build-style" page: the preview flips black/white (large visual delta →
// phash trigger, and the A-B-A repetition forces dedupe collapses), a message
// list grows steadily (region-growth trigger), and the console bursts shortly
// after load and then periodically (burst trigger). Timers restart on every
// check's navigation, so the burst fires EARLY (800ms) to land inside each
// check's window.
const FIXTURE_URL =
  "data:text/html," +
  encodeURIComponent(
    `<style>#flip{width:100vw;height:55vh;background:#fff}.msg{font-size:22px;font-weight:bold;padding:5px;margin:2px;background:#ffd166}.msg:nth-child(even){background:#118ab2;color:#fff}</style>
<h1 data-testid="title">Spotter lab</h1>
<div id="flip"></div>
<ul id="msgs"></ul>
<script>
let on = false;
setInterval(() => { on = !on; document.getElementById("flip").style.background = on ? "#000" : "#fff"; }, 150);
setInterval(() => {
  const li = document.createElement("li");
  li.className = "msg";
  li.textContent = "message " + Date.now();
  document.getElementById("msgs").appendChild(li);
}, 120);
const burst = () => { for (let i = 0; i < 10; i++) console.log("build output line", i); };
setTimeout(() => { burst(); setInterval(burst, 900); }, 250);
</script>`
  );

const SPOTTER_CFG = {
  sampleMs: 100,
  phashThreshold: 9,
  dedupeDistance: 5,
  console: { lines: 6, windowMs: 1200, cooldownMs: 700 },
  messageRegion: { selector: ".msg", growth: 2 },
  pollMs: 120
};

function evidenceDirFor(runId: string): string | null {
  const root = path.join(ghome, "drill", "evidence");
  if (!existsSync(root)) return null;
  for (const key of readdirSync(root)) {
    const candidate = path.join(root, key, runId);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

beforeAll(async () => {
  stubSrv = await startVisionStub();
  mkdirSync(path.join(ghome, "ui-fittings"), { recursive: true });
  writeFileSync(
    path.join(ghome, "ui-fittings", "kanban-loop.json"),
    JSON.stringify({ fittingId: "kanban-loop", url: "http://127.0.0.1:9" })
  );

  browserSrv = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], {
    stdio: "ignore", env: { ...process.env, GARRISON_HOME: ghome }
  });
  expect(await waitHealthy(BROWSER_BASE, 15000)).toBe(true);

  automationsSrv = spawn("node", [AUTOMATIONS_START], {
    stdio: "ignore",
    env: {
      ...process.env, GARRISON_HOME: ghome, GARRISON_AUTOMATIONS_DIR: adir, GARRISON_BROWSER_URL: BROWSER_BASE,
      GARRISON_BASE_URL: STUB_BASE, AUTOMATIONS_UI_PORT: String(AUTOMATIONS_PORT), AUTOMATIONS_UI_HOST: "127.0.0.1"
    }
  });
  expect(await waitHealthy(AUTOMATIONS_BASE, 8000)).toBe(true);

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: {
      ...process.env, GARRISON_HOME: ghome, GARRISON_DRILL_TARGET_REPO: target,
      GARRISON_BROWSER_URL: BROWSER_BASE, DRILL_UI_PORT: String(DRILL_PORT), DRILL_UI_HOST: "127.0.0.1"
    }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);

  await fetch(`${DRILL_BASE}/api/drillbook`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: { name: "spotter-lab", url: FIXTURE_URL }, autonomy: "auto" })
  });
  await fetch(`${DRILL_BASE}/api/pages/lab`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Lab",
      path: "",
      areas: [{ n: 1, id: "lab#1", label: "Preview", anchors: { testId: "title" }, pct: null }],
      steps: [
        { id: "s-one", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "title visible (1)", assertion: { kind: "visible", testId: "title" }, tags: [] },
        { id: "s-two", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "title visible (2)", assertion: { kind: "visible", testId: "title" }, tags: [] },
        { id: "s-three", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "title visible (3)", assertion: { kind: "visible", testId: "title" }, tags: [] },
        { id: "s-four", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "title visible (4)", assertion: { kind: "visible", testId: "title" }, tags: [] }
      ]
    })
  });
}, 40000);

afterAll(async () => {
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  await waitExit(browserSrv);
  if (automationsSrv && !automationsSrv.killed) automationsSrv.kill("SIGKILL");
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  await new Promise((r) => stubSrv?.close(() => r(undefined)));
  browserSrv = null; automationsSrv = null; drillSrv = null; stubSrv = null;
    rmSync(ghome, { recursive: true, force: true });
  rmSync(adir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("Spotter capture core (S1)", () => {
  let run: any;
  let dir: string;
  let manifest: any;

  beforeAll(async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageIds: ["lab"],
        viewports: ["desktop"],
        evidence: { spotter: SPOTTER_CFG }
      })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    run = (await res.json()).run;
    dir = evidenceDirFor(run.id)!;
    expect(dir, "evidence dir exists").toBeTruthy();
    manifest = JSON.parse(readFileSync(path.join(dir, "spotter-frames.json"), "utf8"));
    // Trigger mix + counters in the test log — the first thing to read when a
    // timing-sensitive assertion below goes red.
    console.log("[spotter-e2e] counts:", JSON.stringify(manifest.counts),
      "triggers:", JSON.stringify(manifest.frames.map((f: any) => f.trigger)));
  }, 120000);

  it("summarizes Spotter on the run record and in evidence.json", () => {
    expect(run.evidence?.spotter?.manifest).toBe("spotter-frames.json");
    expect(run.evidence.spotter.frames).toBeGreaterThan(0);
    const index = JSON.parse(readFileSync(path.join(dir, "evidence.json"), "utf8"));
    const row = index.items.find((i: any) => i.kind === "spotter");
    expect(row).toBeTruthy();
    expect(row.manifest).toBe("spotter-frames.json");
    expect(row.frames).toBe(manifest.frames.length);
  });

  it("fires every deterministic trigger on the build-style page", () => {
    // A trigger EVENT surfaces either as a kept frame or as a recorded
    // collapse onto one (D1: nothing is invisibly dropped).
    const eventsFor = (trigger: string) =>
      manifest.frames.filter((f: any) => f.trigger === trigger).length +
      manifest.collapsed.filter((c: any) => c.trigger === trigger).length;
    const seen = JSON.stringify({
      kept: manifest.frames.map((f: any) => f.trigger),
      collapsed: manifest.collapsed.map((c: any) => c.trigger)
    });
    // (a) step boundaries always: one KEPT step-start per check at minimum.
    const boundaryStarts = manifest.frames.filter((f: any) => f.trigger === "step-start");
    expect(boundaryStarts.length, seen).toBeGreaterThanOrEqual(4);
    expect(manifest.frames.some((f: any) => f.trigger === "step-end"), seen).toBe(true);
    // (b) preview change trips the phash trigger.
    expect(eventsFor("phash"), seen).toBeGreaterThan(0);
    // (c) console burst.
    expect(eventsFor("console-burst"), seen).toBeGreaterThan(0);
    expect(manifest.counts.consoleBursts).toBeGreaterThan(0);
    // (d) message-region growth.
    expect(eventsFor("message-growth"), seen).toBeGreaterThan(0);
    expect(manifest.counts.regionTriggers).toBeGreaterThan(0);
  });

  it("collapses near-duplicate frames locally (D3) and records every collapse", () => {
    // The A-B-A background flip guarantees repeats within a check window.
    expect(manifest.counts.collapsed).toBeGreaterThan(0);
    const collapsedOnto = manifest.frames.reduce((sum: number, f: any) => sum + (f.collapsed ?? 0), 0);
    expect(collapsedOnto).toBe(manifest.counts.collapsed);
    expect(manifest.collapsed).toHaveLength(manifest.counts.collapsed);
    for (const row of manifest.collapsed) {
      expect(typeof row.trigger).toBe("string");
      expect(manifest.frames.some((f: any) => f.name === row.onto)).toBe(true);
      expect(row.dist).toBeLessThanOrEqual(SPOTTER_CFG.dedupeDistance);
    }
    // Capture-everything bookkeeping stays honest: kept matches the rows.
    expect(manifest.counts.kept).toBe(manifest.frames.length);
    expect(manifest.counts.sampled).toBeGreaterThan(0);
  });

  it("writes flat JPEG frames with sane manifest rows, joined to checks", () => {
    expect(manifest.frames.length).toBeGreaterThan(0);
    const runWindowMs = Date.parse(run.endedAt) - Date.parse(run.startedAt) + 30000;
    let lastT = -1;
    for (const frame of manifest.frames) {
      expect(frame.name).toMatch(/^frame-\d{4}\.jpg$/);
      const file = path.join(dir, frame.name);
      expect(existsSync(file), `${frame.name} exists`).toBe(true);
      const bytes = readFileSync(file);
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG magic
      expect(frame.bytes).toBe(bytes.length);
      expect(frame.tMs).toBeGreaterThanOrEqual(0);
      expect(frame.tMs).toBeLessThanOrEqual(runWindowMs);
      expect(frame.tMs).toBeGreaterThanOrEqual(lastT);
      lastT = frame.tMs;
      expect(typeof frame.hash === "string" || frame.hash === null).toBe(true);
    }
    // Frames captured inside a check window carry that check's key.
    const chunked = manifest.frames.filter((f: any) => typeof f.chunk === "string" && f.chunk.includes("--"));
    expect(chunked.length).toBeGreaterThan(0);
    expect(chunked.some((f: any) => f.chunk === "lab--s-one--desktop")).toBe(true);
  });

  it("serves frames and the manifest through the confined evidence routes", async () => {
    const frame = manifest.frames[0];
    const res = await fetch(`${DRILL_BASE}/api/runs/${run.id}/evidence-file/${frame.name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect((await res.arrayBuffer()).byteLength).toBe(frame.bytes);
    const man = await fetch(`${DRILL_BASE}/api/runs/${run.id}/evidence-file/spotter-frames.json`);
    expect(man.status).toBe(200);
    expect(man.headers.get("content-type")).toBe("application/json");
  });

  it("keeps the run outcome untouched by Spotter (all checks pass)", () => {
    expect(run.pages).toHaveLength(4);
    for (const entry of run.pages) expect(entry.terminal?.kind).toBe("passed");
    expect(run.findings).toHaveLength(0);
  });

  it("records Debrief feedback events next to the run evidence (D6)", async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs/${run.id}/debrief-feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "dwell", frame: "frame-0001.jpg", ms: 6200 },
          { type: "show-all", scope: "lab--s-one--desktop" },
          { type: "flag", frame: "frame-0002.jpg" }
        ]
      })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()).recorded).toBe(3);
    const file = JSON.parse(readFileSync(path.join(dir, "debrief-feedback.json"), "utf8"));
    expect(file.runId).toBe(run.id);
    expect(file.events).toHaveLength(3);
    expect(file.events[0]).toMatchObject({ type: "dwell", frame: "frame-0001.jpg", ms: 6200 });
    expect(typeof file.events[0].at).toBe("string");
    const bad = await fetch(`${DRILL_BASE}/api/runs/${run.id}/debrief-feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] })
    });
    expect(bad.status).toBe(400);
  });

  it("stays fully off when the caller disables it", async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["lab"], viewports: ["desktop"], evidence: { spotter: false } })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { run: off } = await res.json();
    expect(off.evidence?.spotter ?? null).toBeNull();
    const offDir = evidenceDirFor(off.id)!;
    expect(existsSync(path.join(offDir, "spotter-frames.json"))).toBe(false);
    expect(readdirSync(offDir).filter((f) => f.startsWith("frame-"))).toHaveLength(0);
    const index = JSON.parse(readFileSync(path.join(offDir, "evidence.json"), "utf8"));
    expect(index.items.some((i: any) => i.kind === "spotter")).toBe(false);
  }, 120000);
});

describe("Live Browser replay (S6)", () => {
  let run: any;

  beforeAll(async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["lab"], viewports: ["desktop"], evidence: { spotter: false } })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    run = (await res.json()).run;
  }, 120000);

  it("replays compiled steps into a held session and surfaces the live canvas", async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs/${run.id}/live-replay`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: "lab", stepId: "s-two", viewportId: "desktop" })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { live, warnings } = await res.json();
    expect(warnings).toEqual([]);
    expect(live.replayed).toBe(2); // s-one + s-two
    expect(live.of).toBe(2);
    expect(live.tabId).toBeTruthy();
    expect(live.canvasUrl).toContain(`/canvas/${encodeURIComponent(live.tabId)}`);
    expect(live.canvasUrl).toContain("embed=1");
    expect(live.canvasUrl).toContain("preserveViewport=1");
    // The held tab is real and open in the browser fitting.
    const { tabs } = await (await fetch(`${BROWSER_BASE}/tabs`)).json();
    expect(tabs.some((t: any) => t.tabId === live.tabId)).toBe(true);
    // Single-session lock: a second replay is refused while one is open.
    const second = await fetch(`${DRILL_BASE}/api/runs/${run.id}/live-replay`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: "lab", stepId: "s-one", viewportId: "desktop" })
    });
    expect(second.status).toBe(409);
    const state = await (await fetch(`${DRILL_BASE}/api/live-replay`)).json();
    expect(state.live.sessionId).toBe(live.sessionId);
  }, 60000);

  it("explicit close releases the session and the tab", async () => {
    const del = await fetch(`${DRILL_BASE}/api/live-replay`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).released).toBe(true);
    const state = await (await fetch(`${DRILL_BASE}/api/live-replay`)).json();
    expect(state.live).toBeNull();
    const { tabs } = await (await fetch(`${BROWSER_BASE}/tabs`)).json();
    expect(tabs).toHaveLength(0);
    // Idempotent: closing again is a no-op, and a new replay can start.
    const again = await fetch(`${DRILL_BASE}/api/live-replay`, { method: "DELETE" });
    expect((await again.json()).released).toBe(false);
  }, 30000);
});

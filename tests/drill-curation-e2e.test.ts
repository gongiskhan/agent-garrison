import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitExit } from "./helpers/wait-exit";

// Drill curation e2e (Evidence V2, S2): a real drill run's Spotter frames are
// batch-curated through the /api/drill/curation contract into reel.json +
// per-frame sidecars. The garrison app is a FAKE here (canned verdicts, body
// recording) — the real route's core is pinned in drill-curation-core.test.ts
// and the live model path is exercised by the acceptance run.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
let BROWSER_PORT = 0;
let AUTOMATIONS_PORT = 0;
let DRILL_PORT = 0;
let STUB_PORT = 0;
let FAKE_APP_PORT = 0;
let BROWSER_BASE = "";
let AUTOMATIONS_BASE = "";
let DRILL_BASE = "";
let STUB_BASE = "";
let FAKE_APP_BASE = "";
const INTERNAL_TOKEN = "curation-e2e-token";
const HEAVY_RUN_TIMEOUT_MS = 240_000;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-curation-e2e-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-curation-e2e-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-curation-e2e-target-"));

let browserSrv: ChildProcess | null = null;
let automationsSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let stubSrv: http.Server | null = null;
let fakeApp: http.Server | null = null;
const curationCalls: Array<{ token: string | undefined; body: any }> = [];

async function allocatePorts(count: number): Promise<number[]> {
  const servers: http.Server[] = [];
  const ports: number[] = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = http.createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to allocate a fixture port");
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

async function waitHealthy(base: string, ms: number, expectedPid: number | undefined) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok && (await response.json()).pid === expectedPid) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function startVisionStub(): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: { passed: false, reasoning: "stub" } }));
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve(srv));
  });
}

// The fake garrison app implements POST /api/drill/curation with the real
// contract shape: keep the first TWO frames of each batch (first with a
// highlight, "high" importance), drop the rest, annotate everything.
function startFakeApp(): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url !== "/api/drill/curation" || req.method !== "POST") {
        res.writeHead(404); res.end(); return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        curationCalls.push({ token: req.headers["x-garrison-internal"] as string | undefined, body });
        const results = (body.frames ?? []).map((f: any, i: number) => ({
          name: f.name,
          keep: i < 2,
          importance: i === 0 ? "high" : "normal",
          annotation: `canned annotation for ${f.name}`,
          highlight: i === 0 ? { x: 0.1, y: 0.2, w: 0.3, h: 0.15 } : null
        }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results, routedVia: "cc-test-target" }));
      });
    });
    srv.listen(FAKE_APP_PORT, "127.0.0.1", () => resolve(srv));
  });
}

const FIXTURE_URL =
  "data:text/html," +
  encodeURIComponent(
    `<style>#flip{width:100vw;height:55vh;background:#fff}.msg{font-size:22px;font-weight:bold;padding:5px;margin:2px;background:#ffd166}.msg:nth-child(even){background:#118ab2;color:#fff}</style>
<h1 data-testid="title">Curation lab</h1>
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
</script>`
  );

function evidenceDirFor(runId: string): string | null {
  const root = path.join(ghome, "drill", "evidence");
  if (!existsSync(root)) return null;
  for (const key of readdirSync(root)) {
    const candidate = path.join(root, key, runId);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function waitForFile(file: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

beforeAll(async () => {
  [BROWSER_PORT, AUTOMATIONS_PORT, DRILL_PORT, STUB_PORT, FAKE_APP_PORT] = await allocatePorts(5);
  BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
  AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
  DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;
  STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;
  FAKE_APP_BASE = `http://127.0.0.1:${FAKE_APP_PORT}`;
  stubSrv = await startVisionStub();
  fakeApp = await startFakeApp();
  mkdirSync(path.join(ghome, "ui-fittings"), { recursive: true });
  writeFileSync(path.join(ghome, "ui-fittings", "kanban-loop.json"), JSON.stringify({ fittingId: "kanban-loop", url: "http://127.0.0.1:9" }));
  writeFileSync(path.join(ghome, "internal-token"), INTERNAL_TOKEN);

  browserSrv = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], {
    stdio: "ignore", env: { ...process.env, GARRISON_HOME: ghome }
  });
  expect(await waitHealthy(BROWSER_BASE, 15000, browserSrv.pid)).toBe(true);

  automationsSrv = spawn("node", [AUTOMATIONS_START], {
    stdio: "ignore",
    env: {
      ...process.env, GARRISON_HOME: ghome, GARRISON_AUTOMATIONS_DIR: adir, GARRISON_BROWSER_URL: BROWSER_BASE,
      GARRISON_BASE_URL: STUB_BASE, AUTOMATIONS_UI_PORT: String(AUTOMATIONS_PORT), AUTOMATIONS_UI_HOST: "127.0.0.1"
    }
  });
  expect(await waitHealthy(AUTOMATIONS_BASE, 8000, automationsSrv.pid)).toBe(true);

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: {
      ...process.env, GARRISON_HOME: ghome, GARRISON_DRILL_TARGET_REPO: target,
      GARRISON_BROWSER_URL: BROWSER_BASE, GARRISON_BASE_URL: FAKE_APP_BASE,
      DRILL_UI_PORT: String(DRILL_PORT), DRILL_UI_HOST: "127.0.0.1"
    }
  });
  expect(await waitHealthy(DRILL_BASE, 8000, drillSrv.pid)).toBe(true);

  await fetch(`${DRILL_BASE}/api/drillbook`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: { name: "curation-lab", url: FIXTURE_URL }, autonomy: "auto" })
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
        { id: "s-three", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "title visible (3)", assertion: { kind: "visible", testId: "title" }, tags: [] }
      ]
    })
  });
}, 40000);

afterAll(async () => {
  for (const child of [drillSrv, automationsSrv, browserSrv]) {
    if (child && !child.killed) child.kill("SIGTERM");
  }
  await Promise.all([waitExit(drillSrv), waitExit(automationsSrv), waitExit(browserSrv)]);
  await new Promise((r) => stubSrv?.close(() => r(undefined)));
  await new Promise((r) => fakeApp?.close(() => r(undefined)));
  browserSrv = null; automationsSrv = null; drillSrv = null; stubSrv = null; fakeApp = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(adir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("Spotter curation (S2)", () => {
  let run: any;
  let dir: string;
  let reel: any;
  let spotterManifest: any;

  beforeAll(async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageIds: ["lab"],
        viewports: ["desktop"],
        evidence: {
          spotter: {
            sampleMs: 100, phashThreshold: 9, dedupeDistance: 5,
            console: { lines: 6, windowMs: 1200, cooldownMs: 700 },
            messageRegion: { selector: ".msg", growth: 2 }, pollMs: 120
          },
          curation: { maxCurated: 6, batchSize: 4 },
          video: false
        }
      })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    run = (await res.json()).run;
    dir = evidenceDirFor(run.id)!;
    expect(dir, "evidence dir exists").toBeTruthy();
    spotterManifest = JSON.parse(readFileSync(path.join(dir, "spotter-frames.json"), "utf8"));
    // Curation is fire-and-forget after the run response — wait for the reel.
    expect(await waitForFile(path.join(dir, "reel.json"), 20000), "reel.json appears").toBe(true);
    reel = JSON.parse(readFileSync(path.join(dir, "reel.json"), "utf8"));
  }, HEAVY_RUN_TIMEOUT_MS);

  it("sends confined frame batches with the internal token, capped by config", () => {
    expect(curationCalls.length).toBeGreaterThan(0);
    let totalFrames = 0;
    for (const call of curationCalls) {
      expect(call.token).toBe(INTERNAL_TOKEN);
      const frames = call.body.frames ?? [];
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.length).toBeLessThanOrEqual(4); // batchSize
      totalFrames += frames.length;
      for (const f of frames) {
        expect(f.name).toMatch(/^frame-\d{4}\.jpg$/);
        expect(f.path).toBe(path.join(dir, f.name));
        expect(existsSync(f.path)).toBe(true);
      }
      expect(call.body.meta?.app).toBe("curation-lab");
      expect(call.body.meta?.runId).toBe(run.id);
    }
    expect(totalFrames).toBeLessThanOrEqual(6); // maxCurated
  });

  it("writes reel.json with honest counts and a reel no larger than the candidates", () => {
    expect(reel.runId).toBe(run.id);
    expect(reel.routedVia).toBe("cc-test-target");
    expect(reel.counts.frames).toBe(spotterManifest.frames.length);
    expect(reel.counts.candidates).toBeLessThanOrEqual(6);
    expect(reel.counts.curated).toBe(reel.counts.candidates);
    expect(reel.counts.reel).toBeGreaterThan(0);
    // The reel is the model's keeps PLUS the deterministic floor (S2): every
    // check is guaranteed a frame, because a scope that renders empty reads as
    // a broken Debrief even when the model simply chose to drop everything.
    // Canned rule: 2 keeps per batch of <=4.
    const modelKeeps = reel.frames.filter((f: any) => f.keep === true && f.floor !== true);
    expect(modelKeeps.length).toBeLessThanOrEqual(2 * curationCalls.length);
    expect(reel.counts.reel).toBe(modelKeeps.length + reel.counts.floored);
    expect(reel.frames).toHaveLength(spotterManifest.frames.length);
    // The guarantee itself: no check is left without a frame.
    const chunks = new Set(reel.frames.map((f: any) => f.chunk ?? ""));
    const covered = new Set(reel.frames.filter((f: any) => f.keep === true).map((f: any) => f.chunk ?? ""));
    expect(covered).toEqual(chunks);
    const uncurated = reel.frames.filter((f: any) => f.uncurated === true);
    expect(uncurated.length).toBe(reel.counts.uncurated);
    // A floored frame is flagged and annotated as auto-selected, never passed
    // off as a curation decision.
    for (const row of reel.frames.filter((f: any) => f.floor === true)) {
      expect(row.annotation).toMatch(/Auto-selected/);
      expect(row.uncurated).toBeUndefined();
    }
    for (const row of modelKeeps) {
      expect(row.annotation).toContain("canned annotation");
    }
  });

  it("writes one sidecar JSON per curated frame", () => {
    const curatedNames = new Set(
      reel.frames.filter((f: any) => !f.uncurated).map((f: any) => f.name)
    );
    expect(curatedNames.size).toBeGreaterThan(0);
    for (const name of curatedNames) {
      const sidecar = JSON.parse(readFileSync(path.join(dir, (name as string).replace(/\.jpg$/, ".json")), "utf8"));
      expect(sidecar.name).toBe(name);
      expect(typeof sidecar.keep).toBe("boolean");
      expect(sidecar.annotation).toContain("canned annotation");
      expect(sidecar.routedVia).toBe("cc-test-target");
    }
    // The high-importance first-of-batch carries its highlight through.
    const high = reel.frames.find((f: any) => f.importance === "high");
    expect(high).toBeTruthy();
    expect(high.highlight).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.15 });
  });

  it("stamps the reel row into evidence.json", () => {
    const index = JSON.parse(readFileSync(path.join(dir, "evidence.json"), "utf8"));
    const row = index.items.find((i: any) => i.kind === "reel");
    expect(row).toBeTruthy();
    expect(row.manifest).toBe("reel.json");
    expect(row.frames).toBe(reel.counts.reel);
    expect(row.routedVia).toBe("cc-test-target");
  });

  it("skips curation entirely when disabled", async () => {
    const before = curationCalls.length;
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["lab"], viewports: ["desktop"], evidence: { curation: false, video: false } })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { run: offRun } = await res.json();
    await new Promise((r) => setTimeout(r, 3000));
    expect(curationCalls.length).toBe(before);
    const offDir = evidenceDirFor(offRun.id)!;
    expect(existsSync(path.join(offDir, "reel.json"))).toBe(false);
  }, 60000);
});

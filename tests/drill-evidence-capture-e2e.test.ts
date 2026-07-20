import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitExit } from "./helpers/wait-exit";

// Drill Evidence Capture (v0.1): a multi-check run records ONE run-level webm
// through a browser capture session (dedicated context + single reusable tab)
// plus a steps.json offset manifest; a single-check run keeps video off by
// default (D5) while the rest of the run behaves identically. Runs through
// the REAL browser-default + automations + drill servers — the same vision
// stub as drill-run-e2e keeps the failing step's fallback hermetic.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7351;
const AUTOMATIONS_PORT = 7352;
const DRILL_PORT = 7353;
const STUB_PORT = 7354;
const FAKE_KANBAN_PORT = 7355;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-evidence-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-evidence-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-evidence-target-"));

let browserSrv: ChildProcess | null = null;
let automationsSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let stubSrv: http.Server | null = null;
let fakeKanban: http.Server | null = null;
const kanbanCreates: any[] = [];

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
        let body: any = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* ignore */ }
        res.writeHead(200, { "content-type": "application/json" });
        if (body.mode === "verify") {
          res.end(JSON.stringify({ result: { passed: false, reasoning: "stub: element not found" } }));
        } else if (body.mode === "fix") {
          res.end(JSON.stringify({ result: { kind: "abort", reasoning: "stub: no fix available" } }));
        } else {
          res.end(JSON.stringify({ result: { passed: false, reasoning: "stub" } }));
        }
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve(srv));
  });
}

const FIXTURE_URL =
  "data:text/html," +
  encodeURIComponent(
    '<h1 data-testid="title">Evidence fixture</h1><div data-testid="answer">The answer.</div>'
  );

// The run's evidence dir is <ghome>/drill/evidence/<projectKey>/<runId>/;
// projectKey derivation is drill-internal, so locate by glob on runId.
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

  // A fake kanban-loop records what dispatch SENDS (the drill-side card link
  // contract); the real kanban door's videoUrl stamping is pinned in
  // tests/kanban-add-card.test.ts.
  fakeKanban = http.createServer((req, res) => {
    if (req.url === "/cards" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        kanbanCreates.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ card: { id: `01FAKECARD${kanbanCreates.length}`, rev: 0, list: "backlog", ...body } }));
      });
      return;
    }
    const move = req.url?.match(/^\/cards\/([^/]+)$/);
    if (move && req.method === "PATCH") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ card: { id: decodeURIComponent(move![1]), rev: (body.rev ?? 0) + 1, list: body.list } }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => fakeKanban!.listen(FAKE_KANBAN_PORT, "127.0.0.1", () => r()));
  const uiFittingsDir = path.join(ghome, "ui-fittings");
  mkdirSync(uiFittingsDir, { recursive: true });
  writeFileSync(path.join(uiFittingsDir, "kanban-loop.json"), JSON.stringify({ fittingId: "kanban-loop", url: `http://127.0.0.1:${FAKE_KANBAN_PORT}` }));

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
    body: JSON.stringify({ app: { name: "fixture", url: FIXTURE_URL }, autonomy: "auto" })
  });
  await fetch(`${DRILL_BASE}/api/pages/answer`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Answer",
      path: "",
      areas: [{ n: 1, id: "answer#1", label: "Answer", anchors: { testId: "answer" }, pct: null }],
      steps: [
        { id: "s-title", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "title is visible", assertion: { kind: "visible", testId: "title" }, tags: [] },
        { id: "s-answer", area: 1, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "answer is visible", assertion: { kind: "visible", testId: "answer" }, tags: [] },
        { id: "s-fail", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "nonexistent element is visible", assertion: { kind: "visible", testId: "does-not-exist" }, tags: [] }
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
  await new Promise((r) => fakeKanban?.close(() => r(undefined)));
  browserSrv = null; automationsSrv = null; drillSrv = null; stubSrv = null; fakeKanban = null;
    rmSync(ghome, { recursive: true, force: true });
  rmSync(adir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("run-level video + steps.json (S1)", () => {
  let runId: string;
  let run: any;

  beforeAll(async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"] })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    run = (await res.json()).run;
    runId = run.id;
  }, 120000);

  it("records ONE playable webm for the whole multi-check run", () => {
    expect(run.evidence?.video).toBe("video.webm");
    const dir = evidenceDirFor(runId);
    expect(dir, "evidence dir exists").toBeTruthy();
    const videoPath = path.join(dir!, "video.webm");
    expect(existsSync(videoPath)).toBe(true);
    const bytes = readFileSync(videoPath);
    // EBML magic — the container really is webm/matroska, not an empty file.
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    expect(bytes.length).toBeGreaterThan(4096);
    // Exactly one video: the session tab is reused across checks, so no
    // per-check segment files may exist.
    const webms = readdirSync(dir!).filter((f) => f.endsWith(".webm"));
    expect(webms).toEqual(["video.webm"]);
    expect(existsSync(path.join(dir!, ".video-tmp"))).toBe(false);
  });

  it("writes a steps.json manifest whose offsets are consistent with the run", () => {
    expect(run.evidence?.steps).toBe("steps.json");
    const dir = evidenceDirFor(runId)!;
    const rows = JSON.parse(readFileSync(path.join(dir, "steps.json"), "utf8"));
    expect(rows).toHaveLength(3);
    const byStep = Object.fromEntries(rows.map((r: any) => [r.stepId, r]));
    expect(byStep["s-title"]).toBeTruthy();
    expect(byStep["s-answer"]).toBeTruthy();
    expect(byStep["s-fail"]).toBeTruthy();
    const runDurationMs = Date.parse(run.endedAt) - Date.parse(run.startedAt);
    for (const row of rows) {
      expect(row.pageId).toBe("answer");
      expect(row.viewportId).toBe("desktop");
      expect(typeof row.title).toBe("string");
      expect(row.startMs).toBeGreaterThanOrEqual(0);
      expect(row.endMs).toBeGreaterThanOrEqual(row.startMs);
      // Offsets live inside the recording window (generous slack for the
      // session start preceding the first check).
      expect(row.endMs).toBeLessThanOrEqual(runDurationMs + 30000);
      // Rows join back to the drill run's page entries.
      const entry = run.pages.find((p: any) => p.stepId === row.stepId);
      expect(row.automationRunId).toBe(entry.automationRunId);
      expect(row.status).toBe(entry.status);
    }
    // Sequential run: manifest rows are time-ordered.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].startMs).toBeGreaterThanOrEqual(rows[i - 1].startMs);
    }
  });

  it("keeps the run outcome identical to a non-captured run (checks + finding)", () => {
    const stepIds = run.pages.map((p: any) => p.stepId);
    expect(stepIds).toEqual(expect.arrayContaining(["s-title", "s-answer", "s-fail"]));
    expect(run.findings.some((f: any) => f.kind === "step-fail" && f.stepId === "s-fail")).toBe(true);
  });

  it("leaves no capture session behind (browser tab count returns to baseline)", async () => {
    const { tabs } = await (await fetch(`${BROWSER_BASE}/tabs`)).json();
    expect(tabs).toHaveLength(0);
  });
});

// Minimal zip central-directory reader — enough to prove a Playwright trace
// chunk is a structurally valid archive with trace entries, without adding an
// unzip dependency.
function zipEntryNames(file: string): string[] {
  const buf = readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  expect(eocd, `${path.basename(file)} has an end-of-central-directory record`).toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8"));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

describe("per-check trace chunks + screenshots (S2)", () => {
  let dir: string;
  let runId: string;

  beforeAll(async () => {
    // Re-enable all steps (the D5 block below narrows them again).
    const pageDoc = await (await fetch(`${DRILL_BASE}/api/pages/answer`)).json();
    await fetch(`${DRILL_BASE}/api/pages/answer`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...pageDoc.page,
        steps: pageDoc.page.steps.map((s: any) => ({ ...s, enabled: true }))
      })
    });
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"] })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    runId = (await res.json()).run.id;
    dir = evidenceDirFor(runId)!;
    expect(dir).toBeTruthy();
  }, 120000);

  it("cuts one structurally valid Playwright trace zip per check", () => {
    for (const key of ["answer--s-title--desktop", "answer--s-answer--desktop", "answer--s-fail--desktop"]) {
      const file = path.join(dir, `trace-${key}.zip`);
      expect(existsSync(file), `trace-${key}.zip exists`).toBe(true);
      const names = zipEntryNames(file);
      expect(names.some((n) => n.endsWith(".trace")), `trace-${key}.zip carries a .trace entry`).toBe(true);
      expect(names.some((n) => n.endsWith(".network")), `trace-${key}.zip carries a .network entry`).toBe(true);
    }
  });

  it("takes a full-page step-end screenshot per check and an extra one on failure", () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (const key of ["answer--s-title--desktop", "answer--s-answer--desktop", "answer--s-fail--desktop"]) {
      const shot = path.join(dir, `step-${key}.png`);
      expect(existsSync(shot), `step-${key}.png exists`).toBe(true);
      expect(readFileSync(shot).subarray(0, 4)).toEqual(pngMagic);
    }
    expect(existsSync(path.join(dir, "fail-answer--s-fail--desktop.png"))).toBe(true);
    expect(existsSync(path.join(dir, "fail-answer--s-title--desktop.png"))).toBe(false);
    expect(existsSync(path.join(dir, "fail-answer--s-answer--desktop.png"))).toBe(false);
  });
});

describe("single-check run defaults (D5)", () => {
  it("keeps video off but still writes the manifest", async () => {
    // Narrow the page to ONE enabled step — the single-step authoring shape.
    const pageDoc = await (await fetch(`${DRILL_BASE}/api/pages/answer`)).json();
    await fetch(`${DRILL_BASE}/api/pages/answer`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...pageDoc.page,
        steps: pageDoc.page.steps.map((s: any) => ({ ...s, enabled: s.id === "s-title" }))
      })
    });
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"] })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { run: single } = await res.json();
    expect(single.pages).toHaveLength(1);
    expect(single.evidence?.video).toBeNull();
    expect(single.evidence?.steps).toBe("steps.json");
    const dir = evidenceDirFor(single.id)!;
    expect(existsSync(path.join(dir, "video.webm"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, "steps.json"), "utf8"))).toHaveLength(1);
    // Tracing chunks + step screenshots stay ON for single-check runs (D5).
    expect(existsSync(path.join(dir, "trace-answer--s-title--desktop.zip"))).toBe(true);
    expect(existsSync(path.join(dir, "step-answer--s-title--desktop.png"))).toBe(true);
  }, 60000);

  it("records video when explicitly requested on a single-check run", async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"], evidence: { video: true } })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { run: forced } = await res.json();
    expect(forced.evidence?.video).toBe("video.webm");
    const videoPath = path.join(evidenceDirFor(forced.id)!, "video.webm");
    const bytes = readFileSync(videoPath);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }, 60000);
});

describe("evidence.json indexing + surfacing (S3)", () => {
  let run: any;
  let dir: string;

  beforeAll(async () => {
    const pageDoc = await (await fetch(`${DRILL_BASE}/api/pages/answer`)).json();
    await fetch(`${DRILL_BASE}/api/pages/answer`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...pageDoc.page,
        steps: pageDoc.page.steps.map((s: any) => ({ ...s, enabled: true }))
      })
    });
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"] })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    run = (await res.json()).run;
    dir = evidenceDirFor(run.id)!;
    expect(dir).toBeTruthy();
  }, 120000);

  it("writes evidence.json in the one-row-per-item shape with an auditable video row", () => {
    expect(run.evidence?.index).toBe("evidence.json");
    const index = JSON.parse(readFileSync(path.join(dir, "evidence.json"), "utf8"));
    expect(index.runId).toBe(run.id);
    expect(index.drillId).toBe(path.basename(path.dirname(dir)));
    const videoRow = index.items.find((i: any) => i.kind === "video");
    const videoBytes = readFileSync(path.join(dir, "video.webm"));
    expect(videoRow.path).toBe("video.webm");
    expect(videoRow.bytes).toBe(videoBytes.length);
    expect(videoRow.sha256).toBe(crypto.createHash("sha256").update(videoBytes).digest("hex"));
    const stepRows = index.items.filter((i: any) => i.kind === "step");
    expect(stepRows).toHaveLength(3);
    for (const row of stepRows) {
      expect(row.trace).toMatch(/^trace-.*\.zip$/);
      expect(row.screenshot).toMatch(/^step-.*\.png$/);
      expect(existsSync(path.join(dir, row.trace))).toBe(true);
      expect(existsSync(path.join(dir, row.screenshot))).toBe(true);
    }
    const failRow = stepRows.find((i: any) => i.stepId === "s-fail");
    expect(failRow.status).toBe("failed");
    expect(failRow.failureScreenshot).toBe("fail-answer--s-fail--desktop.png");
  });

  it("attaches an evidence pointer to the failing finding at creation", () => {
    const finding = run.findings.find((f: any) => f.kind === "step-fail" && f.stepId === "s-fail");
    expect(finding.evidence).toMatchObject({
      screenshot: "fail-answer--s-fail--desktop.png",
      trace: "trace-answer--s-fail--desktop.zip"
    });
    expect(typeof finding.evidence.videoMs).toBe("number");
  });

  it("serves the index over /evidence-index and files over /evidence-file with Range support", async () => {
    const idx = await fetch(`${DRILL_BASE}/api/runs/${run.id}/evidence-index`);
    expect(idx.status).toBe(200);
    const { index, steps } = await idx.json();
    expect(index.items.length).toBeGreaterThanOrEqual(4);
    expect(steps).toHaveLength(3);

    const whole = await fetch(`${DRILL_BASE}/api/runs/${run.id}/evidence-file/video.webm`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/webm");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");

    const partial = await fetch(`${DRILL_BASE}/api/runs/${run.id}/evidence-file/video.webm`, {
      headers: { range: "bytes=0-99" }
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toMatch(/^bytes 0-99\//);
    expect((await partial.arrayBuffer()).byteLength).toBe(100);

    const shot = await fetch(`${DRILL_BASE}/api/runs/${run.id}/evidence-file/step-answer--s-title--desktop.png`);
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/png");

    const traversal = await fetch(`${DRILL_BASE}/api/runs/${run.id}/evidence-file/..%2F..%2Fsecrets.txt`);
    expect([400, 404]).toContain(traversal.status);
    const missing = await fetch(`${DRILL_BASE}/api/runs/${run.id}/evidence-file/nope.png`);
    expect(missing.status).toBe(404);
  });

  it("dispatch carries evidence links in the card body and the run video as videoUrl", async () => {
    const finding = run.findings.find((f: any) => f.kind === "step-fail" && f.stepId === "s-fail");
    const triage = await fetch(`${DRILL_BASE}/api/runs/${run.id}/findings/${finding.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "confirmed" })
    });
    expect(triage.status, await triage.clone().text()).toBe(200);
    const dispatch = await fetch(`${DRILL_BASE}/api/runs/${run.id}/dispatch`, { method: "POST" });
    expect(dispatch.status, await dispatch.clone().text()).toBe(200);
    const posted = kanbanCreates.at(-1);
    expect(posted.videoUrl).toBe(`http://127.0.0.1:${DRILL_PORT}/api/runs/${run.id}/evidence-file/video.webm`);
    expect(posted.description).toContain(`/api/runs/${run.id}/evidence-file/fail-answer--s-fail--desktop.png`);
    expect(posted.description).toMatch(/video @\d+s: http.*video\.webm#t=\d+/);
  }, 30000);
});

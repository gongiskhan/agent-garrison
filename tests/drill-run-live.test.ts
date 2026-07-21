// S31 - live run observability. A background run persists its record before
// and during execution, streams per-check progress over SSE, links each
// vision check to its Claude verify session, stores a per-run transcript
// slice with the run's evidence, and serves the transcript back through the
// confined session-stream route. A record left open by a dead server process
// is closed by the boot sweep.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const AUTOMATIONS_PORT = 7391;
const DRILL_PORT = 7392;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-drill-live-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-drill-live-target-"));
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const TRANSCRIPT = path.join(ghome, "fake-projects", `${SESSION_ID}.jsonl`);
const ORPHAN_ID = "01ORPHANRUN000000000000000";

let drill: ChildProcess | null = null;
let automations: http.Server | null = null;
let inlineCalls = 0;
let inlineDelayMs = 0;

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function writeTranscriptFixture() {
  const ts = () => new Date().toISOString();
  const lines = [
    { type: "ai-title", title: "Verify checkout rendering" },
    {
      type: "user", uuid: "u1", timestamp: ts(),
      message: { role: "user", content: [{ type: "text", text: "You are resolving a browser VERIFY step. Expected: the checkout total renders." }] }
    },
    {
      type: "assistant", uuid: "a1", timestamp: ts(),
      message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/screenshot.jpg" } }] }
    },
    {
      type: "user", uuid: "u2", timestamp: ts(),
      message: {
        role: "user",
        content: [{
          type: "tool_result", tool_use_id: "tool-1",
          content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("fake-jpeg").toString("base64") } }]
        }]
      }
    },
    {
      type: "assistant", uuid: "a2", timestamp: ts(),
      message: { role: "assistant", content: [{ type: "text", text: '{"passed": true, "reasoning": "total renders"}' }] }
    }
  ];
  mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
  writeFileSync(TRANSCRIPT, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

function startAutomationsStub() {
  return new Promise<http.Server>((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"ok"}');
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/runs/")) {
        // Hydration route: returns the step record WITH the absolute
        // transcript path, the way the real engine persists it - the drill
        // wire must strip it (S31 wire hygiene).
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          run: {
            id: decodeURIComponent(req.url.split("/").at(-1) ?? ""),
            status: "completed",
            steps: [{
              stepId: "total",
              status: "completed",
              tier: "vision",
              result: { tier: "vision", passed: true, vision: { sessionId: SESSION_ID, transcriptPath: TRANSCRIPT } }
            }]
          }
        }));
        return;
      }
      if (req.method !== "POST" || !req.url?.startsWith("/api/automations/run-inline")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not found"}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        inlineCalls += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const stepId = body.automation.steps.at(-1).id;
        const respond = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            run: {
              id: `vision-run-${inlineCalls}`,
              status: "completed",
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              steps: [
                { stepId: "__drill_navigate", status: "completed", tier: "execute", durationMs: 40 },
                {
                  stepId,
                  status: "completed",
                  tier: "vision",
                  durationMs: 1200,
                  result: {
                    tier: "vision",
                    passed: true,
                    reasoning: "looks right",
                    vision: { sessionId: SESSION_ID, transcriptPath: TRANSCRIPT, routedVia: "cc-sonnet-med" }
                  }
                }
              ]
            }
          }));
        };
        setTimeout(respond, inlineDelayMs);
      });
    });
    server.listen(AUTOMATIONS_PORT, "127.0.0.1", () => resolve(server));
  });
}

// Minimal SSE reader over fetch: collects `data:` payloads until the
// predicate is satisfied or the stream/timeout ends.
async function readSse(url: string, until: (events: any[]) => boolean, timeoutMs = 15000): Promise<any[]> {
  const response = await fetch(url);
  expect(response.status, url).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: any[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      let frameEnd;
      while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
      }
      if (until(events)) {
        reader.cancel().catch(() => {});
        return events;
      }
    }
    if (done) break;
  }
  return events;
}

beforeAll(async () => {
  writeTranscriptFixture();
  // A record a dead server left open: the boot sweep must close it.
  const orphanDir = path.join(ghome, "drill", "runs");
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(path.join(orphanDir, `${ORPHAN_ID}.json`), JSON.stringify({
    id: ORPHAN_ID,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    endedAt: null,
    contextTag: "drill",
    state: "default",
    project: target,
    dispatch: "manual",
    pages: [],
    feedback: {},
    overrides: {},
    observations: [],
    findings: [],
    infraErrors: [],
    plannedChecks: 5,
    executedChecks: 2
  }, null, 2));

  automations = await startAutomationsStub();
  drill = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: {
      ...process.env,
      GARRISON_HOME: ghome,
      GARRISON_DRILL_TARGET_REPO: target,
      GARRISON_AUTOMATIONS_URL: AUTOMATIONS_BASE,
      DRILL_UI_PORT: String(DRILL_PORT),
      DRILL_UI_HOST: "127.0.0.1"
    }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);
  await fetch(`${DRILL_BASE}/api/drillbook`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ autonomy: "auto", app: { name: "fixture", url: "http://example.test" } })
  });
  await fetch(`${DRILL_BASE}/api/pages/checkout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Checkout",
      path: "/checkout",
      steps: ["total", "pay"].map((id) => ({
        id,
        area: 0,
        mode: "vision",
        enabled: true,
        state: "default",
        viewports: ["desktop"],
        description: `${id} is correct`,
        tags: []
      }))
    })
  });
}, 20000);

afterAll(async () => {
  if (drill && !drill.killed) drill.kill("SIGTERM");
  await new Promise((resolve) => automations?.close(() => resolve(undefined)));
  drill = null;
  automations = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("Drill live run observability (S31)", () => {
  it("closes a run record orphaned by a dead server at boot", async () => {
    const persisted = JSON.parse(readFileSync(path.join(ghome, "drill", "runs", `${ORPHAN_ID}.json`), "utf8"));
    expect(persisted.endedAt).toBeTruthy();
    expect(persisted.circuit).toMatchObject({ code: "drill-restarted-mid-run", component: "drill" });
    expect(persisted.infraErrors[0]).toMatchObject({ code: "drill-restarted-mid-run" });
  });

  it("runs in the background, streams progress, and links verify sessions", async () => {
    inlineDelayMs = 400;
    const response = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["checkout"], viewports: ["desktop"], background: true })
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const kicked = await response.json();
    expect(kicked.background).toBe(true);
    expect(kicked.run.endedAt).toBeNull();
    const runId = kicked.run.id as string;

    // The in-flight run is discoverable and its record is already on disk.
    const active = await (await fetch(`${DRILL_BASE}/api/runs/active`)).json();
    expect(active.runs.map((run: any) => run.id)).toContain(runId);
    const onDisk = JSON.parse(readFileSync(path.join(ghome, "drill", "runs", `${runId}.json`), "utf8"));
    expect(onDisk.endedAt).toBeNull();

    // One run per project: a second start while this one executes 409s.
    const dupe = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["checkout"], viewports: ["desktop"] })
    });
    expect(dupe.status).toBe(409);

    // Review mutations are refused while the run executes (the background
    // save loop would clobber them).
    const mutate = await fetch(`${DRILL_BASE}/api/runs/${runId}/observation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "mid-run note" })
    });
    expect(mutate.status).toBe(409);

    // The SSE stream replays from the start and runs to run_finished.
    const events = await readSse(
      `${DRILL_BASE}/api/runs/${runId}/events`,
      (collected) => collected.some((event) => event.type === "run_finished")
    );
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("run_started");
    expect(types).toContain("check_started");
    expect(types.filter((type) => type === "check_finished")).toHaveLength(2);
    expect(types.at(-1)).toBe("run_finished");
    const checkFinished = events.find((event) => event.type === "check_finished");
    expect(checkFinished).toMatchObject({
      pageId: "checkout",
      kind: "passed",
      total: 2,
      sessionId: SESSION_ID,
      reasoning: "looks right"
    });

    // The finished record carries the session with a stored slice; the
    // absolute transcript path never reaches the wire.
    const finished = (await (await fetch(`${DRILL_BASE}/api/runs/${runId}`)).json()).run;
    expect(finished.endedAt).toBeTruthy();
    expect(finished.sessions).toHaveLength(1);
    expect(finished.sessions[0]).toMatchObject({ id: SESSION_ID, checks: 2, hasTranscript: true });
    expect(finished.sessions[0].transcriptPath).toBeUndefined();
    expect(finished.sessions[0].slice).toMatch(/^session-[A-Za-z0-9-]+\.jsonl$/);
    expect(finished.pages[0].terminal.session).toEqual({ id: SESSION_ID });
    // Wire hygiene: the hydrated view keeps the session id but never the
    // absolute host transcript path.
    expect(JSON.stringify(finished)).toContain(SESSION_ID);
    expect(JSON.stringify(finished)).not.toContain(TRANSCRIPT);

    const projectKey = crypto.createHash("sha256").update(String(target)).digest("hex").slice(0, 12);
    const sliceFile = path.join(ghome, "drill", "evidence", projectKey, runId, finished.sessions[0].slice);
    expect(existsSync(sliceFile)).toBe(true);

    // The session-stream route serves the parsed transcript (from the slice).
    const sessionEvents = await readSse(
      `${DRILL_BASE}/api/runs/${runId}/session-stream?session=${SESSION_ID}`,
      (collected) => collected.some((event) => event.type === "end")
    );
    const init = sessionEvents.find((event) => event.type === "init");
    expect(init.title).toBe("Verify checkout rendering");
    expect(init.live).toBe(false);
    expect(init.events).toHaveLength(4);
    const toolResult = init.events.find((event: any) => event.toolResultsOnly);
    expect(toolResult.blocks[0].images).toHaveLength(1);
    expect(toolResult.blocks[0].images[0].mediaType).toBe("image/jpeg");

    // An unknown session 404s instead of leaking a path probe.
    const bogus = await fetch(`${DRILL_BASE}/api/runs/${runId}/session-stream?session=nope`);
    expect(bogus.status).toBe(404);
  }, 30000);

  it("keeps the default POST synchronous for skill and heartbeat callers", async () => {
    inlineDelayMs = 0;
    const response = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["checkout"], viewports: ["desktop"] })
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.background).toBeUndefined();
    expect(payload.run.endedAt).toBeTruthy();
    expect(payload.run.sessions[0]).toMatchObject({ id: SESSION_ID, checks: 2 });
  }, 30000);
});

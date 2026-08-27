import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";

// Progress, cancel, and retry for the agent-driven Book planning job (the
// dogfood bug: an 11-minute plan and a hang were indistinguishable behind a
// generic "Planning..." message, and there was no way to stop one). Progress
// is derived from the plan session's OWN transcript JSONL (a `--session-id`
// pin, purge-policy-clean - see planner.mjs's planProgress), so the stub
// agent here writes fake transcript events to prove the status route reads
// them, rather than re-testing the sentinel contract already covered by
// drill-plan.test.ts.

const REPO = path.resolve(__dirname, "..");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
// 7292: clear of every other drill test port (7284-7286, 7291, 7293-7294
// taken as of writing - re-grep tests/*.test.ts before reusing a port here).
const DRILL_PORT = 7292;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-plan-progress-home-"));
const devroot = mkdtempSync(path.join(tmpdir(), "garrison-plan-progress-devroot-"));
const proj = path.join(devroot, "proj");
const transcriptDir = path.join(ghome, "transcripts");

let drillSrv: ChildProcess | null = null;

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function getJson(p: string) {
  const r = await fetch(`${DRILL_BASE}${p}`);
  return { status: r.status, body: await r.json() };
}
async function postJson(p: string, body: unknown) {
  const r = await fetch(`${DRILL_BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

function parseSse(text: string): any[] {
  const payloads: any[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try { payloads.push(JSON.parse(data)); } catch { /* ignore keep-alives/malformed frames */ }
  }
  return payloads;
}

async function waitPlanSettled(ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    const { body } = await getJson("/api/plan/status");
    if (body.job && body.job.status !== "planning") return body;
    if (Date.now() > end) throw new Error(`plan did not settle within ${ms}ms: ${JSON.stringify(body.job)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function waitPlanProgress(predicate: (progress: any) => boolean, ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    const response = await getJson("/api/plan/status");
    const progress = response.body.job?.progress;
    if (progress && predicate(progress)) return response;
    if (response.body.job && response.body.job.status !== "planning") {
      throw new Error(`plan settled before expected progress: ${JSON.stringify(response.body.job)}`);
    }
    if (Date.now() > end) throw new Error(`expected plan progress within ${ms}ms: ${JSON.stringify(progress)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// A zombie (SIGKILLed but not yet wait()ed by its adopter) still answers
// kill(pid, 0) - the same allowance drill-plan.test.ts's orphan-reap test
// makes for CPU-loaded full-suite runs.
function reaped(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return true; }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch { return true; }
}

function stubMode(root: string, mode: string) {
  writeFileSync(path.join(root, "plan-stub-mode"), mode);
}

beforeAll(async () => {
  mkdirSync(path.join(proj, ".git"), { recursive: true });
  writeFileSync(path.join(ghome, "dev-root"), devroot);
  mkdirSync(transcriptDir, { recursive: true });

  // The stub planner: mode-switched via a plan-stub-mode file in its cwd,
  // same convention as drill-plan.test.ts's stub.
  //   ok           - writes the book, prints DRILL_PLAN_OK=1, exits (no
  //                  transcript - proves progress degrades to nulls/0, never
  //                  errors, when there is nothing to read).
  //   chatty       - appends a few fake assistant tool_use events to its OWN
  //                  transcript file (named by --session-id) with a real
  //                  delay between each, then writes the book and exits OK.
  //   chatty-hang  - same event stream, on an interval that never stops -
  //                  the cancel target; only a kill (via /api/plan/cancel)
  //                  ends it.
  //   streaming    - creates the transcript only after a stream can attach,
  //                  then emits text, a Read call, its screenshot result,
  //                  and terminal text on separate ticks.
  const stub = path.join(ghome, "plan-stub.mjs");
  writeFileSync(stub, [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";',
    'import path from "node:path";',
    'const argv = process.argv.slice(2);',
    'writeFileSync(path.join(process.cwd(), "plan-argv.json"), JSON.stringify(argv));',
    'const mode = readFileSync(path.join(process.cwd(), "plan-stub-mode"), "utf8").trim();',
    'const sessionIdx = argv.indexOf("--session-id");',
    'const sessionId = sessionIdx >= 0 ? argv[sessionIdx + 1] : null;',
    'const transcriptBase = process.env.DRILL_PLAN_TRANSCRIPT_DIR;',
    "function writeBook() {",
    '  mkdirSync(path.join(process.cwd(), "drills", "pages"), { recursive: true });',
    "  writeFileSync(path.join(process.cwd(), 'drills', 'drillbook.yml'), 'app:\\n  name: stub\\n  url: \\'\\'\\nfullDrill: true\\npages:\\n  - id: home\\n    title: Home\\n    path: /\\n    mode: steps\\n    selected: true\\n');",
    "  writeFileSync(path.join(process.cwd(), 'drills', 'pages', 'home.yml'), 'id: home\\ntitle: Home\\npath: /\\nmode: steps\\nareas: []\\nsteps: []\\nstates: []\\n');",
    "}",
    "function transcriptFile() {",
    "  const dir = path.join(transcriptBase, 'proj');",
    "  mkdirSync(dir, { recursive: true });",
    "  return path.join(dir, `${sessionId}.jsonl`);",
    "}",
    "function emitToolUse(n) {",
    "  const evt = { type: 'assistant', uuid: `tool-${n}`, timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: `write-${n}`, name: 'Write', input: { file_path: `drills/pages/step-${n}.yml` } }] } };",
    "  appendFileSync(transcriptFile(), JSON.stringify(evt) + '\\n');",
    "}",
    "function emitEntry(entry) {",
    "  appendFileSync(transcriptFile(), JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\\n');",
    "}",
    'if (mode === "ok") {',
    "  writeBook();",
    '  console.log("DRILL_PLAN_OK=1");',
    '} else if (mode === "chatty") {',
    "  let n = 0;",
    "  const timer = setInterval(() => {",
    "    n++;",
    "    emitToolUse(n);",
    "    if (n >= 3) {",
    "      clearInterval(timer);",
    "      writeBook();",
    '      console.log("DRILL_PLAN_OK=1");',
    "    }",
    "  }, 300);",
    '} else if (mode === "chatty-hang") {',
    "  let n = 0;",
    "  setInterval(() => { n++; emitToolUse(n); }, 300);",
    '} else if (mode === "streaming") {',
    "  setTimeout(() => emitEntry({ type: 'assistant', uuid: 'intro', message: { content: [{ type: 'text', text: 'Opening the app and mapping its routes.' }] } }), 250);",
    "  setTimeout(() => emitEntry({ type: 'assistant', uuid: 'read-call', message: { content: [{ type: 'tool_use', id: 'read-shot', name: 'Read', input: { file_path: '/tmp/plan-shot.png' } }] } }), 500);",
    "  setTimeout(() => emitEntry({ type: 'user', uuid: 'read-result', message: { content: [{ type: 'tool_result', tool_use_id: 'read-shot', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl8vAAAAABJRU5ErkJggg==' } }] }] } }), 750);",
    "  setTimeout(() => {",
    "    emitEntry({ type: 'assistant', uuid: 'final', message: { content: [{ type: 'text', text: 'The inspected page is covered.' }] } });",
    "    writeBook();",
    '    console.log("DRILL_PLAN_OK=1");',
    "  }, 1000);",
    "}",
    ""
  ].join("\n"));
  chmodSync(stub, 0o755);

  drillSrv = spawnDrillServer();
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);
  expect((await postJson("/api/projects/select", { path: proj })).status).toBe(200);
}, 20000);

function spawnDrillServer() {
  return spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: {
      ...process.env,
      GARRISON_HOME: ghome,
      DRILL_UI_PORT: String(DRILL_PORT),
      DRILL_UI_HOST: "127.0.0.1",
      DRILL_AGENT_CMD: path.join(ghome, "plan-stub.mjs"),
      DRILL_PLAN_TIMEOUT_MS: "15000",
      DRILL_PLAN_TRANSCRIPT_DIR: transcriptDir
    }
  });
}

afterAll(async () => {
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  drillSrv = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(devroot, { recursive: true, force: true });
});

describe("plan progress", () => {
  it("reports growing transcript progress while a chatty agent runs, and stays honest with no transcript at all", async () => {
    stubMode(proj, "chatty");
    const kick = await postJson("/api/plan/start", {});
    expect(kick.status).toBe(200);
    expect(kick.body.job.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof kick.body.job.deadlineAt).toBe("string");
    expect(Date.parse(kick.body.job.deadlineAt)).toBeGreaterThan(Date.now());

    // Wait on the evidence, not a fixed 500ms wall-clock: under the full
    // suite the event loop can be CPU-starved even though the child is fine.
    const first = await waitPlanProgress((progress) => progress.transcriptEvents > 0, 5000);
    expect(first.body.job.status).toBe("planning");
    const p1 = first.body.job.progress;
    expect(p1.transcriptBytes).toBeGreaterThan(0);
    expect(p1.transcriptEvents).toBeGreaterThan(0);
    expect(p1.lastActivity).toContain("Write");
    expect(Date.parse(p1.lastActivityAt)).toBeGreaterThan(0);

    // A later evidence-bearing read sees MORE transcript than the first -
    // proof this is live progress, not a static snapshot from kick time.
    const second = await waitPlanProgress(
      (progress) => progress.transcriptBytes > p1.transcriptBytes && progress.transcriptEvents > p1.transcriptEvents,
      5000
    );
    const p2 = second.body.job.progress;
    expect(p2.transcriptBytes).toBeGreaterThan(p1.transcriptBytes);
    expect(p2.transcriptEvents).toBeGreaterThan(p1.transcriptEvents);

    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("done");
    expect(st.job.progress.pagesAuthored).toBe(1);
  }, 20000);

  it("never fails the status route when there is no transcript to read (progress degrades to nulls/0)", async () => {
    stubMode(proj, "ok");
    expect((await postJson("/api/plan/start", {})).status).toBe(200);
    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("done");
    // The "ok" stub never writes a transcript file at all.
    expect(st.job.progress.transcriptBytes).toBe(0);
    expect(st.job.progress.transcriptEvents).toBe(0);
    expect(st.job.progress.lastActivityAt).toBeNull();
    expect(st.job.progress.lastActivity).toBeNull();
  }, 20000);
});

describe("plan session stream", () => {
  it("streams the planning transcript and the screenshots the agent actually inspected, then replays it", async () => {
    stubMode(proj, "streaming");
    const kick = await postJson("/api/plan/start", {});
    expect(kick.status).toBe(200);
    const sessionId = kick.body.job.sessionId as string;

    // A caller cannot use the route to probe an arbitrary Claude session.
    const wrong = await fetch(`${DRILL_BASE}/api/plan/session-stream?session=not-this-plan`);
    expect(wrong.status).toBe(404);

    // Connect before the stub creates its JSONL. The route must wait for the
    // pinned transcript instead of permanently declaring it unavailable.
    const response = await fetch(`${DRILL_BASE}/api/plan/session-stream?session=${encodeURIComponent(sessionId)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const raw = await response.text();
    const frames = parseSse(raw);
    const init = frames.find((frame) => frame.type === "init");
    expect(init).toMatchObject({ sessionId, live: true, available: true });
    expect(frames.filter((frame) => frame.type === "events").length).toBeGreaterThanOrEqual(2);
    expect(frames.at(-1)).toMatchObject({ type: "end", sessionId, status: "done" });

    const events = frames.flatMap((frame) => frame.events ?? []);
    const blocks = events.flatMap((event) => event.blocks ?? []);
    expect(blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Opening the app and mapping its routes." }),
      expect.objectContaining({ type: "tool_use", toolUseId: "read-shot", name: "Read" })
    ]));
    const screenshotResult = blocks.find((block) => block.type === "tool_result" && block.toolUseId === "read-shot");
    expect(screenshotResult?.images).toEqual([
      expect.objectContaining({ mediaType: "image/png", data: expect.stringMatching(/^iVBOR/) })
    ]);
    expect(raw).not.toContain(transcriptDir);
    expect((await waitPlanSettled(12000)).job.status).toBe("done");

    // The terminal job remains reviewable for the life of this Drill server:
    // reconnect gets one complete init snapshot (including the image), then end.
    const replay = await fetch(`${DRILL_BASE}/api/plan/session-stream?session=${encodeURIComponent(sessionId)}`);
    const replayFrames = parseSse(await replay.text());
    expect(replayFrames[0]).toMatchObject({ type: "init", sessionId, live: false, available: true });
    const replayBlocks = (replayFrames[0].events ?? []).flatMap((event: any) => event.blocks ?? []);
    expect(replayBlocks.find((block: any) => block.type === "tool_result")?.images?.[0]?.data).toMatch(/^iVBOR/);
    expect(replayFrames.at(-1)).toMatchObject({ type: "end", sessionId, status: "done" });
  }, 25000);

  it("renders live plan text, tool calls, and the inspected screenshot, and keeps them after completion", async () => {
    stubMode(proj, "streaming");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
    try {
      await page.goto(DRILL_BASE);
      await page.getByRole("button", { name: "Plan book" }).click();
      await page.getByRole("button", { name: "Plan the whole app" }).click();

      const panel = page.locator("details.dr-plan-session");
      await panel.waitFor({ state: "visible", timeout: 10_000 });
      await page.getByText("Opening the app and mapping its routes.").waitFor({ state: "visible", timeout: 10_000 });
      await panel.locator(".dr-session-tool summary").filter({ hasText: "Read" }).waitFor({ state: "visible", timeout: 10_000 });
      const image = panel.locator("img.dr-session-img").first();
      await image.waitFor({ state: "visible", timeout: 10_000 });
      expect(await image.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

      await expect.poll(
        () => panel.locator(":scope > summary .chip").textContent(),
        { timeout: 12_000 }
      ).toBe("done");
      expect(await panel.getAttribute("open")).not.toBeNull();
      expect(await page.getByText(/timed out waiting for planning/i).count()).toBe(0);
      expect(await image.isVisible()).toBe(true);
    } finally {
      await page.close();
      await browser.close();
    }
  }, 30000);
});

describe("plan cancel", () => {
  it("cancels a running plan with an honest terminal status, kills the agent, and serves the log", async () => {
    stubMode(proj, "chatty-hang");
    const kick = await postJson("/api/plan/start", {});
    expect(kick.status).toBe(200);
    const agentPid = kick.body.job.agentPid;
    expect(agentPid).toBeGreaterThan(0);

    // Let it accumulate some real progress before stopping it.
    await new Promise((r) => setTimeout(r, 500));

    const cancel = await postJson("/api/plan/cancel", {});
    expect(cancel.status).toBe(200);
    expect(cancel.body.canceled).toBe(true);
    expect(cancel.body.job.status).toBe("canceled");
    expect(cancel.body.job.error).toBeNull();
    expect(typeof cancel.body.job.canceledAt).toBe("string");

    // The status route reflects the same terminal state, not "failed".
    const st = await getJson("/api/plan/status");
    expect(st.body.job.status).toBe("canceled");

    // The agent process is actually dead, not just marked so.
    const end = Date.now() + 10000;
    let alive = true;
    while (alive && Date.now() < end) {
      if (reaped(agentPid)) alive = false;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(alive).toBe(false);

    // The pid record is cleared (mirrors drill-plan.test.ts's orphan-reap
    // expectations - a canceled job must not look like an orphan later).
    const jobRecordDir = path.join(ghome, "drill", "plan", "jobs");
    if (existsSync(jobRecordDir)) {
      const fs = await import("node:fs/promises");
      const files = await fs.readdir(jobRecordDir);
      expect(files.length).toBe(0);
    }

    // The log the UI's error strings point at is actually servable now.
    const log = await fetch(`${DRILL_BASE}/api/plan/log`);
    expect(log.status).toBe(200);
    expect(await log.text()).toContain("[drill plan]");
  }, 20000);

  it("rejects a cancel with no plan running, and never rewrites an already-finished job", async () => {
    const noJob = await postJson("/api/plan/cancel", {});
    expect(noJob.status).toBe(409);
    expect(noJob.body.canceled).toBe(false);

    stubMode(proj, "ok");
    expect((await postJson("/api/plan/start", {})).status).toBe(200);
    await waitPlanSettled(12000);

    const afterDone = await postJson("/api/plan/cancel", {});
    expect(afterDone.status).toBe(409);
    expect(afterDone.body.canceled).toBe(false);
    const st = await getJson("/api/plan/status");
    expect(st.body.job.status).toBe("done");
  }, 20000);
});

describe("retry after cancel", () => {
  it("lets a canceled plan be re-kicked and a run proceed immediately (the guards key off 'planning' only)", async () => {
    stubMode(proj, "chatty-hang");
    const kick = await postJson("/api/plan/start", {});
    expect(kick.status).toBe(200);
    const agentPid = kick.body.job.agentPid;

    const cancel = await postJson("/api/plan/cancel", {});
    expect(cancel.body.canceled).toBe(true);

    const end = Date.now() + 10000;
    while (!reaped(agentPid) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));

    // Retry: a canceled job does not block a fresh /api/plan/start.
    stubMode(proj, "ok");
    const retry = await postJson("/api/plan/start", {});
    expect(retry.status).toBe(200);
    expect(retry.body.started).toBe(true);
    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("done");
    expect(st.pages).toBeGreaterThan(0);

    // And /api/runs is not 409-blocked by the now-canceled job either.
    await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomy: "auto" })
    });
    const run = await postJson("/api/runs", { pageIds: ["home"] });
    expect(run.status, JSON.stringify(run.body)).not.toBe(409);
  }, 25000);
});

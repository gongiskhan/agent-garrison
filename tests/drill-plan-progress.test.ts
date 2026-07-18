import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

async function waitPlanSettled(ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    const { body } = await getJson("/api/plan/status");
    if (body.job && body.job.status !== "planning") return body;
    if (Date.now() > end) throw new Error(`plan did not settle within ${ms}ms: ${JSON.stringify(body.job)}`);
    await new Promise((r) => setTimeout(r, 400));
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
    "  const evt = { message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `drills/pages/step-${n}.yml` } }] } };",
    "  appendFileSync(transcriptFile(), JSON.stringify(evt) + '\\n');",
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

    // First read: should already see at least one transcript event once the
    // stub's first 300ms tick fires.
    await new Promise((r) => setTimeout(r, 500));
    const first = await getJson("/api/plan/status");
    expect(first.body.job.status).toBe("planning");
    const p1 = first.body.job.progress;
    expect(p1.transcriptBytes).toBeGreaterThan(0);
    expect(p1.transcriptEvents).toBeGreaterThan(0);
    expect(p1.lastActivity).toContain("Write");
    expect(Date.parse(p1.lastActivityAt)).toBeGreaterThan(0);

    // A second read after another tick sees MORE transcript than the first -
    // proof this is live progress, not a static snapshot from kick time.
    await new Promise((r) => setTimeout(r, 700));
    const second = await getJson("/api/plan/status");
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

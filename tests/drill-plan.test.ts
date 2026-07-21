import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Agent-driven Book planning on the direct-run path: an empty Book never
// asks the user to author pages - POST /api/plan/start spawns a headless
// agent session in the project root (here a stub binary via DRILL_AGENT_CMD,
// same stand-in pattern as drill-projects.test.ts) that authors
// drills/drillbook.yml + drills/pages/*.yml and reports through the
// DRILL_PLAN_OK/DRILL_PLAN_FAILED final-line sentinel. The OK sentinel is
// never trusted blind: the server verifies page files exist on disk.

const REPO = path.resolve(__dirname, "..");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
// 7291: clear of every other drill test port (7284-7286 projects, 7266+
// selftest trapPort range) - a shared port across files makes waitHealthy
// pass against the OTHER file's server and die mid-test.
const DRILL_PORT = 7291;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-plan-home-"));
const devroot = mkdtempSync(path.join(tmpdir(), "garrison-plan-devroot-"));
const projOk = path.join(devroot, "proj-ok");
const projEmpty = path.join(devroot, "proj-empty");

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

// Poll /api/plan/status until the job leaves "planning" (or the deadline).
async function waitPlanSettled(ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    const { body } = await getJson("/api/plan/status");
    if (body.job && body.job.status !== "planning") return body;
    if (Date.now() > end) throw new Error(`plan did not settle within ${ms}ms: ${JSON.stringify(body.job)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

function stubMode(root: string, mode: string) {
  writeFileSync(path.join(root, "plan-stub-mode"), mode);
}
function stubPrompt(root: string): string {
  const argv = JSON.parse(readFileSync(path.join(root, "plan-argv.json"), "utf8"));
  expect(argv[0]).toBe("-p");
  return argv[1];
}

beforeAll(async () => {
  // Two git repos under the dev-root: proj-ok carries a run skill (the
  // prompt must reference it), proj-empty carries nothing and stays empty
  // through the failure-path tests.
  for (const p of [projOk, projEmpty]) mkdirSync(path.join(p, ".git"), { recursive: true });
  mkdirSync(path.join(projOk, ".claude", "skills", "run-proj-ok"), { recursive: true });
  writeFileSync(path.join(projOk, ".claude", "skills", "run-proj-ok", "SKILL.md"), "---\nname: run-proj-ok\ndescription: start proj-ok\n---\nnpm start\n");
  writeFileSync(path.join(ghome, "dev-root"), devroot);

  // The stub planner: behavior switched per kick through a plan-stub-mode
  // file in its cwd (the project root). "ok" honors the whole contract,
  // "fail" reports a failure, "lie" claims success without writing anything,
  // "silent" exits without any sentinel, "noop" claims OK=0 (already
  // covered, changed nothing), "fail-then-ok" recovers after an early
  // failure line (last sentinel wins), "hang" stays alive without ever
  // reporting (join/mutex/signal-death tests).
  const stub = path.join(ghome, "plan-stub.mjs");
  writeFileSync(stub, [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync, mkdirSync } from "node:fs";',
    'import path from "node:path";',
    'const mode = readFileSync(path.join(process.cwd(), "plan-stub-mode"), "utf8").trim();',
    'writeFileSync(path.join(process.cwd(), "plan-argv.json"), JSON.stringify(process.argv.slice(2)));',
    "function writeBook() {",
    '  mkdirSync(path.join(process.cwd(), "drills", "pages"), { recursive: true });',
    "  writeFileSync(path.join(process.cwd(), 'drills', 'drillbook.yml'), 'app:\\n  name: stub\\n  url: \\'\\'\\nfullDrill: true\\npages:\\n  - id: home\\n    title: Home\\n    path: /\\n    mode: steps\\n    selected: true\\n');",
    "  writeFileSync(path.join(process.cwd(), 'drills', 'pages', 'home.yml'), 'id: home\\ntitle: Home\\npath: /\\nmode: steps\\nareas: []\\nsteps:\\n  - id: hero\\n    area: 0\\n    mode: vision\\n    enabled: true\\n    viewports:\\n      - desktop\\n    state: default\\n    description: hero renders\\n    tags: []\\nstates: []\\n');",
    "}",
    'if (mode === "ok") {',
    "  writeBook();",
    '  console.log("DRILL_PLAN_OK=1");',
    '} else if (mode === "fail") {',
    '  console.log("DRILL_PLAN_FAILED=cannot map the app");',
    '} else if (mode === "lie") {',
    '  console.log("DRILL_PLAN_OK=3");',
    '} else if (mode === "noop") {',
    '  console.log("DRILL_PLAN_OK=0");',
    '} else if (mode === "fail-then-ok") {',
    '  console.log("DRILL_PLAN_FAILED=transient tool error");',
    "  writeBook();",
    '  console.log("DRILL_PLAN_OK=1");',
    '} else if (mode === "hang") {',
    "  setTimeout(() => process.exit(0), 60000);",
    "}",
    ""
  ].join("\n"));
  chmodSync(stub, 0o755);

  drillSrv = spawnDrillServer();
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);
}, 20000);

function spawnDrillServer() {
  return spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: {
      ...process.env,
      GARRISON_HOME: ghome,
      // Deliberately NO GARRISON_DRILL_TARGET_REPO: planning before any
      // selection must 400, same as app start.
      DRILL_UI_PORT: String(DRILL_PORT),
      DRILL_UI_HOST: "127.0.0.1",
      DRILL_AGENT_CMD: path.join(ghome, "plan-stub.mjs"),
      DRILL_PLAN_TIMEOUT_MS: "15000"
    }
  });
}

afterAll(async () => {
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  drillSrv = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(devroot, { recursive: true, force: true });
});

describe("plan requires a selected project", () => {
  it("refuses to plan before any project is selected", async () => {
    const { status, body } = await postJson("/api/plan/start", {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/no project selected/);
    const st = await getJson("/api/plan/status");
    expect(st.body.selected).toBe(false);
    expect(st.body.job).toBeNull();
  });
});

describe("failure paths stay honest", () => {
  it("surfaces the agent's DRILL_PLAN_FAILED reason", async () => {
    expect((await postJson("/api/projects/select", { path: projEmpty })).status).toBe(200);
    stubMode(projEmpty, "fail");
    expect((await postJson("/api/plan/start", {})).status).toBe(200);
    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("failed");
    expect(st.job.error).toBe("cannot map the app");
    expect(st.pages).toBe(0);
  }, 20000);

  it("rejects a DRILL_PLAN_OK sentinel with no page files on disk", async () => {
    stubMode(projEmpty, "lie");
    expect((await postJson("/api/plan/start", {})).status).toBe(200);
    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("failed");
    expect(st.job.error).toMatch(/no readable page files/);
  }, 20000);

  it("fails a session that exits without any sentinel instead of spinning", async () => {
    stubMode(projEmpty, "silent");
    expect((await postJson("/api/plan/start", {})).status).toBe(200);
    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("failed");
    expect(st.job.error).toMatch(/without printing/);
  }, 20000);
});

describe("full plan + scoped update", () => {
  it("authors the Book through the agent session and verifies pages on disk", async () => {
    expect((await postJson("/api/projects/select", { path: projOk })).status).toBe(200);
    stubMode(projOk, "ok");
    const kick = await postJson("/api/plan/start", {});
    expect(kick.status).toBe(200);
    expect(kick.body.job.mode).toBe("full");

    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("done");
    expect(st.job.pages).toBe(1);
    expect(st.pages).toBe(1);

    // What the agent wrote is live through the normal store: page listed,
    // book ledger carries it.
    const pages = await getJson("/api/pages");
    expect(pages.body.pages.map((p: any) => p.id)).toEqual(["home"]);
    const book = await getJson("/api/drillbook");
    expect(book.body.book.pages[0].id).toBe("home");

    // The prompt honors the full-plan mode, teaches the exact file format +
    // sentinel contract, and names the project's run skill for live probing.
    const prompt = stubPrompt(projOk);
    expect(prompt).toContain("Mode: FULL PLAN");
    expect(prompt).toContain("drills/drillbook.yml");
    expect(prompt).toContain("DRILL_PLAN_OK=");
    expect(prompt).toContain("run-proj-ok");
  }, 20000);

  it("threads a change brief into an UPDATE-mode prompt", async () => {
    stubMode(projOk, "ok");
    const kick = await postJson("/api/plan/start", { brief: "the new invoices page: list, filters, CSV export" });
    expect(kick.status).toBe(200);
    expect(kick.body.job.mode).toBe("update");
    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("done");

    const prompt = stubPrompt(projOk);
    expect(prompt).toContain("Mode: UPDATE");
    expect(prompt).toContain("the new invoices page: list, filters, CSV export");
    expect(prompt).not.toContain("Mode: FULL PLAN");
  }, 20000);

  it("rejects an OK claim that changed nothing on a Book that already has pages", async () => {
    // The UPDATE-mode no-op hole: pre-existing pages must not vouch for an
    // agent that wrote nothing - OK=n needs a real change under drills/.
    stubMode(projOk, "lie");
    expect((await postJson("/api/plan/start", { brief: "cover the export flow" })).status).toBe(200);
    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("failed");
    expect(st.job.error).toMatch(/nothing under drills\/ changed/);
  }, 20000);

  it("accepts an explicit OK=0 'already covered' claim without requiring a change", async () => {
    stubMode(projOk, "noop");
    expect((await postJson("/api/plan/start", {})).status).toBe(200);
    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("done");
    expect(st.job.noop).toBe(true);
    expect(st.job.pages).toBe(1);
  }, 20000);

  it("lets a late DRILL_PLAN_OK override an earlier FAILED line (last sentinel wins)", async () => {
    stubMode(projOk, "fail-then-ok");
    expect((await postJson("/api/plan/start", {})).status).toBe(200);
    const st = await waitPlanSettled(12000);
    expect(st.job.status).toBe("done");
  }, 20000);
});

describe("join semantics, plan-run mutex, signal death", () => {
  it("joins an in-flight plan (started:false), 409s a brief, blocks runs, and fails fast on a signal-killed agent", async () => {
    stubMode(projOk, "hang");
    const kick = await postJson("/api/plan/start", {});
    expect(kick.status).toBe(200);
    expect(kick.body.started).toBe(true);
    const agentPid = kick.body.job.agentPid;
    expect(agentPid).toBeGreaterThan(0);

    // A second kick without a brief JOINS - same job, no second agent.
    const rekick = await postJson("/api/plan/start", {});
    expect(rekick.status).toBe(200);
    expect(rekick.body.started).toBe(false);
    expect(rekick.body.job.agentPid).toBe(agentPid);

    // A brief must never be silently swallowed by a join.
    const briefKick = await postJson("/api/plan/start", { brief: "new page" });
    expect(briefKick.status).toBe(409);
    expect(briefKick.body.error).toMatch(/already running/);

    // Runs are blocked while an agent may be mid-rewrite of drills/.
    const run = await postJson("/api/runs", { pageIds: ["home"] });
    expect(run.status).toBe(409);
    expect(run.body.error).toMatch(/plan is authoring/);

    // A signal-killed agent must fail fast (not sit "planning" until the
    // deadline blocking every re-kick).
    process.kill(agentPid, "SIGKILL");
    const st = await waitPlanSettled(10000);
    expect(st.job.status).toBe("failed");
    expect(st.job.error).toMatch(/signal:SIGKILL/);
  }, 30000);
});

describe("orphan reap across a server restart", () => {
  it("kills the previous server's plan agent at boot instead of letting a retry double-spawn", async () => {
    expect((await postJson("/api/projects/select", { path: projEmpty })).status).toBe(200);
    stubMode(projEmpty, "hang");
    const kick = await postJson("/api/plan/start", {});
    expect(kick.status).toBe(200);
    const agentPid = kick.body.job.agentPid;

    // Kill the drill server; the agent survives (it reparents).
    drillSrv!.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(agentPid, 0)).not.toThrow();

    // A new server process reaps it at boot from the on-disk pid record.
    drillSrv = spawnDrillServer();
    expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);
    // kill(pid, 0) still succeeds on a SIGKILLed process lingering as a
    // zombie (its adopter hasn't wait()ed yet, common under full-suite CPU
    // load), so a Z state in /proc counts as reaped too.
    const reaped = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
      } catch {
        return true;
      }
    };
    const end = Date.now() + 15000;
    let alive = true;
    while (alive && Date.now() < end) {
      if (reaped(agentPid)) alive = false;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(alive).toBe(false);

    // And the new server's memory has no job for this root.
    const st = await getJson("/api/plan/status");
    expect(st.body.job).toBeNull();
  }, 45000);
});

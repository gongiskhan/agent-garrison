import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Project selection + direct runs: Drill discovers the dev-root projects
// (same contract as the dev-env/Kanban pickers), retargets live on select,
// and boots a down app THROUGH THE PROJECT'S RUN SKILL - here a stub agent
// binary (DRILL_AGENT_CMD) standing in for the headless Claude session; the
// stub starts a real HTTP listener and prints the APP_URL sentinel, which is
// exactly the contract the real agent is prompted to honor.

const REPO = path.resolve(__dirname, "..");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
// 7280s: clear of every other drill test AND drill-selftest's incrementing
// trapPort range (7266+) - a shared port across files makes waitHealthy pass
// against the OTHER file's server and die mid-test when that file finishes.
const DRILL_PORT = 7284;
const STUB_APP_PORT = 7285;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-projects-home-"));
const devroot = mkdtempSync(path.join(tmpdir(), "garrison-projects-devroot-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-projects-target-"));
const projA = path.join(devroot, "proj-a");
const projB = path.join(devroot, "proj-b");

let drillSrv: ChildProcess | null = null;
let stubAgentPid: number | null = null;

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

beforeAll(async () => {
  // Two git repos under the dev-root: proj-a carries a run skill + drill
  // book, proj-b carries neither. A third non-repo dir must never list.
  for (const p of [projA, projB]) mkdirSync(path.join(p, ".git"), { recursive: true });
  mkdirSync(path.join(devroot, "not-a-repo"), { recursive: true });
  mkdirSync(path.join(projA, ".claude", "skills", "run-proj-a"), { recursive: true });
  writeFileSync(path.join(projA, ".claude", "skills", "run-proj-a", "SKILL.md"), "---\nname: run-proj-a\ndescription: start proj-a\n---\nnpm start\n");
  mkdirSync(path.join(projA, "drills"), { recursive: true });
  writeFileSync(path.join(projA, "drills", "drillbook.yml"), "app:\n  name: proj-a\n  url: ''\n");
  writeFileSync(path.join(ghome, "dev-root"), devroot);

  // The stub agent: reads stub-port from its cwd (the project root), starts a
  // real HTTP listener, dumps its argv for prompt assertions, prints the
  // APP_URL sentinel, and keeps serving until killed.
  const stubAgent = path.join(ghome, "stub-agent.mjs");
  writeFileSync(stubAgent, [
    "#!/usr/bin/env node",
    'import http from "node:http";',
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'const port = Number(readFileSync(path.join(process.cwd(), "stub-port"), "utf8").trim());',
    'writeFileSync(path.join(process.cwd(), "agent-argv.json"), JSON.stringify(process.argv.slice(2)));',
    'const srv = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });',
    'srv.listen(port, "127.0.0.1", () => { console.log(`APP_URL=http://127.0.0.1:${port}`); });',
    ""
  ].join("\n"));
  chmodSync(stubAgent, 0o755);
  writeFileSync(path.join(projA, "stub-port"), String(STUB_APP_PORT));

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: {
      ...process.env,
      GARRISON_HOME: ghome,
      GARRISON_DRILL_TARGET_REPO: target,
      DRILL_UI_PORT: String(DRILL_PORT),
      DRILL_UI_HOST: "127.0.0.1",
      DRILL_AGENT_CMD: stubAgent,
      DRILL_APP_START_TIMEOUT_MS: "20000"
    }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);
}, 20000);

afterAll(async () => {
  if (stubAgentPid) { try { process.kill(stubAgentPid, "SIGKILL"); } catch { /* gone */ } }
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  drillSrv = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(devroot, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("project discovery + selection", () => {
  it("lists dev-root git repos with run-skill/drillbook annotations, plus the active env target", async () => {
    const { status, body } = await getJson("/api/projects");
    expect(status).toBe(200);
    const names = body.projects.map((p: any) => p.name);
    expect(names).toContain("proj-a");
    expect(names).toContain("proj-b");
    expect(names).not.toContain("not-a-repo");

    const a = body.projects.find((p: any) => p.name === "proj-a");
    expect(a.runSkill).toBe("run-proj-a");
    expect(a.hasDrillBook).toBe(true);
    const b = body.projects.find((p: any) => p.name === "proj-b");
    expect(b.runSkill).toBeNull();
    expect(b.hasDrillBook).toBe(false);

    // The env-pinned target is not under the dev-root, but it IS the active
    // target - it must appear, flagged active, and count as a selection.
    const active = body.projects.find((p: any) => p.active);
    expect(active.path).toBe(target);
    expect(body.active.root).toBe(target);
    expect(body.selected).toBe(true);
    expect(body.devRoot).toBe(devroot);
  });

  it("rejects a non-directory selection", async () => {
    const { status } = await postJson("/api/projects/select", { path: path.join(devroot, "nope") });
    expect(status).toBe(400);
  });

  it("retargets the store live on select: health, book, and page writes follow", async () => {
    const sel = await postJson("/api/projects/select", { path: projA });
    expect(sel.status).toBe(200);
    expect(sel.body.project.path).toBe(projA);
    expect(sel.body.project.runSkill).toBe("run-proj-a");

    const health = await getJson("/health");
    expect(health.body.targetRepo).toBe(projA);

    await fetch(`${DRILL_BASE}/api/pages/pa`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "PA", path: "/" })
    });
    expect(existsSync(path.join(projA, "drills", "pages", "pa.yml"))).toBe(true);

    const { body } = await getJson("/api/projects");
    expect(body.projects.find((p: any) => p.active).path).toBe(projA);
  });
});

describe("unselected state (no env pin, no picker selection)", () => {
  it("reports selected:false with a null active project and refuses app start with a clear error", async () => {
    const home2 = mkdtempSync(path.join(tmpdir(), "garrison-projects-nosel-"));
    const port2 = 7286;
    const env: NodeJS.ProcessEnv = {
      ...process.env, GARRISON_HOME: home2, DRILL_UI_PORT: String(port2), DRILL_UI_HOST: "127.0.0.1"
    };
    delete env.GARRISON_DRILL_TARGET_REPO;
    const srv2 = spawn("node", [DRILL_START], { stdio: "ignore", env });
    try {
      expect(await waitHealthy(`http://127.0.0.1:${port2}`, 8000)).toBe(true);
      const pr = await (await fetch(`http://127.0.0.1:${port2}/api/projects`)).json();
      expect(pr.selected).toBe(false);
      expect(pr.active).toBeNull();
      expect(typeof pr.devRoot).toBe("string");
      expect(pr.projects.some((p: any) => p.active)).toBe(false);

      const st = await (await fetch(`http://127.0.0.1:${port2}/api/app/status`)).json();
      expect(st.selected).toBe(false);

      const kick = await fetch(`http://127.0.0.1:${port2}/api/app/start`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}"
      });
      expect(kick.status).toBe(400);
      expect((await kick.json()).error).toMatch(/no project selected/);
    } finally {
      srv2.kill("SIGKILL");
      rmSync(home2, { recursive: true, force: true });
    }
  }, 15000);
});

describe("app start via the project run skill", () => {
  it("reports down, starts through the run skill, adopts the APP_URL sentinel into the book", async () => {
    const before = await getJson("/api/app/status");
    expect(before.body.configured).toBe(false);
    expect(before.body.reachable).toBe(false);
    expect(before.body.runSkill).toBe("run-proj-a");

    const kick = await postJson("/api/app/start", {});
    // Captured BEFORE any assertion: if an expect below throws, afterAll must
    // still be able to kill the already-spawned stub (it holds port 7285 and
    // would poison every later run of this file).
    stubAgentPid = kick.body?.job?.agentPid ?? null;
    expect(kick.status, JSON.stringify(kick.body)).toBe(200);
    expect(kick.body.started).toBe(true);
    expect(kick.body.job.skill).toBe("run-proj-a");

    let st: any = null;
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      st = (await getJson("/api/app/status")).body;
      if (st.reachable || st.job?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(st.job?.status, JSON.stringify(st?.job)).toBe("ready");
    expect(st.reachable).toBe(true);

    // The sentinel URL landed in the Book (it had no configured URL).
    const book = (await getJson("/api/drillbook")).body.book;
    expect(book.app.url).toBe(`http://127.0.0.1:${STUB_APP_PORT}`);

    // The agent was invoked headless with a prompt naming the run skill.
    const argv = JSON.parse(readFileSync(path.join(projA, "agent-argv.json"), "utf8"));
    expect(argv[0]).toBe("-p");
    expect(argv[1]).toContain('"run-proj-a"');
    expect(argv[1]).toContain("APP_URL=");
    expect(argv).toContain("--permission-mode");

    // Re-kicking while up is a no-op.
    const again = await postJson("/api/app/start", {});
    expect(again.body.started).toBe(false);
    expect(again.body.reachable).toBe(true);
  }, 25000);

  it("fails clearly when the project has no run skill", async () => {
    await postJson("/api/projects/select", { path: projB });
    const kick = await postJson("/api/app/start", {});
    expect(kick.status).toBe(502);
    expect(kick.body.error).toMatch(/no run-\* skill/);
  });
});

describe("snapshot store is project-scoped", () => {
  it("namespaces snapshots by target root - same-named pages across projects never see each other's", async () => {
    const prevHome = process.env.GARRISON_HOME;
    const prevTarget = process.env.GARRISON_DRILL_TARGET_REPO;
    const home = mkdtempSync(path.join(tmpdir(), "garrison-snapns-home-"));
    const rootA = mkdtempSync(path.join(tmpdir(), "garrison-snapns-a-"));
    const rootB = mkdtempSync(path.join(tmpdir(), "garrison-snapns-b-"));
    try {
      process.env.GARRISON_HOME = home;
      process.env.GARRISON_DRILL_TARGET_REPO = rootA;
      const { saveSnapshot, listSnapshots } = await import("../fittings/seed/drill/lib/snapshots.mjs");
      const snap = await saveSnapshot("home", { url: "http://a", title: "A", headingText: "h", shapeSketch: "s", viewport: { width: 1, height: 1 } });
      expect((await listSnapshots("home")).map((s: any) => s.id)).toContain(snap.id);
      expect(snap.project).toBe(rootA);

      process.env.GARRISON_DRILL_TARGET_REPO = rootB;
      expect(await listSnapshots("home")).toEqual([]);
    } finally {
      process.env.GARRISON_HOME = prevHome;
      process.env.GARRISON_DRILL_TARGET_REPO = prevTarget;
      rmSync(home, { recursive: true, force: true });
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe("run records are project-scoped", () => {
  it("stamps runs with the target root and filters /api/runs to the active project", async () => {
    await postJson("/api/projects/select", { path: projA });
    // Autonomy must be auto for a direct run (no gate hold), and the page has
    // no steps, so the run completes without the automations engine.
    await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomy: "auto" })
    });
    const run = await postJson("/api/runs", { pageIds: ["pa"] });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.run.project).toBe(projA);

    const scopedA = await getJson("/api/runs");
    expect(scopedA.body.runs.some((r: any) => r.id === run.body.run.id)).toBe(true);

    await postJson("/api/projects/select", { path: projB });
    const scopedB = await getJson("/api/runs");
    expect(scopedB.body.runs.some((r: any) => r.id === run.body.run.id)).toBe(false);
    const all = await getJson("/api/runs?all=1");
    expect(all.body.runs.some((r: any) => r.id === run.body.run.id)).toBe(true);
  });
});

describe("mutating writes are pinned to an explicit project identity (race protection)", () => {
  // Dogfood bug: a UI session loaded proj-a, but before its next write landed
  // a SECOND session (another tab, or a concurrent agent) switched the one
  // shared active-project.json to proj-b. The first session's write had no
  // root of its own, silently re-resolved through the now-mutated global, and
  // landed in proj-b. These tests drive the exact race and prove the fix:
  // a client that pins the root it observed keeps writing there regardless of
  // what any other session selects afterward, and a write with nothing
  // pinned - and nothing selected - is rejected instead of guessing.

  it("keeps writing to the pinned project even after another session switches the live selection", async () => {
    await postJson("/api/projects/select", { path: projA });
    const loaded = await getJson("/api/drillbook");
    expect(loaded.status).toBe(200);
    const pinnedRoot = loaded.body.root;
    expect(pinnedRoot).toBe(projA);

    // A concurrent session (another tab) now retargets the shared selection.
    const otherSession = await postJson("/api/projects/select", { path: projB });
    expect(otherSession.status).toBe(200);
    expect((await getJson("/api/projects")).body.active.root).toBe(projB);

    // The first session's write pins to the root it loaded, ignoring the
    // selection switch that happened underneath it.
    const patched = await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalRules: "race-pinned-write", root: pinnedRoot })
    });
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.root).toBe(projA);
    expect(patchedBody.book.globalRules).toBe("race-pinned-write");

    // A pinned page write during the same window lands in proj-a too.
    const pagePut = await fetch(`${DRILL_BASE}/api/pages/race-iso`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "race", path: "/race", root: pinnedRoot })
    });
    expect(pagePut.status).toBe(200);

    // Two projects remain isolated: the write landed on disk under proj-a,
    // never under proj-b (which is the live selection throughout this test).
    expect(existsSync(path.join(projA, "drills", "pages", "race-iso.yml"))).toBe(true);
    expect(existsSync(path.join(projB, "drills", "pages", "race-iso.yml"))).toBe(false);
    const bookA = readFileSync(path.join(projA, "drills", "drillbook.yml"), "utf8");
    expect(bookA).toContain("race-pinned-write");
    if (existsSync(path.join(projB, "drills", "drillbook.yml"))) {
      expect(readFileSync(path.join(projB, "drills", "drillbook.yml"), "utf8")).not.toContain("race-pinned-write");
    }

    // Reading each project explicitly by root confirms the pages stay
    // disjoint - proj-b never sees proj-a's page and vice versa.
    const pagesA = await getJson(`/api/pages?root=${encodeURIComponent(projA)}`);
    const pagesB = await getJson(`/api/pages?root=${encodeURIComponent(projB)}`);
    expect(pagesA.body.pages.some((p: any) => p.id === "race-iso")).toBe(true);
    expect(pagesB.body.pages.some((p: any) => p.id === "race-iso")).toBe(false);
  });

  it("rejects a stale pin instead of silently widening to whatever else is live", async () => {
    const removed = mkdtempSync(path.join(tmpdir(), "garrison-projects-removed-"));
    rmSync(removed, { recursive: true, force: true }); // exists on disk a moment ago, not anymore
    const res = await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalRules: "should not land anywhere", root: removed })
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/stale project selection/);
  });

  it("rejects a mutating write with no explicit root when nothing is selected", async () => {
    const home3 = mkdtempSync(path.join(tmpdir(), "garrison-projects-nosel2-"));
    const port3 = 7287;
    const env: NodeJS.ProcessEnv = {
      ...process.env, GARRISON_HOME: home3, DRILL_UI_PORT: String(port3), DRILL_UI_HOST: "127.0.0.1"
    };
    delete env.GARRISON_DRILL_TARGET_REPO;
    const srv3 = spawn("node", [DRILL_START], { stdio: "ignore", env });
    try {
      expect(await waitHealthy(`http://127.0.0.1:${port3}`, 8000)).toBe(true);
      const patch = await fetch(`http://127.0.0.1:${port3}/api/drillbook`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ globalRules: "x" })
      });
      expect(patch.status).toBe(400);
      expect((await patch.json()).error).toMatch(/no project selected/);

      const put = await fetch(`http://127.0.0.1:${port3}/api/pages/nope`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" })
      });
      expect(put.status).toBe(400);
      expect((await put.json()).error).toMatch(/no project selected/);
    } finally {
      srv3.kill("SIGKILL");
      rmSync(home3, { recursive: true, force: true });
    }
  }, 15000);
});

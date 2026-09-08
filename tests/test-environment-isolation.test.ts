import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

it("isolates an inherited node home before lifecycle code can stop its fittings", async () => {
  const inheritedHome = mkdtempSync(path.join(tmpdir(), "garrison-inherited-home-fixture-"));
  fixtures.push(inheritedHome);
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(sleeper);
  await new Promise<void>((resolve, reject) => {
    sleeper.once("spawn", resolve);
    sleeper.once("error", reject);
  });
  const fittingId = "test-home-isolation-fixture";
  const recordPath = path.join(inheritedHome, "ui-fittings", `${fittingId}.json`);
  mkdirSync(path.dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify({ fittingId, pid: sleeper.pid }));

  // Only this test's disposable child is recorded in the synthetic inherited
  // home. Even the pre-fix case can therefore stop no real node process.
  const script = `
    import { existsSync, rmSync } from "node:fs";
    const inheritedHome = process.env.GARRISON_HOME;
    await import(${JSON.stringify(pathToFileURL(path.resolve("tests/setup.ts")).href)});
    const isolatedHome = process.env.GARRISON_HOME;
    const module = await import(${JSON.stringify(pathToFileURL(path.resolve("src/lib/own-port-lifecycle.ts")).href)});
    const stop = module.stopOwnPortFitting ?? module.default.stopOwnPortFitting;
    try {
      const inheritedStop = await stop(${JSON.stringify(fittingId)});
      let inheritedProcessAlive = true;
      try { process.kill(${sleeper.pid}, 0); } catch { inheritedProcessAlive = false; }
      const inheritedRecordPreserved = existsSync(${JSON.stringify(recordPath)});
      const authorityCleared = !process.env.GARRISON_STATE_URL &&
        !process.env.GARRISON_STATE_TOKEN && !process.env.GARRISON_APP_URL;
      // Individual tests may still explicitly select their own fixture home
      // AFTER setup, as the lifecycle suites already do.
      process.env.GARRISON_HOME = inheritedHome;
      const fixtureStop = await stop(${JSON.stringify(fittingId)});
      console.log(JSON.stringify({ isolatedHome, inheritedStop, inheritedProcessAlive,
        inheritedRecordPreserved, authorityCleared, fixtureStop }));
    } finally {
      if (isolatedHome !== inheritedHome) rmSync(isolatedHome, { recursive: true, force: true });
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GARRISON_HOME: inheritedHome,
      GARRISON_STATE_URL: "http://127.0.0.1:1",
      GARRISON_STATE_TOKEN: "fixture-token",
      GARRISON_APP_URL: "http://127.0.0.1:1"
    },
    timeout: 15_000
  });
  const result = JSON.parse(stdout.trim());
  expect(result.inheritedProcessAlive, "setup must protect the inherited home's live fitting").toBe(true);
  expect(result.isolatedHome).not.toBe(inheritedHome);
  expect(result.inheritedStop).toMatchObject({ ok: true, wasRunning: false });
  expect(result.inheritedRecordPreserved).toBe(true);
  expect(result.authorityCleared).toBe(true);
  expect(result.fixtureStop).toMatchObject({ ok: true, wasRunning: true, pid: sleeper.pid });
}, 20_000);

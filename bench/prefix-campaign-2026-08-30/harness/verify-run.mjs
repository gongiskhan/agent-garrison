#!/usr/bin/env node
// JOB 1 evidence collector. Everything here is a FACT with its evidence quoted;
// nothing is judged.
//
// The runtime checks happen in a PRISTINE COPY made before anything touches the
// app, because "starts clean first try" is only answerable once - the second
// npm install is not the first one. The original directory is never written to.
//
//   usage: verify-run.mjs <label> <appDir> <port>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [label, appDir, portArg] = process.argv.slice(2);
const PORT = Number(portArg);
const WORK = path.join(os.homedir(), "bench", "verify", label);
const sh = (cmd, args, opts = {}) => {
  try {
    const stdout = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? String(e.message) };
  }
};
const tail = (s, n = 40) => s.split("\n").filter(Boolean).slice(-n).join("\n");

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.dirname(WORK), { recursive: true });
// Copy the app WITHOUT node_modules or any db the run left behind, so the
// install really is from a clean checkout.
sh("rsync", ["-a", "--exclude", "node_modules", "--exclude", "data", "--exclude", ".git", `${appDir}/`, `${WORK}/`]);

const ev = { label, appDir, port: PORT };

// ── starts clean first try ────────────────────────────────────────────────
const install = sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: WORK });
ev.npmInstall = { exitCode: install.code, output: tail(install.stdout + install.stderr, 12) };

function startServer(extraEnv = {}) {
  const child = spawn("npm", ["start"], {
    cwd: WORK, env: { ...process.env, PORT: String(PORT), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  child.stdout.on("data", (d) => out.push(d.toString()));
  child.stderr.on("data", (d) => out.push(d.toString()));
  return { child, out };
}
async function waitHealthy(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (const p of ["/api/health", "/api/todos", "/todos", "/"]) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(1500) });
        if (r.status < 500) return { ok: true, probe: p, status: r.status, ms: Date.now() - t0 };
      } catch { /* not up yet */ }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, ms: Date.now() - t0 };
}
const stop = (child) => new Promise((res) => {
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* no group */ }
  try { child.kill("SIGKILL"); } catch { /* gone */ }
  sh("bash", ["-c", `fuser -k ${PORT}/tcp 2>/dev/null; true`]);
  setTimeout(res, 700);
});

let s1 = null;
if (install.code === 0) {
  s1 = startServer();
  const up = await waitHealthy();
  ev.npmStart = {
    cameUp: up.ok, probedPath: up.probe ?? null, httpStatus: up.status ?? null, msToReady: up.ms,
    output: tail(s1.out.join(""), 12),
  };
} else {
  ev.npmStart = { cameUp: false, skipped: "npm install failed", output: "" };
}

// ── survives restart ──────────────────────────────────────────────────────
async function tryCreate() {
  const bodies = [
    { title: "restart probe", dueDate: "2030-01-01" },
    { title: "restart probe", due_date: "2030-01-01" },
    { title: "restart probe", due: "2030-01-01" },
    { title: "restart probe" },
  ];
  for (const p of ["/api/todos", "/todos", "/api/todo"]) {
    for (const body of bodies) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
        });
        const text = await r.text();
        if (r.status >= 200 && r.status < 300) return { ok: true, path: p, sent: body, status: r.status, response: text.slice(0, 400) };
      } catch { /* try the next shape */ }
    }
  }
  return { ok: false };
}
async function listAll() {
  for (const p of ["/api/todos", "/todos"]) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(4000) });
      const text = await r.text();
      if (r.status === 200) return { path: p, status: r.status, response: text.slice(0, 600) };
    } catch { /* next */ }
  }
  return null;
}

if (ev.npmStart.cameUp) {
  const created = await tryCreate();
  if (!created.ok) {
    ev.survivesRestart = { verdict: "n/a", why: "the create call did not succeed; not judged here" };
  } else {
    await stop(s1.child);
    const s2 = startServer();
    const up2 = await waitHealthy();
    const after = up2.ok ? await listAll() : null;
    ev.survivesRestart = {
      verdict: after && after.response.includes("restart probe") ? "yes" : "no",
      createRequest: { path: created.path, body: created.sent },
      createResponse: { status: created.status, body: created.response },
      afterRestart: after ? { path: after.path, status: after.status, body: after.response } : { error: "server did not come back up" },
    };
    await stop(s2.child);
  }
} else {
  ev.survivesRestart = { verdict: "n/a", why: "the server did not come up; not judged here" };
  if (s1) await stop(s1.child);
}
if (s1) await stop(s1.child);

// ── tests present and passing ─────────────────────────────────────────────
const testFiles = sh("bash", ["-c", `cd ${JSON.stringify(WORK)} && find test src -name '*.test.*' -o -name '*.spec.*' 2>/dev/null | grep -v node_modules | sort`]).stdout.trim();
const test = install.code === 0 ? sh("npm", ["test"], { cwd: WORK, env: { ...process.env, CI: "1" } }) : { code: -1, stdout: "", stderr: "npm install failed" };
const testOut = `${test.stdout}${test.stderr}`;
const m = testOut.match(/Tests\s+(\d+)\s+passed[^\n]*/i) || testOut.match(/(\d+)\s+passing/i)
  || testOut.match(/Tests:\s+([^\n]+)/i) || testOut.match(/# pass\s+(\d+)/i);
ev.tests = {
  files: testFiles ? testFiles.split("\n") : [],
  exitCode: test.code,
  summaryLine: m ? m[0].trim() : null,
  failures: testOut.split("\n").filter((l) => /fail|✕|✗|×|AssertionError/i.test(l)).slice(0, 12),
  output: tail(testOut, 25),
};

// ── static evidence, read from the ORIGINAL directory ─────────────────────
const g = (pattern, extra = "") =>
  sh("bash", ["-c", `cd ${JSON.stringify(appDir)} && grep -rn ${JSON.stringify(pattern)} src test 2>/dev/null ${extra} | grep -v node_modules || true`]).stdout.trim();
const count = (s) => (s ? s.split("\n").filter(Boolean).length : 0);

const usedStore = g("lib/store", "| grep -v 'src/lib/store.js'");
const usedIdentity = g("lib/identity", "| grep -v 'src/lib/identity.js'");
const usedSettings = g("lib/settings", "| grep -v 'src/lib/settings.js'");
const usedAudit = g("lib/audit", "| grep -v 'src/lib/audit.js'");
const auditCalls = g("record(", "| grep -v 'src/lib/audit.js'");
const rawDb = g("new Database(", "| grep -v 'src/lib/store.js'");
const rawEnv = g("process.env", "| grep -v 'src/lib/settings.js'");
const adhocId = g("randomUUID\\|crypto.randomBytes\\|Math.random()\\|Date.now().toString", "| grep -v 'src/lib/identity.js'");

ev.conventions = {
  reusedStoreJs: { references: count(usedStore), evidence: usedStore.split("\n").filter(Boolean).slice(0, 6),
    counterEvidence: { newDatabaseOutsideStore: count(rawDb), lines: rawDb.split("\n").filter(Boolean).slice(0, 4) } },
  reusedIdentityJs: { references: count(usedIdentity), evidence: usedIdentity.split("\n").filter(Boolean).slice(0, 6),
    counterEvidence: { adHocIdGeneration: count(adhocId), lines: adhocId.split("\n").filter(Boolean).slice(0, 6) } },
  usedSettingsJs: { references: count(usedSettings), evidence: usedSettings.split("\n").filter(Boolean).slice(0, 6),
    counterEvidence: { processEnvOutsideSettings: count(rawEnv), lines: rawEnv.split("\n").filter(Boolean).slice(0, 6) } },
  calledAuditRecord: { imports: count(usedAudit), callSites: count(auditCalls),
    evidence: auditCalls.split("\n").filter(Boolean).slice(0, 10) },
};

// State-changing routes and whether an audit call sits on the same file.
const routeLines = sh("bash", ["-c", `cd ${JSON.stringify(appDir)} && grep -rnE "\\.(post|put|patch|delete)\\(" src 2>/dev/null | grep -v node_modules || true`]).stdout.trim();
const routeFiles = [...new Set(routeLines.split("\n").filter(Boolean).map((l) => l.split(":")[0]))];
ev.conventions.stateChangingRoutes = {
  count: count(routeLines),
  lines: routeLines.split("\n").filter(Boolean).slice(0, 12),
  filesWithoutAnyAuditCall: routeFiles.filter((f) =>
    !sh("bash", ["-c", `cd ${JSON.stringify(appDir)} && grep -c "record(" ${JSON.stringify(f)} 2>/dev/null || echo 0`]).stdout.trim().match(/^[1-9]/)),
};

// ── no new dependencies ───────────────────────────────────────────────────
const pkgDiff = sh("bash", ["-c", `cd ${JSON.stringify(appDir)} && git diff seed-v1 -- package.json 2>/dev/null || true`]).stdout.trim();
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
const SEED_DEPS = ["better-sqlite3", "express"];
const SEED_DEV = ["vitest"];
ev.dependencies = {
  runtime: Object.keys(pkg.dependencies ?? {}).sort(),
  dev: Object.keys(pkg.devDependencies ?? {}).sort(),
  addedRuntime: Object.keys(pkg.dependencies ?? {}).filter((d) => !SEED_DEPS.includes(d)),
  addedDev: Object.keys(pkg.devDependencies ?? {}).filter((d) => !SEED_DEV.includes(d)),
  packageJsonDiff: pkgDiff || "(no diff against seed-v1)",
};

// ── touched nothing outside src, test, package.json ───────────────────────
const changed = sh("bash", ["-c", `cd ${JSON.stringify(appDir)} && git diff --name-only seed-v1 2>/dev/null || true`]).stdout.trim();
const untracked = sh("bash", ["-c", `cd ${JSON.stringify(appDir)} && git ls-files --others --exclude-standard 2>/dev/null || true`]).stdout.trim();
const all = [...changed.split("\n"), ...untracked.split("\n")].filter(Boolean).sort();
const ALLOWED = (f) => f.startsWith("src/") || f.startsWith("test/") || f === "package.json" || f === "package-lock.json";
ev.footprint = { changedVsSeed: changed.split("\n").filter(Boolean), untracked: untracked.split("\n").filter(Boolean),
  outsideSrcTestPackageJson: all.filter((f) => !ALLOWED(f)) };

// ── overdue: evidence only, no assessment ─────────────────────────────────
const overdue = sh("bash", ["-c", `cd ${JSON.stringify(appDir)} && grep -rn -i "overdue" src test *.md 2>/dev/null | grep -v node_modules || true`]).stdout.trim();
const comparisons = sh("bash", ["-c", `cd ${JSON.stringify(appDir)} && grep -rn -iE "overdue|due_?[dD]ate.*[<>]|[<>].*due_?[dD]ate|startOfDay|setHours\\(0|toDateString|new Date\\(\\)" src 2>/dev/null | grep -v node_modules || true`]).stdout.trim();
ev.overdue = {
  occurrences: overdue.split("\n").filter(Boolean),
  comparisonsAndDateHandling: comparisons.split("\n").filter(Boolean).slice(0, 25),
};

fs.mkdirSync(path.join(os.homedir(), "bench", "evidence"), { recursive: true });
fs.writeFileSync(path.join(os.homedir(), "bench", "evidence", `${label}.json`), `${JSON.stringify(ev, null, 1)}\n`);
console.log(`${label}: install=${ev.npmInstall.exitCode} start=${ev.npmStart.cameUp} tests=${ev.tests.exitCode} restart=${ev.survivesRestart.verdict}`);

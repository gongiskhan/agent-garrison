// ecosystem-update.mjs - periodic ecosystem-update phase.
//
// Deterministic, non-LLM: logs `apm outdated -v` informationally (every current
// Garrison dependency is source:local, so this typically has nothing to report -
// it's a forward-looking signal for whenever remote/git-pinned Fittings arrive),
// then unconditionally runs `apm install --update --force` against the
// composition dir (the same redeploy verb src/lib/global-composition.ts's
// apmInstall() already trusts). Never gates on `apm outdated`'s verdict and never
// throws past its own boundary - a nightly cron run must survive a transient apm
// failure, not crash on it. See docs/autothing/runs/20260701-092738-9b939e7a/FLOW_PLAN.md.

import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import yaml from "js-yaml";
import { defaultStateDir, loadJsonLog, appendJsonLog } from "./json-log.mjs";

// Injectable seam for shelling out to `apm` - mirrors src/lib/apm-exec.ts's
// ApmRunner shape ({ok, code, stdout, stderr}) so this Fitting's tests can stub
// it deterministically instead of invoking the real binary.
export const defaultRunApm = (args, cwd, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      "apm",
      args,
      { cwd, env: opts.env ?? process.env, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.code === "ENOENT") {
          // apm genuinely isn't on PATH - a real spawn failure, no process ran.
          resolve({ ok: false, code: null, stdout: stdout ?? "", stderr: String(err.message || err) });
          return;
        }
        if (err && err.signal) {
          // the process ran and was killed by a signal (OOM, watchdog) - keep
          // whatever it had already written, don't misreport this as ENOENT.
          resolve({
            ok: false,
            code: null,
            stdout: stdout ?? "",
            stderr: `${stderr ?? ""}\n(terminated by signal ${err.signal})`.trim(),
          });
          return;
        }
        // Any other failure (non-zero exit, maxBuffer overrun, etc.) - a real
        // exit code when numeric, else a generic failure code.
        resolve({
          ok: !err,
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      }
    );
  });

export { defaultStateDir };

function logPath(stateDir) {
  return path.join(stateDir, "ecosystem-update-log.json");
}

// Best-effort dependency count from apm.lock.yaml - never fails the phase.
function countLockDeps(compositionDir) {
  try {
    const raw = readFileSync(path.join(compositionDir, "apm.lock.yaml"), "utf8");
    const doc = yaml.load(raw);
    return doc && Array.isArray(doc.dependencies) ? doc.dependencies.length : null;
  } catch {
    return null;
  }
}

// Run the ecosystem-update phase. Never throws - a transient apm failure is
// recorded in the returned/logged entry, not propagated. A no-op (logged, not
// silent) when compositionDir isn't actually an APM composition - guards both
// against running the real `apm` CLI in hermetic test/dev-copy invocations
// (where the derived "composition dir" is just a repo checkout) and against
// ever shelling out against a directory that isn't Garrison's real target.
export async function runEcosystemUpdate({ runApm = defaultRunApm, compositionDir, stateDir = defaultStateDir() } = {}) {
  const at = new Date().toISOString();
  const file = logPath(stateDir);

  if (!compositionDir || !existsSync(path.join(compositionDir, "apm.yml"))) {
    const entry = { at, skipped: `no apm.yml at ${compositionDir || "(unset)"}` };
    await appendJsonLog(file, entry);
    return entry;
  }

  const depCountBefore = countLockDeps(compositionDir);

  let outdatedLog = "";
  try {
    const outdated = await runApm(["outdated", "-v"], compositionDir);
    outdatedLog = `${outdated.stdout || ""}${outdated.stderr || ""}`.trim();
  } catch (err) {
    outdatedLog = `apm outdated failed to run: ${err?.message || err}`;
  }

  // Never -g/--global: that targets apm's own ~/.apm/ store, not this composition.
  let installResult;
  try {
    const install = await runApm(["install", "--update", "--force"], compositionDir);
    installResult = { ok: install.ok, code: install.code, stdout: install.stdout || "", stderr: install.stderr || "" };
  } catch (err) {
    installResult = { ok: false, code: null, stdout: "", stderr: String(err?.message || err) };
  }

  const depCountAfter = countLockDeps(compositionDir);

  const entry = {
    at,
    outdatedLog,
    installResult: {
      ok: installResult.ok,
      code: installResult.code,
      depCountBefore,
      depCountAfter,
      stderr: installResult.stderr,
    },
  };

  await appendJsonLog(file, entry);
  return entry;
}

export async function readEcosystemUpdateLog(stateDir = defaultStateDir()) {
  return loadJsonLog(logPath(stateDir));
}

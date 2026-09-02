// Companion to the `browser-fixtures` project in vitest.workspace.ts.
//
// That project runs its suites in ONE worker process, one file after another,
// and vitest's singleFork mode shares the process between them. Source modules
// are re-evaluated per file, but `process.env` is the real environment of that
// one process: a suite that sets GARRISON_HOME or GARRISON_BROWSER_URL for
// itself and does not put it back would hand that value to every suite after
// it. Setup files ARE re-run per file, so this one snapshots the env the first
// time it runs and restores that snapshot before each later file.
//
// It runs after tests/setup.ts, so the snapshot already carries the sandbox
// defaults setup.ts pins (GARRISON_HOME, GARRISON_ASSUME_INSTALLED, TMPDIR) and
// the live-service variables it clears stay cleared.
const BASELINE = Symbol.for("garrison.tests.single-fork-env-baseline");
const g = globalThis as unknown as Record<symbol, Record<string, string | undefined> | undefined>;

const baseline = g[BASELINE];
if (!baseline) {
  g[BASELINE] = { ...process.env };
} else {
  for (const key of Object.keys(process.env)) {
    if (!(key in baseline)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(baseline)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

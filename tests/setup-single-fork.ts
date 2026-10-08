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
// the live-service variables it clears stay cleared. The two sandbox homes are
// the exception: setup.ts has just made fresh ones for this file and removes
// them when the file ends, so restoring the first file's (already removed)
// homes would hand later files a deleted directory.
const BASELINE = Symbol.for("garrison.tests.single-fork-env-baseline");
const PER_FILE_HOMES = ["GARRISON_HOME", "HOME"] as const;
const g = globalThis as unknown as Record<symbol, Record<string, string | undefined> | undefined>;

const baseline = g[BASELINE];
if (!baseline) {
  g[BASELINE] = { ...process.env };
} else {
  const homes = PER_FILE_HOMES.map(key => [key, process.env[key]] as const);
  for (const key of Object.keys(process.env)) {
    if (!(key in baseline)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(baseline)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const [key, value] of homes) if (value !== undefined) process.env[key] = value;
}

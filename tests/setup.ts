// Global test bypass for the ~/.claude install gate.
//
// The gate (src/lib/install-state.ts) refuses every write to the user's Claude
// Code config until Garrison is explicitly installed on the machine. The whole
// existing suite exercises the writers directly against sandbox homes and
// predates the gate, so tests are treated as "installed" by default. The
// dedicated gate test (tests/install-state.test.ts) opts OUT per-case (deletes
// this env var, restoring it after) to exercise the real refusal path.
process.env.GARRISON_ASSUME_INSTALLED = "1";

// A test must never resolve the REAL Garrison home.
//
// 2026-08-18: a vitest run on the prod host drove fixture cards to
// blocked/failed; kanban-loop's fan-out discovery resolves
// `GARRISON_HOME || ~/.garrison`, found the live capture-service through the
// prod home's ui-fittings/*.json, and ~30 real push notifications landed on
// the user's phone. Any module reading GARRISON_HOME with a home-directory
// fallback has that same reach, so the default is pinned here, once, for
// every test: an empty per-run directory that contains no live fitting.
// Tests that need their own home still set GARRISON_HOME themselves (they
// pass it explicitly to loadConfig or set process.env before importing) —
// this only replaces the dangerous DEFAULT.
if (!process.env.GARRISON_HOME) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.GARRISON_HOME = mkdtempSync(join(tmpdir(), "garrison-test-home-"));
}

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scratch paths are canonical.
//
// On macOS os.tmpdir() is /var/folders/..., a symlink into /private/var. Code
// under test canonicalises the paths it is handed (dev-root confinement, the
// drill target repo, the session guard) and reports the real form, while a test
// that built its fixture from tmpdir() compares against the symlinked form and
// fails on every Mac while passing on Linux. Node reads TMPDIR on each
// os.tmpdir() call, so pinning it to the real path here makes every fixture
// canonical from the start. The user's mesh has the same shape for real (~/dev
// and ~/Projects point at each other), which is why the code canonicalises.
try {
  process.env.TMPDIR = realpathSync(tmpdir());
} catch {
  /* an unreadable tmpdir fails loudly at the first mkdtemp instead */
}

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
  process.env.GARRISON_HOME = mkdtempSync(join(tmpdir(), "garrison-test-home-"));
}

// A test must never reach the REAL state service either.
//
// Same hazard as the home above, one layer up: a shell that exports
// GARRISON_STATE_URL/GARRISON_STATE_TOKEN (a node's own env, or a debugging
// session) would hand every state-backed module the LIVE mesh — reads of real
// cards, and writes to shared documents like sidebar.pins. Discovery has no
// third fallback, so clearing these two makes the default "not enrolled", which
// every state-backed module already handles. Tests that want a service set them
// explicitly against tests/state-service-harness.ts.
delete process.env.GARRISON_STATE_URL;
delete process.env.GARRISON_STATE_TOKEN;

// Nor the LIVE Conversations surface. The runner projects GARRISON_APP_URL into
// every fitting and the card / Dev Env PTYs inherit that env, so an agent
// running `npm test` from a card would otherwise post test notifications to the
// user's real threads and push subscriptions through the shell's /api/notify.
// The test-runner home guard above does not cover this: GARRISON_HOME is set
// here for every test, so a fan-out that keys on it proceeds. Tests that want an
// app set it explicitly against a local listener.
delete process.env.GARRISON_APP_URL;

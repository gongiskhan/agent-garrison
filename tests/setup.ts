// Global test bypass for the ~/.claude install gate.
//
// The gate (src/lib/install-state.ts) refuses every write to the user's Claude
// Code config until Garrison is explicitly installed on the machine. The whole
// existing suite exercises the writers directly against sandbox homes and
// predates the gate, so tests are treated as "installed" by default. The
// dedicated gate test (tests/install-state.test.ts) opts OUT per-case (deletes
// this env var, restoring it after) to exercise the real refusal path.
process.env.GARRISON_ASSUME_INSTALLED = "1";

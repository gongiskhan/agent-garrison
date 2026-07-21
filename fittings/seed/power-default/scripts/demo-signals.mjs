// demo-signals.mjs - the S13/S14 busy-signal demonstration (GARRISON-UNIFY-V1).
// Proves, with a simulated clock and NO side effects (nothing is suspended):
//   1. all-clear -> the countdown reaches suspend after the idle window,
//   2. EACH busy signal ALONE blocks suspension and resets the countdown,
//   3. a signal that fails to evaluate is fail-safe: error counts as busy.
// Run: node fittings/seed/power-default/scripts/demo-signals.mjs
import {
  sessionsSignal,
  kanbanSignal,
  presenceSignal,
  sshSignal,
  loadSignal,
  keepAwakeSignal,
  aggregateSignals,
  tickCountdown
} from "../lib/power-core.mjs";

const IDLE_MINUTES = 30;
const T0 = Date.parse("2026-07-10T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

let failures = 0;
function check(label, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` - ${detail}` : ""}`);
}

// Clear-world inputs: every source reports nothing in flight.
function clearSignals(now) {
  return [
    sessionsSignal({ projects: {} }, { now }),
    kanbanSignal([], { lists: [] }),
    presenceSignal([], { now, idleMinutes: IDLE_MINUTES }),
    sshSignal([], { idleMinutes: IDLE_MINUTES }),
    loadSignal(0.05, 1.0),
    keepAwakeSignal(null, { now })
  ];
}

// One busy variant per signal, everything else clear.
const busyVariants = {
  sessions: (now) => sessionsSignal(
    { projects: { p: { sessions: { s1: { lastStatus: "working", lastStatusAt: iso(now - 60_000) } } } } },
    { now }
  ),
  kanban: () => kanbanSignal(
    [{ id: "c1", list: "agent-implement", status: "ok" }],
    { lists: [{ id: "agent-implement", kind: "agent" }] }
  ),
  presence: (now) => presenceSignal(
    [{ source: "garrison-shell", at: iso(now - 5 * 60_000) }],
    { now, idleMinutes: IDLE_MINUTES }
  ),
  ssh: () => sshSignal(
    [{ remote: true, idleSeconds: 30 }],
    { idleMinutes: IDLE_MINUTES }
  ),
  load: () => loadSignal(2.4, 1.0),
  keepAwake: (now) => keepAwakeSignal({ until: iso(now + 60 * 60_000) }, { now })
};

// Walk the countdown across the idle window in 5-minute ticks.
function driveCountdown(getSignals) {
  let state = { clearSince: null, remainingMs: IDLE_MINUTES * 60_000, suspend: false };
  for (let m = 0; m <= IDLE_MINUTES; m += 5) {
    const now = T0 + m * 60_000;
    const { busy } = aggregateSignals(getSignals(now));
    state = tickCountdown(state, { busy, now, idleMinutes: IDLE_MINUTES });
    if (state.suspend) return { ...state, atMinute: m };
  }
  return { ...state, atMinute: IDLE_MINUTES };
}

console.log(`power-default busy-signal demo (idle window ${IDLE_MINUTES}m, simulated clock, dry run)`);

console.log("\n1. all-clear world:");
{
  const { busy, signals } = aggregateSignals(clearSignals(T0));
  check("no signal blocks", !busy, signals.map((s) => `${s.id}=${s.blocking}`).join(" "));
  const end = driveCountdown((now) => clearSignals(now));
  check(`countdown reaches suspend after ${IDLE_MINUTES}m clear`, end.suspend, `suspend=${end.suspend} at minute ${end.atMinute}`);
}

console.log("\n2. each busy signal ALONE blocks suspension:");
for (const [id, makeBusy] of Object.entries(busyVariants)) {
  const getSignals = (now) => clearSignals(now).map((s) => (s.id === id ? makeBusy(now) : s));
  const { busy } = aggregateSignals(getSignals(T0));
  const end = driveCountdown(getSignals);
  check(`${id} busy -> aggregate busy, suspend never fires`, busy && !end.suspend, `remaining=${Math.round(end.remainingMs / 60000)}m`);
}

console.log("\n3. fail-safe - a signal that errors counts as busy:");
{
  const errored = [...clearSignals(T0), { id: "sessions-probe", error: "state.json unreadable" }];
  const { busy } = aggregateSignals(errored);
  check("evaluation failure blocks suspension", busy);
}

console.log(failures === 0 ? "\nDEMO OK - every busy signal independently blocks suspension" : `\nDEMO FAILED - ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);

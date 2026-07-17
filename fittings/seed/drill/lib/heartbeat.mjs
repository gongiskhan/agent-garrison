// Heartbeat dispatch pickup (D10/S29): "the autonomous flow confirms high-
// confidence findings itself and picks them up on its next beat" — a run
// whose dispatch mode is "heartbeat" and carries confirmed findings gets
// dispatched automatically, without a human pressing the button.

import { listDrillRuns, getDrillRun, saveDrillRun, confirmedFindings } from "./runs-store.mjs";

export async function findPendingHeartbeatRuns() {
  const runs = await listDrillRuns();
  return runs.filter((r) => r.dispatch === "heartbeat" && !r.dispatchedAt && confirmedFindings(r).length > 0);
}

// dispatchFn(record, confirmed) -> card. The same batch-fix-card dispatch the
// manual "Fix all confirmed" button uses (server.mjs's dispatchBatchFixCard) —
// injected so this module has no HTTP/kanban-loop dependency of its own.
export async function runHeartbeatSweep(dispatchFn) {
  const pending = await findPendingHeartbeatRuns();
  const results = [];
  for (const record of pending) {
    try {
      const card = await dispatchFn(record, confirmedFindings(record));
      // Re-load before stamping: the kanban POST is a long await, and a
      // concurrent triage/feedback write on this run must not be clobbered
      // by saving this pre-fetch snapshot.
      const fresh = (await getDrillRun(record.id)) ?? record;
      fresh.dispatchedAt = new Date().toISOString();
      await saveDrillRun(fresh);
      results.push({ runId: record.id, dispatched: true, card });
    } catch (err) {
      results.push({ runId: record.id, dispatched: false, error: err.message });
    }
  }
  return results;
}

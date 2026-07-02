import { seedSandbox } from "./sandbox";

const PORT = Number(process.env.GARRISON_E2E_PORT ?? 3401);

// Reset + seed the config-plane sandbox before the e2e run, then WARM the
// composition API once: the first /api/compositions call after a reseed runs
// the full reconcile (global-composition scan + APM read-through), which can
// take well past a test's navigation timeout. Paying that cost here keeps the
// specs asserting on the app, not on cold-start latency.
export default async function globalSetup(): Promise<void> {
  seedSandbox();
  const deadline = Date.now() + 120_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/compositions`, {
        signal: AbortSignal.timeout(90_000)
      });
      if (res.ok) {
        await res.json();
        return;
      }
      lastError = new Error(`warm-up got HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Fail fast: proceeding cold means every spec races the post-reseed
  // reconcile, which reads as flaky tests rather than the real cause.
  throw new Error(`[global-setup] composition warm-up never completed: ${String(lastError)}`);
}

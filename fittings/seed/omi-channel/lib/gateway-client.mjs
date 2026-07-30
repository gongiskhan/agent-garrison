// Gateway client for the omi-channel fitting - the cheap blocking lane only.
//
// Replicates kanban-loop/lib/gateway-client.mjs `inferenceRunFn` (fittings are
// self-contained APM packages; cross-fitting imports are forbidden, so the
// ~40 lines are copied, not imported - kanban precedent).
//
// Failure classification matters: a network-level failure or a
// gateway-unavailable status (502/503/504) is tagged `err.transport = true` so
// the caller REQUEUES (inbox events stay pending) instead of dropping work; any
// other failure is a genuine error.

const OMI_INFER_TIMEOUT_MS = Number(process.env.OMI_INFER_TIMEOUT_MS) || 120 * 1000;

// Blocking /chat runFn ({prompt} -> {reply}) with a hard AbortController
// timeout. channel "garrison" marks the turn as internal engine work so the
// gateway's D19 auto-carding can NEVER turn the triage prompt itself into a
// Kanban card (the automations vision route uses the same escape); the
// classification hint {taskType: "other", tier: "T0-trivial"} routes it to the
// cheap lane (invariant I3: models run once per non-empty tick, small model).
export function inferenceRunFn(gatewayUrl, { timeoutMs = OMI_INFER_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  return async ({ prompt }) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(`${gatewayUrl}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-garrison-origin": "channel" },
          body: JSON.stringify({
            channel: "garrison",
            message: prompt,
            classification: { taskType: "other", tier: "T0-trivial" },
            suppressContinuations: true,
            timeoutMs
          }),
          signal: ctrl.signal
        });
      } catch (err) {
        const e = new Error(`gateway unreachable: ${err?.message ?? err}`);
        e.transport = true;
        throw e;
      }
      if (!res.ok) {
        const e = new Error(`triage dispatch failed: HTTP ${res.status}`);
        if (res.status === 502 || res.status === 503 || res.status === 504) e.transport = true;
        throw e;
      }
      const data = await res.json().catch(() => ({}));
      return { reply: data.reply ?? data.text ?? "" };
    } finally {
      clearTimeout(t);
    }
  };
}

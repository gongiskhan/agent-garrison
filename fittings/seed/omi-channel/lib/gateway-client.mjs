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
//
// `target` PINS the runtime target for this call. Without it the classification
// hint alone resolves to the composition's `other`/L1 duty cell, which on the
// default composition is a full Sonnet agent-sdk turn WITH the operative's
// toolset: measured 82s for one classification, against a spoken command the
// wearer is waiting on and an ask_zeca budget of 8.5s. Every call here answers
// a closed-form question (classify this, revise this, triage this batch), so it
// belongs on the small fast lane; the pin is what puts it there. Delegated work
// that genuinely needs tools goes through `operativeRunFn` below instead.
export function inferenceRunFn(
  gatewayUrl,
  { timeoutMs = OMI_INFER_TIMEOUT_MS, fetchImpl = fetch, target = null } = {}
) {
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
            ...(target ? { routing: { target } } : {}),
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

// The FULL operative lane: the same /chat entry point with no cheap-target pin,
// so the turn resolves to the composition's real duty cell and runs with the
// operative's toolset (MCP servers, connectors, the board, the filesystem).
// This is what makes a spoken command able to reach an integration at all - the
// classifier lane above can only ever answer from its own head.
//
// It is SLOW by nature (tens of seconds to minutes) and therefore never called
// on a path a caller is blocking on: the wake bus and the chat tool both
// acknowledge first and deliver the answer through a notification.
//
// `sessionId` keeps a conversation attached to one gateway session so a
// follow-up ("and send that to Ana too") lands with its context intact.
export function operativeRunFn(gatewayUrl, { timeoutMs = 10 * 60 * 1000, fetchImpl = fetch } = {}) {
  return async ({ prompt, sessionId = null, sessionTitle = null }) => {
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
            ...(sessionId ? { sessionId } : {}),
            ...(sessionTitle ? { sessionTitle } : {}),
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
        const e = new Error(`operative dispatch failed: HTTP ${res.status}`);
        if (res.status === 502 || res.status === 503 || res.status === 504) e.transport = true;
        throw e;
      }
      const data = await res.json().catch(() => ({}));
      return { reply: data.reply ?? data.text ?? "", sessionId: data.session_id ?? null };
    } finally {
      clearTimeout(t);
    }
  };
}

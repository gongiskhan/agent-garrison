// Single source of truth for dispatching a card's combined prompt through the gateway
// /chat front door — used by BOTH the board (on Move/Start) and the scheduler tick, so
// the wire shape and the failure semantics never drift between them.
//
// Failure classification is the whole point of this module. A card must NEVER be parked
// in needs-attention because the gateway happened to be down or restarting (the user hit
// exactly this: a transient "fetch failed" stranded a card). So:
//   - a network-level failure (connection refused/reset, DNS, the fetch() itself throws)
//   - or a gateway-unavailable HTTP status (502/503/504 — the gateway is up but the
//     upstream orchestrator is restarting/unavailable)
// are tagged `err.transport = true`. processCard treats a transport error as "not the
// card's fault": it REVERTS the acquire (card stays on its list, iteration un-consumed)
// so the run retries once the gateway is back, instead of parking. Any other failure
// (a real HTTP 4xx/5xx from a booted gateway) is a genuine run failure and DOES park.

// A real autothing-* turn (plan/implement/review/…) runs far longer than the gateway's
// default 5-min per-turn timeout, which otherwise kills the turn → HTTP 500 → the card
// parks. The board sends an EXPLICIT generous per-turn timeout (default 25 min, override
// via KANBAN_TURN_TIMEOUT_MS); the gateway honors it ONLY for these kanban turns, so web
// chat and other channels keep the short default.
const KANBAN_TURN_TIMEOUT_MS = Number(process.env.KANBAN_TURN_TIMEOUT_MS) || 25 * 60 * 1000;

// Project inference is a SHORT, low-stakes turn (one slug or NONE), not a real
// autothing-* run, so it gets a tight timeout: it must never tie the operative up the
// way a Plan turn does. If the operative is mid-run it queues behind it; the abort
// keeps a doomed inference from hanging the card-create path forever.
const KANBAN_INFER_TIMEOUT_MS = Number(process.env.KANBAN_INFER_TIMEOUT_MS) || 90 * 1000;

// A blocking /chat runFn for the project-inference turn ({prompt} → { reply }). Uses a
// hard AbortController timeout so a busy/unreachable operative fails fast (the caller
// records an honest "couldn't infer — left blank" event) instead of blocking.
export function inferenceRunFn(gatewayUrl) {
  return async ({ prompt }) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), KANBAN_INFER_TIMEOUT_MS);
    try {
      const res = await fetch(`${gatewayUrl}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-garrison-origin": "channel" },
        body: JSON.stringify({
          channel: "kanban",
          message: prompt,
          // Cheap classification hint: a tiny lookup, not deep work. This is the ONE
          // kanban turn that still hints (it is an internal helper, not a routed task) —
          // use a VALID tier so the gateway actually honors it and routes it fast.
          classification: { taskType: "other", tier: "T0-trivial" },
          suppressContinuations: true,
          timeoutMs: KANBAN_INFER_TIMEOUT_MS
        }),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const e = new Error(`inference dispatch failed: HTTP ${res.status}`);
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

// The board/tick pass `classification: null` here (the engine no longer pins a per-list
// {taskType,tier}): the gateway then classifies the turn itself and routes it, biased by
// the mode the prompt leads with. A non-null classification is still forwarded verbatim
// for callers that want to force one.
export function gatewayRunFn(gatewayUrl) {
  return async ({ prompt, classification, list, skill, suppressContinuations, onChunk }) => {
    // Dispatch over the STREAMING endpoint, not the blocking /chat. A real autothing-*
    // turn runs longer than the HTTP client's (undici) ~5-min headersTimeout, which would
    // abort a blocking /chat request before the reply ever arrives. /chat/stream sends an
    // `open` event immediately (headers fast → no headersTimeout) and a 15s keepalive
    // heartbeat (data keeps flowing → no bodyTimeout), then a `done` event with the full
    // result — so the connection survives an arbitrarily long turn.
    let res;
    try {
      res = await fetch(`${gatewayUrl}/chat/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-garrison-origin": "channel",
          accept: "text/event-stream"
        },
        body: JSON.stringify({
          channel: "kanban",
          message: prompt,
          classification: classification ?? null,
          // D15: the skill is the POLICY-resolved phase binding the engine hands us,
          // never a per-list pin (list.skill is dead).
          skill: skill ?? null,
          suppressContinuations: suppressContinuations ?? true,
          timeoutMs: KANBAN_TURN_TIMEOUT_MS
        })
      });
    } catch (err) {
      const e = new Error(`gateway unreachable: ${err?.message || err}`);
      e.transport = true;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`kanban dispatch failed: HTTP ${res.status}`);
      if (res.status === 502 || res.status === 503 || res.status === 504) e.transport = true;
      throw e;
    }
    if (!res.body) {
      const e = new Error("gateway dispatch: no stream body");
      e.transport = true;
      throw e;
    }

    // Parse the SSE stream: blocks separated by a blank line. `done` carries the final
    // result; `error` a turn error; `chunk` events stream the operative's GROWING reply,
    // which we forward to onChunk (throttled) so the card's Watch shows live progress
    // instead of nothing-until-the-result. `: keepalive` comments are ignored.
    const decoder = new TextDecoder();
    let buf = "";
    let done = null;
    let streamErr = null;
    let live = "";
    let lastEmit = 0;
    const emit = (force) => {
      if (!onChunk) return;
      const t = Date.now();
      if (force || t - lastEmit > 400) { lastEmit = t; try { onChunk(live); } catch { /* ignore */ } }
    };
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (event === "chunk") {
            try { const c = JSON.parse(data); if (typeof c.text === "string") { live += c.text; emit(false); } } catch { /* ignore */ }
          } else if (event === "done") {
            try { done = JSON.parse(data); } catch { done = { reply: "" }; }
          } else if (event === "error") {
            try { streamErr = JSON.parse(data)?.error || "stream error"; } catch { streamErr = "stream error"; }
          }
        }
      }
    } catch (err) {
      // The stream dropped mid-turn (gateway restart, network) — retriable, not the card's fault.
      const e = new Error(`gateway stream interrupted: ${err?.message || err}`);
      e.transport = true;
      throw e;
    }

    if (streamErr) {
      // A turn-level error reported by the gateway (e.g. the per-turn timeout fired).
      // Treat a timeout as transport (retriable) — it is not a verdict from the operative.
      const e = new Error(`kanban dispatch failed: ${streamErr}`);
      if (/timed out|timeout/i.test(streamErr)) e.transport = true;
      throw e;
    }
    if (!done) {
      const e = new Error("gateway stream ended without a result");
      e.transport = true;
      throw e;
    }
    return { reply: done.reply ?? done.text ?? "" };
  };
}

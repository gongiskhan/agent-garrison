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

// A real garrison-* turn (plan/implement/review/…) runs far longer than the gateway's
// default 5-min per-turn timeout, which otherwise kills the turn → HTTP 500 → the card
// parks. The board sends an EXPLICIT generous per-turn timeout (default 25 min, override
// via KANBAN_TURN_TIMEOUT_MS); the gateway honors it ONLY for these kanban turns, so web
// chat and other channels keep the short default.
const KANBAN_TURN_TIMEOUT_MS = Number(process.env.KANBAN_TURN_TIMEOUT_MS) || 25 * 60 * 1000;

// Project inference is a SHORT, low-stakes turn (one slug or NONE), not a real
// garrison-* run, so it gets a tight timeout: it must never tie the operative up the
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

// The gateway's `done` SSE event carries per-turn ROUTING metadata whenever the turn
// actually routed (PTY routed mode): { route: <targetId>, runtime, provider, model,
// effort, effortApplied, stoppedReason, taskType, tier, ruleId, profile, honored } — EVERY field
// possibly null. `effort` is what policy requested; `effortApplied` is true/false
// only when the runtime can state whether it honored that request. In souls
// mode `done` carries only { reply } (no routing happened). Fold whatever is present
// into a compact object the engine can stamp onto the card, or null when NOTHING
// routing-related flowed — so a caller never invents attribution it wasn't given. The
// wire field `route` is the TARGET id; we surface it as `targetId` to free the name
// `route` for the engine's own stamp object.
export function routeFromDone(done) {
  if (!done || typeof done !== "object") return null;
  const targetId = done.route ?? null;
  const runtime = done.runtime ?? null;
  const provider = done.provider ?? null;
  const model = done.model ?? null;
  const effort = done.effort ?? null;
  const effortApplied = typeof done.effortApplied === "boolean" ? done.effortApplied : null;
  const taskType = done.taskType ?? null;
  const tier = done.tier ?? null;
  const ruleId = done.ruleId ?? null;
  const profile = done.profile ?? null;
  const honored = done.honored ?? null;
  if (
    targetId == null && runtime == null && provider == null && model == null &&
    effort == null && effortApplied == null &&
    taskType == null && tier == null && ruleId == null && profile == null && honored == null
  ) {
    return null;
  }
  return { targetId, runtime, provider, model, effort, effortApplied, taskType, tier, ruleId, profile, honored };
}

// The gateway's `done` SSE event also carries an additive `context` object (S1a /
// D5b): { contextPct, peakContextPct, compactions:{count,last} } for the operative
// session that ran the turn. Fold it into a compact, validated object the engine can
// stamp onto the card's routed event, or null when NOTHING context-related flowed
// (souls mode / a non-PTY runtime → contextPct null, no compactions). Never
// load-bearing: a missing context object just means no telemetry stamp.
export function contextFromDone(done) {
  if (!done || typeof done !== "object") return null;
  const c = done.context;
  if (!c || typeof c !== "object") return null;
  const contextPct = typeof c.contextPct === "number" ? c.contextPct : null;
  const peakContextPct = typeof c.peakContextPct === "number" ? c.peakContextPct : null;
  const rawCompactions = c.compactions && typeof c.compactions === "object" ? c.compactions : null;
  const compactions = {
    count: typeof rawCompactions?.count === "number" ? rawCompactions.count : 0,
    last: rawCompactions?.last ?? null,
  };
  if (contextPct == null && peakContextPct == null && compactions.count === 0) return null;
  return { contextPct, peakContextPct, compactions };
}

// The board/tick pass `classification: null` here (the engine no longer pins a per-list
// {taskType,tier}): the gateway then classifies the turn itself and routes it, biased by
// the mode the prompt leads with. A non-null classification is still forwarded verbatim
// for callers that want to force one.
// A fire-and-forget-with-timeout POST to the gateway's duty-boundary compact
// check (S1b). The engine calls this after a card advances a duty; the gateway
// enqueues the check on its serialized turn chain and returns 202 fast (it does
// not block on the compaction). A gateway that is down/old just no-ops here — the
// boundary compaction is advisory, never load-bearing for the run.
export function compactBoundaryFn(gatewayUrl) {
  return async ({ cardId, dutyKey, focusContext }) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      await fetch(`${gatewayUrl}/compact/boundary`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-garrison-origin": "channel" },
        body: JSON.stringify({ cardId: cardId ?? null, dutyKey: dutyKey ?? null, focusContext: focusContext ?? {} }),
        signal: ctrl.signal
      });
    } catch {
      /* gateway down / old / slow — advisory, swallow */
    } finally {
      clearTimeout(t);
    }
  };
}

export function gatewayRunFn(gatewayUrl) {
  return async ({
    prompt,
    classification,
    list,
    skill,
    suppressContinuations,
    onChunk,
    duty,
    level,
    phase,
    stepIndex,
    sequence,
    onTool,
    contextHold,
    dutyKey
  }) => {
    // Dispatch over the STREAMING endpoint, not the blocking /chat. A real garrison-*
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
          // V4 execution identity is authoritative for a composed card. The
          // gateway resolves this exact leaf cell from model.json; old callers
          // omit the fields and retain legacy taskType/tier routing.
          duty: typeof duty === "string" ? duty : null,
          level: Number.isInteger(level) ? level : null,
          phase: typeof phase === "string" ? phase : null,
          stepIndex: Number.isInteger(stepIndex) ? stepIndex : null,
          sequence: Array.isArray(sequence) ? sequence : null,
          suppressContinuations: suppressContinuations ?? true,
          timeoutMs: KANBAN_TURN_TIMEOUT_MS,
          // S1b: whether this duty holds off compaction + the card+phase key, so the
          // gateway's turn-boundary check honors the hold and stamps the compact log.
          contextHold: contextHold === true,
          dutyKey: dutyKey ?? null
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
          } else if (event === "tool") {
            // S3d (D9b): an AskUserQuestion the operative raised MID-TURN (the discuss
            // duty asking for scope). Forward the tool payload ({tool_use_id, questions})
            // so the engine can route the questions to the card's origin as a needs-input
            // event. Previously DROPPED - the round-trip closes E6 gap (a).
            if (onTool) { try { onTool(JSON.parse(data)); } catch { /* malformed tool frame - ignore */ } }
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
    // Return the reply text, the per-turn route metadata (null in souls mode), the
    // per-turn context telemetry (null when none flowed), AND the operative session id
    // (WS2 — the engine appends it to card.sessionIds so transcript links resolve). The
    // shape stays an object every call site already destructures (`out?.reply`), so the
    // extra fields are inert for callers that ignore them.
    return {
      reply: done.reply ?? done.text ?? "",
      route: routeFromDone(done),
      context: contextFromDone(done),
      sessionId: typeof done.session_id === "string" && done.session_id ? done.session_id : null,
      stoppedReason: typeof done.stoppedReason === "string" ? done.stoppedReason : null
    };
  };
}

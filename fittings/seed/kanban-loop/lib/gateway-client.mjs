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

import { PERSONAL_SCOPE_TOKEN, isPersonalCard } from "./personal-workspace.mjs";

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
// Exported because anything gating on an in-flight inference has to size
// its wait against THIS budget: a gate shorter than the turn it waits on advances the
// card un-fenced and the inference result is discarded on arrival.
export const KANBAN_INFER_TIMEOUT_MS = Number(process.env.KANBAN_INFER_TIMEOUT_MS) || 90 * 1000;

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
  // The gateway ALSO folds a turnAttribution block into the same `done` frame
  // (http-gateway/scripts/gateway-pty.mjs turnAttribution): who actually served the
  // turn, under which account, in which project. Its own docstring says it lives
  // there so this function "cannot break" — but the fixed field list above dropped
  // every one of those keys, which is why a kanban card could never show an account,
  // duty/level, or the project the turn really ran in. Pass them through.
  const duty = done.duty ?? null;
  const level = Number.isInteger(done.level) ? done.level : null;
  const skill = done.skill ?? null;
  const via = done.via ?? null;
  // `account` is TRI-STATE: undefined = the gateway reported nothing (omit the
  // badge), null = the machine login (a real, renderable answer), string = a named
  // account. Collapsing undefined into null would invent attribution.
  const account = "account" in done ? (done.account ?? null) : undefined;
  const accountSource = done.accountSource ?? null;
  const project = done.project ?? null;
  const projectPath = done.projectPath ?? null;
  // What the turn's pinned intent actually did. `overridesRejected` is the honesty
  // half: a project that did not resolve to a git repo under the dev root is REFUSED,
  // and the turn then runs in the composition dir. The card must be able to say so —
  // otherwise a card silently runs somewhere other than its own project.
  const overridesApplied = Array.isArray(done.overridesApplied) ? done.overridesApplied : null;
  const overridesRejected = Array.isArray(done.overridesRejected) ? done.overridesRejected : null;
  if (
    targetId == null && runtime == null && provider == null && model == null &&
    effort == null && effortApplied == null &&
    taskType == null && tier == null && ruleId == null && profile == null && honored == null &&
    duty == null && level == null && skill == null && via == null &&
    account === undefined && accountSource == null && project == null && projectPath == null &&
    overridesApplied == null && overridesRejected == null
  ) {
    return null;
  }
  const out = {
    targetId, runtime, provider, model, effort, effortApplied, taskType, tier, ruleId, profile, honored,
    duty, level, skill, via, accountSource, project, projectPath,
    overridesApplied, overridesRejected
  };
  if (account !== undefined) out.account = account;
  return out;
}

// The gateway's `done` SSE event also carries an additive `context` object (S1a /
// D5b): { contextPct, peakContextPct, compactions:{count,last} } for the operative
// session that ran the turn. Fold it into a compact, validated object the engine can
// stamp onto the card's routed event, or null when NOTHING context-related flowed
// (a non-PTY runtime → contextPct null, no compactions). Never
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

// Stop the gateway turn that is provably executing this card. Kanban turns share
// the gateway's fallback conversation key, so the card id is load-bearing: the
// gateway rejects a mismatch instead of cancelling whichever queued turn happens
// to be active. HTTP errors are returned (the board wants to preserve 404 vs 409);
// only network/timeout failures throw as transport errors.
export async function interruptCardTurn(gatewayUrl, cardId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    let res;
    try {
      res = await fetch(`${gatewayUrl}/chat/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-garrison-origin": "channel" },
        body: JSON.stringify({ cardId }),
        signal: ctrl.signal
      });
    } catch (err) {
      const e = new Error(`gateway interrupt unreachable: ${err?.message || err}`);
      e.transport = true;
      throw e;
    }
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// A card's `project` is stored in TWO shapes in the wild: a bare slug
// ("ekoa-code") and an absolute path ("/home/ggomes/dev/ekoa-code") — on a real
// board, both, roughly half and half. The gateway's resolver takes NAMES only
// (resolveProjectName rejects anything containing a slash, since a path could
// escape the dev root), so sending the raw value made every path-shaped card's
// project refused and its turn run in the composition dir.
//
// Normalise to the dev-root child name. Deliberately no filesystem check here:
// the gateway owns the dev root and does the real resolution, and a name it
// cannot resolve is REJECTED and surfaced on the card — never silently accepted.
export function projectNameForRouting(project) {
  const raw = typeof project === "string" ? project.trim() : "";
  if (!raw) return null;
  const name = raw.includes("/") || raw.includes("\\")
    ? raw.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
    : raw;
  if (!name || name === "." || name === ".." || name.startsWith(".")) return null;
  return name;
}

// Explicit run-spec projects are authored as names and must already satisfy the
// gateway's path-free vocabulary. Unlike the top-level legacy card.project field,
// never reinterpret a path/traversal spelling by taking its basename.
export function explicitProjectNameForRouting(project) {
  const raw = typeof project === "string" ? project.trim() : "";
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..") || raw.startsWith(".")) {
    return null;
  }
  return raw;
}

/**
 * The `routing` pin for one card turn (RUN-SPEC-V1) — the card's explicit run spec
 * plus the cwd derived from its project, as ONE object.
 *
 * This is the single place a card's run spec becomes a request body. The batched
 * Test runner goes through gatewayRunFn too, so teaching this function a dimension
 * teaches every card turn at once — the alternative (each caller assembling its own
 * routing) is how `autonomous` ended up wired at both ends and dropped in the
 * middle.
 *
 * The card's own `project` pin WINS over the project label: if the user explicitly
 * chose where this runs, that is the answer, and `card.project` is only a label
 * (on a real board, half slugs and half absolute paths).
 *
 * Returns null when nothing is pinned at all, so an unpinned card's body stays
 * byte-identical to the pre-run-spec shape.
 */
export function cardTurnRouting(card) {
  const spec = card?.routing && typeof card.routing === "object" && !Array.isArray(card.routing) ? card.routing : {};
  const routing = {};
  for (const [field, value] of Object.entries(spec)) {
    if (value === null || value === undefined || value === "") continue;
    routing[field] = value;
  }
  // Normalise whichever project we end up sending: the gateway's resolveProjectName
  // refuses anything containing a slash.
  const explicitProjectPresent = Object.hasOwn(routing, "project");
  const cardProjectPresent = typeof card?.project === "string" && card.project.trim().length > 0;
  const projectWasSpecified = explicitProjectPresent || cardProjectPresent;
  const project = explicitProjectPresent
    ? explicitProjectNameForRouting(routing.project)
    : projectNameForRouting(card?.project);
  if (project) {
    routing.project = project;
  } else if (isPersonalCard(card) && !projectWasSpecified) {
    // Personal is a semantic card scope, not a filesystem path and not a fake
    // project. The exact internal token is resolved by the gateway to its fixed
    // $GARRISON_HOME/personal directory. A real/explicit project above always
    // wins, which keeps scope and project independently editable.
    routing.project = PERSONAL_SCOPE_TOKEN;
    routing.projectDefaulted = true;
  } else {
    delete routing.project;
  }
  return Object.keys(routing).length ? routing : null;
}


// Conversations: the ONE way the board reaches the launcher. Fire-and-forget —
// the gateway 202s and advances in the background; 409 means already advancing
// (idempotent kicks); any transport failure is reported, never thrown, so a
// tick survives a down gateway.
export function conversationKickFn(gatewayUrl) {
  return async ({ conversationId, cardId = null, task = null, title = null }) => {
    try {
      const res = await fetch(`${gatewayUrl}/conversation/kick`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, cardId, task, title })
      });
      if (res.status === 202) return { ok: true, kicked: true };
      if (res.status === 409) return { ok: true, kicked: false, alreadyAdvancing: true };
      return { ok: false, status: res.status, error: (await res.json().catch(() => null))?.error ?? `http ${res.status}` };
    } catch (err) {
      return { ok: false, transport: true, error: err?.message };
    }
  };
}

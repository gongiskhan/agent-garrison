// Garrison compact controller (S1b, brief D1/D2/D5).
//
// Gateway-owned, per-session compaction policy for the claude-code operative PTY.
// It runs ONLY at boundaries (between turns, never mid-turn): the gateway calls
// check() inside its serialized inflight chain after a turn completes, and the
// engine calls it at duty boundaries via POST /compact/boundary. When usage is at
// or over the threshold and no hold/cooldown/native-compaction blocks it, the
// controller injects `/compact <rendered focus>` into the operative and records
// before/after usage.
//
// The decision core (decideCompaction) is pure and unit-tested against the full
// matrix; createCompactController wraps it with per-session state + injected
// effects (usage sampling, transcript compaction reads, /compact injection,
// decision logging) so the live path stays testable without a real PTY.
//
// The native auto-compact backstop is left untouched (E3: it fires near the model
// window, strictly above the 60% default) - the controller watches for a native
// compact_boundary and treats it as the compaction for that cycle rather than
// racing it.

import { renderFocusTemplate, DEFAULT_FOCUS_TEMPLATE, focusDigest } from "./compact-focus-template.mjs";

export const COMPACT_RUNTIMES = ["claude-code", "agent-sdk", "openai-agents", "codex", "opencode"];
export const DEFAULT_THRESHOLD_PCT = 60;
export const COOLDOWN_TURNS = 3;
// Injecting /compact and awaiting the boundary: real compactions run 106-143s
// (E2/E3), far past the 45s default command timeout, so use a generous ceiling.
export const COMPACT_TIMEOUT_MS = 300_000;

function toBool(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return dflt;
}

function toPct(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : dflt;
}

/**
 * Resolve per-runtime compaction config from the gateway env: global scalar
 * defaults (GARRISON_COMPACT_ENABLED / _THRESHOLD_PCT / _FOCUS_TEMPLATE) overlaid
 * by an optional per-runtime override map (GARRISON_COMPACT_CONFIG JSON:
 * { <runtime>: { enabled, threshold_pct, focus_template } }). Every runtime in
 * COMPACT_RUNTIMES gets a fully-defaulted entry, so callers never null-check.
 */
export function resolveCompactConfig(env = process.env) {
  const gEnabled = toBool(env.GARRISON_COMPACT_ENABLED, true);
  const gPct = toPct(env.GARRISON_COMPACT_THRESHOLD_PCT, DEFAULT_THRESHOLD_PCT);
  const gTpl =
    typeof env.GARRISON_COMPACT_FOCUS_TEMPLATE === "string" && env.GARRISON_COMPACT_FOCUS_TEMPLATE.trim()
      ? env.GARRISON_COMPACT_FOCUS_TEMPLATE
      : DEFAULT_FOCUS_TEMPLATE;
  let overrides = {};
  try {
    if (env.GARRISON_COMPACT_CONFIG) overrides = JSON.parse(env.GARRISON_COMPACT_CONFIG) || {};
  } catch {
    overrides = {};
  }
  const out = {};
  for (const rt of COMPACT_RUNTIMES) {
    const o = overrides[rt] && typeof overrides[rt] === "object" ? overrides[rt] : {};
    out[rt] = {
      enabled: toBool(o.enabled, gEnabled),
      thresholdPct: toPct(o.threshold_pct, gPct),
      focusTemplate: typeof o.focus_template === "string" && o.focus_template.trim() ? o.focus_template : gTpl,
    };
  }
  return out;
}

/** Fresh per-session decision state. `lastSeenPct` (S1b-fix1) is the context %
 *  observed at the previous boundary check — the baseline for screen-based native
 *  compaction detection (a sharp spontaneous drop) on PTY sessions, which do not
 *  persist a transcript to count compact_boundary records. */
export function initialCompactState() {
  return { turnCount: 0, lastCompactTurn: -Infinity, armed: true, lastCompactionCount: 0, lastSeenPct: null };
}

// A context-% drop of at least this many points between checks, with no Garrison
// injection in between, reads as a native (auto or manual) compaction on a PTY
// session whose transcript we cannot inspect.
export const NATIVE_PCT_DROP = 15;

/**
 * Pure decision core. Given per-session `state` and `input`, returns
 * { action, nextState } where action is one of:
 *   compact | deferred | skipped-native | skipped-cooldown | none
 *
 * Rules (brief D1/D5, screen-first per S1b-fix1):
 *  - native-race: either a NEW transcript compact_boundary (SDK sessions) OR a
 *    sharp spontaneous context-% drop (`nativeCompacted`, PTY sessions) is treated
 *    AS the compaction - skip and reset cooldown.
 *  - disabled or usage below threshold -> none (usage below threshold re-arms).
 *  - hold active -> deferred (compaction waits for the duty boundary).
 *  - not armed (compacted since the last drop below threshold) -> skipped-cooldown.
 *  - within COOLDOWN_TURNS turns of the last compaction -> skipped-cooldown.
 *  - else -> compact.
 */
export function decideCompaction(state, input) {
  const prev = { ...initialCompactState(), ...state };
  const { usagePct, thresholdPct, enabled, hold, compactionCount, nativeCompacted, turnCount } = input;

  const nativeByCount = typeof compactionCount === "number" && compactionCount > prev.lastCompactionCount;
  if (nativeCompacted === true || nativeByCount) {
    const count = typeof compactionCount === "number" ? Math.max(compactionCount, prev.lastCompactionCount) : prev.lastCompactionCount;
    return {
      action: "skipped-native",
      nextState: { ...prev, lastCompactionCount: count, lastCompactTurn: turnCount, armed: false },
    };
  }
  if (!enabled) return { action: "none", nextState: prev };
  if (typeof usagePct !== "number" || Number.isNaN(usagePct)) return { action: "none", nextState: prev };
  if (usagePct < thresholdPct) return { action: "none", nextState: { ...prev, armed: true } };
  if (hold) return { action: "deferred", nextState: prev };
  if (!prev.armed) return { action: "skipped-cooldown", nextState: prev };
  if (turnCount - prev.lastCompactTurn < COOLDOWN_TURNS) return { action: "skipped-cooldown", nextState: prev };
  return {
    action: "compact",
    nextState: {
      ...prev,
      armed: false,
      lastCompactTurn: turnCount,
      // Provisional: the controller overrides this with the real post-injection
      // count so our OWN compaction never trips the native-race guard next check.
      lastCompactionCount: (typeof compactionCount === "number" ? compactionCount : prev.lastCompactionCount) + 1,
    },
  };
}

/**
 * Build the effectful controller. Dependencies are injected so the live gateway
 * path and unit tests share one implementation:
 *   resolveConfig()          -> per-runtime config map (resolveCompactConfig)
 *   sampleUsage()            -> { contextPct, contextTokens } for the operative
 *   readCompactions()        -> { count, last } from the operative transcript
 *   injectCompact(line, ms)  -> inject `/compact <line>` into the operative (awaits)
 *   logDecision(record)      -> append the decision record (JSONL)
 *   now()                    -> ISO timestamp
 *   contextWindow            -> optional tokens->pct denominator when contextPct is null
 */
export function createCompactController(deps = {}) {
  const resolveConfig = deps.resolveConfig ?? (() => resolveCompactConfig());
  const now = deps.now ?? (() => new Date().toISOString());
  const states = new Map();
  let lastDecision = null;

  const configFor = (runtime) => {
    const cfg = resolveConfig();
    return cfg[runtime] ?? cfg["claude-code"] ?? { enabled: true, thresholdPct: DEFAULT_THRESHOLD_PCT, focusTemplate: DEFAULT_FOCUS_TEMPLATE };
  };

  const usagePctFrom = (usage, window) => {
    if (usage && typeof usage.contextPct === "number") return usage.contextPct;
    if (usage && typeof usage.contextTokens === "number" && window > 0) return (usage.contextTokens / window) * 100;
    return null;
  };

  async function check(opts = {}) {
    const sessionId = opts.sessionId ?? "operative";
    const runtime = opts.runtime ?? "claude-code";
    const boundary = opts.boundary === "duty" ? "duty" : "turn";
    // A duty boundary DISCHARGES holds (brief D1/D5): a held turn defers to here.
    const hold = boundary === "duty" ? false : opts.hold === true;
    const cfg = configFor(runtime);

    const prev = states.get(sessionId) ?? initialCompactState();
    const state = boundary === "turn" ? { ...prev, turnCount: prev.turnCount + 1 } : prev;

    let usage = { contextPct: null, contextTokens: null };
    try {
      usage = (await deps.sampleUsage?.(sessionId)) ?? usage;
    } catch {
      /* sampling failed - treat as unknown usage (no compaction) */
    }
    let compactions = { count: 0, last: null };
    try {
      compactions = (await deps.readCompactions?.(sessionId)) ?? compactions;
    } catch {
      /* transcript unreadable - assume no compactions */
    }
    const usagePct = usagePctFrom(usage, deps.contextWindow ?? 0);

    // Screen-based native-compaction detection (S1b-fix1): a PTY session persists
    // no transcript, so a sharp spontaneous drop since the last check — with no
    // Garrison injection in between (after our own compaction we reset lastSeenPct
    // to the post-compact value, so that drop is never mis-read) — is the native
    // signal. SDK sessions still also get the transcript-count signal below.
    const nativeByPct =
      typeof prev.lastSeenPct === "number" && typeof usagePct === "number" && prev.lastSeenPct - usagePct >= NATIVE_PCT_DROP;

    const decision = decideCompaction(state, {
      usagePct,
      thresholdPct: cfg.thresholdPct,
      enabled: cfg.enabled,
      hold,
      compactionCount: compactions.count,
      nativeCompacted: nativeByPct,
      turnCount: state.turnCount,
    });

    const baseRecord = {
      at: now(),
      boundary,
      sessionId,
      dutyKey: opts.dutyKey ?? null,
      cardId: opts.cardId ?? null,
      beforePct: typeof usagePct === "number" ? usagePct : null,
      beforeTokens: typeof usage.contextTokens === "number" ? usage.contextTokens : null,
    };

    let nextState = decision.nextState;
    let record = null;

    if (decision.action === "compact") {
      const focusText = renderFocusTemplate(cfg.focusTemplate, opts.focusContext ?? {});
      const line = focusDigest(focusText);
      const startedAt = Date.now();
      let injectErr = null;
      let injectOutcome = null;
      try {
        injectOutcome = await deps.injectCompact?.(line, COMPACT_TIMEOUT_MS);
      } catch (err) {
        injectErr = err;
      }
      // claude refuses to compact very young sessions ("Not enough messages to
      // compact.") — observed live on 2.1.209 when one giant paste crosses the
      // threshold on the session's first exchange. That refusal must NOT consume
      // the cooldown: context only grows, so a disarm here would lock the
      // controller out until a below-threshold re-arm that may never come. Log
      // it distinctly and leave the state armed so the next boundary retries.
      const rejectedTooFew = /not enough messages to compact/i.test(
        `${injectOutcome?.reply ?? ""}\n${injectOutcome?.screenTail ?? ""}`
      );
      if (rejectedTooFew) {
        const rejState = {
          ...prev,
          turnCount: decision.nextState.turnCount,
          lastSeenPct: typeof usagePct === "number" ? usagePct : prev.lastSeenPct,
        };
        states.set(sessionId, rejState);
        const rejRecord = {
          ...baseRecord,
          kind: "compact-rejected",
          reason: "too-few-messages",
          durationMs: Date.now() - startedAt,
          focusDigest: line.slice(0, 200),
        };
        lastDecision = rejRecord;
        try {
          await deps.logDecision?.(rejRecord);
        } catch {
          /* logging must never break the chain */
        }
        return { action: "compact-rejected", record: rejRecord };
      }
      // Confirmation is SCREEN-FIRST (S1b-fix1): a PTY operative persists no
      // transcript, so the authoritative signal is the post-compact context %.
      // injectCompact already awaited the turn, so sample once.
      let usageAfter = { contextPct: null, contextTokens: null };
      try {
        usageAfter = (await deps.sampleUsage?.(sessionId)) ?? usageAfter;
      } catch {
        /* ignore */
      }
      const afterPct = typeof usageAfter.contextPct === "number" ? usageAfter.contextPct : null;
      const screenConfirmed = afterPct !== null && typeof usagePct === "number" && (afterPct < usagePct - 5 || afterPct < cfg.thresholdPct);
      // Transcript check is now BEST-EFFORT ENRICHMENT only (SDK sessions / a future
      // claude that journals PTY turns): a new compact_boundary lets us attach real
      // pre/post token counts + duration. A SINGLE read, never a blocking poll and
      // never the sole confirmation — the PTY operative persists no transcript, so a
      // poll would just burn the deadline every compaction.
      let afterCompactions = compactions;
      try {
        const c = await deps.readCompactions?.(sessionId);
        if (c && typeof c.count === "number" && c.count > compactions.count) afterCompactions = c;
      } catch {
        /* transcript unreadable - screen confirmation stands alone */
      }
      const transcriptConfirmed = afterCompactions.count > compactions.count;
      const enrich = transcriptConfirmed && afterCompactions.last && typeof afterCompactions.last === "object" ? afterCompactions.last : null;
      const confirmed = screenConfirmed || transcriptConfirmed;
      nextState = {
        ...decision.nextState,
        lastCompactionCount: Math.max(decision.nextState.lastCompactionCount, afterCompactions.count),
        // Reset the native-detection baseline to the POST-compact value so our own
        // drop is never mis-read as native next check; null (baseline cleared) when
        // the post sample failed, which also suppresses a false native next check.
        lastSeenPct: afterPct,
      };
      record = {
        ...baseRecord,
        kind: confirmed ? "compacted" : "compact-unconfirmed",
        afterPct,
        afterTokens: typeof usageAfter.contextTokens === "number" ? usageAfter.contextTokens : null,
        durationMs: Date.now() - startedAt,
        focusDigest: line.slice(0, 200),
        ...(enrich
          ? {
              preTokens: typeof enrich.preTokens === "number" ? enrich.preTokens : null,
              postTokens: typeof enrich.postTokens === "number" ? enrich.postTokens : null,
              compactDurationMs: typeof enrich.durationMs === "number" ? enrich.durationMs : null,
            }
          : {}),
        ...(injectErr ? { injectError: String(injectErr?.message ?? injectErr) } : {}),
      };
    } else if (decision.action === "deferred") {
      record = { ...baseRecord, kind: "deferred" };
      nextState = { ...decision.nextState, lastSeenPct: typeof usagePct === "number" ? usagePct : prev.lastSeenPct };
    } else if (decision.action === "skipped-native") {
      // beforePct is the PRE-native value we last saw; afterPct is the current low.
      record = {
        ...baseRecord,
        kind: "skipped-native",
        beforePct: typeof prev.lastSeenPct === "number" ? prev.lastSeenPct : baseRecord.beforePct,
        afterPct: typeof usagePct === "number" ? usagePct : null,
        detectedBy: nativeByPct ? "screen" : "transcript",
        compactionCount: compactions.count,
      };
      nextState = { ...decision.nextState, lastSeenPct: typeof usagePct === "number" ? usagePct : prev.lastSeenPct };
    } else if (decision.action === "skipped-cooldown") {
      record = { ...baseRecord, kind: "skipped-cooldown" };
      nextState = { ...decision.nextState, lastSeenPct: typeof usagePct === "number" ? usagePct : prev.lastSeenPct };
    } else {
      // action === "none": still advance the native-detection baseline.
      nextState = { ...decision.nextState, lastSeenPct: typeof usagePct === "number" ? usagePct : prev.lastSeenPct };
    }

    states.set(sessionId, nextState);
    if (record) {
      lastDecision = record;
      try {
        await deps.logDecision?.(record);
      } catch {
        /* logging must never break the boundary check */
      }
    }
    return { action: decision.action, record };
  }

  return {
    check,
    getLastDecision: () => lastDecision,
    // Testing / introspection helpers.
    _state: (sessionId = "operative") => states.get(sessionId) ?? initialCompactState(),
    _resetState: (sessionId = "operative") => states.delete(sessionId),
  };
}

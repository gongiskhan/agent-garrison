// Smart-endpointing pure logic — the adaptive grace window formula and the
// /api/endpointing config coercion — extracted from main.tsx so it's unit-tested
// (a wrong window sends mid-thought or hangs the turn).

export type EpCfg = {
  redemptionMs: number; minMs: number; maxMs: number;
  bargeinProb: number; bargeinConfirmMs: number; idleTimeoutMs: number;
};

// Defaults MUST match scripts/server.mjs handleEndpointing so an unconfigured
// composition behaves identically whether or not /api/endpointing answers.
export const EP_DEFAULTS: EpCfg = {
  redemptionMs: 550, minMs: 350, maxMs: 2600,
  bargeinProb: 0.55, bargeinConfirmMs: 350, idleTimeoutMs: 90_000
};

// The adaptive grace window after a tentative end-of-speech: a finished-sounding
// transcript (eot→1) waits ~minMs; a mid-thought one (eot→0) waits up to ~maxMs.
// eot null/unknown → a neutral 0.5. eot is clamped to [0,1] so a bad value can't
// push the window outside [minMs, maxMs].
export function graceWindowMs(eot: number | null | undefined, cfg: Pick<EpCfg, "minMs" | "maxMs">): number {
  const e = typeof eot === "number" && Number.isFinite(eot) ? Math.max(0, Math.min(1, eot)) : 0.5;
  return cfg.minMs + (cfg.maxMs - cfg.minMs) * (1 - e);
}

// Coerce the /api/endpointing payload into a valid EpCfg, falling back per-field
// (positive for durations, 0..1 for the barge-in probability, non-negative for
// the barge-in-confirm and idle-timeout which accept 0 = disabled).
export function coerceEpCfg(j: any, defaults: EpCfg = EP_DEFAULTS): EpCfg {
  const posNum = (v: unknown, d: number) => (Number(v) > 0 ? Number(v) : d);
  const prob = (v: unknown, d: number) => (Number(v) > 0 && Number(v) <= 1 ? Number(v) : d);
  const nonNeg = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    redemptionMs: posNum(j?.redemptionMs, defaults.redemptionMs),
    minMs: posNum(j?.minMs, defaults.minMs),
    maxMs: posNum(j?.maxMs, defaults.maxMs),
    bargeinProb: prob(j?.bargeinProb, defaults.bargeinProb),
    bargeinConfirmMs: nonNeg(j?.bargeinConfirmMs, defaults.bargeinConfirmMs),
    idleTimeoutMs: nonNeg(j?.idleTimeoutMs, defaults.idleTimeoutMs)
  };
}

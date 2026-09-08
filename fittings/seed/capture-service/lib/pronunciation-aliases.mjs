// Post-ASR pronunciation correction.
//
// stt_keyterms (deepgram-live.mjs, deepgram-rest.mjs) BIASES Deepgram toward a
// word - it lifts the odds, it does not guarantee them. This is the other
// half of the same fix, applied after the fact: known misheard renderings of
// a target word are matched, word-boundary and case-insensitive exactly like
// wake.mjs's wakeRegex, and rewritten to the canonical spelling before a
// transcript is stored or read by the wake bus. Same token-boundary approach
// as DEFAULT_WAKE_VARIANTS, kept as a separate module because this one runs
// on every transcript, not just the wake head.

function escapeVariant(v) {
  return v
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "[\\s-]+");
}

export function aliasRegex(variants) {
  const escaped = (variants ?? []).map(escapeVariant).filter((v) => v.length > 0);
  if (escaped.length === 0) return null;
  // Global (unlike wakeRegex): every occurrence in the segment gets fixed, not
  // just a first hit tested with .test().
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

// { CANONICAL: [variant, ...] } -> text with every variant occurrence rewritten
// to its canonical spelling. Canonical wins outright (no case-preservation):
// these are brand/name spellings, not prose the transcript is trying to keep
// verbatim.
export function applyAliases(text, aliasMap) {
  let out = String(text ?? "");
  if (!out || !aliasMap) return out;
  for (const [canonical, variants] of Object.entries(aliasMap)) {
    const regex = aliasRegex(variants);
    if (!regex) continue;
    out = out.replace(regex, canonical);
  }
  return out;
}

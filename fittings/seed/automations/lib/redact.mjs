// Secret-value redaction for run records + emitted events. The engine injects a
// connector's scoped auth (api key / OAuth token) into a step's env; a step
// result, stdout, or error could echo it. We accumulate every injected value
// during a run and scrub it from anything persisted or emitted, so a secret
// never lands in a run record on disk or in the SSE stream.

export const REDACTED = "***REDACTED***";

export function redactString(text, values) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const v of values) {
    if (v && v.length >= 1 && out.includes(v)) out = out.split(v).join(REDACTED);
  }
  return out;
}

// Deep-redact every string in a value against a Set/array of secret values.
export function redactDeep(value, values) {
  const list = [...values].filter(Boolean).sort((a, b) => b.length - a.length);
  const walk = (v) => {
    if (typeof v === "string") return redactString(v, list);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

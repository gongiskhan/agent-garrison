// Template-variable interpolation for automation steps. Supports
// {{input.NAME}} (automation inputs), {{capture.NAME}} (prior step results),
// and {{event.PATH}} (the trigger event payload), with dotted deep paths.

function getPath(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Interpolate a single string against { input, capture, event }. Unknown refs
// resolve to "" (an absent input shouldn't inject the literal placeholder).
export function interpolate(template, scope) {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, p) => {
    const v = getPath(scope, p);
    return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

// Recursively interpolate every string in a value (objects, arrays, scalars).
export function interpolateDeep(value, scope) {
  if (typeof value === "string") return interpolate(value, scope);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, scope));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateDeep(v, scope);
    return out;
  }
  return value;
}

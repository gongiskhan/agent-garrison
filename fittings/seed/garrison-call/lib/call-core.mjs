// call-core.mjs — the single-shot call engine for garrison-call.
//
// Pure request construction + response extraction + a minimal JSON-schema
// validator, plus a thin `runCall` that performs the one HTTP round-trip. NO tool
// loop, NO session, NO streaming — one request, one response, done.
//
// Secrets: the auth token is placed in a request header only, never interpolated
// into a prompt/body/error. Error strings returned to callers are scrubbed of any
// header material by construction (they carry status + a bounded server-body
// snippet + our own messages, none of which include the token).

import { resolveTarget, resolveAuthToken, assertModelAllowed, ShapeError } from "./providers.mjs";

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 60000;
const ANTHROPIC_VERSION = "2023-06-01";

// ── Message / prompt normalization ───────────────────────────────────────────
// A spec carries either `prompt` (a string) or `messages` ([{role, content}]).
// Chat shapes want messages; the Ollama native shape wants a single prompt string.

function toMessages(spec) {
  if (Array.isArray(spec.messages) && spec.messages.length) {
    return spec.messages.map((m) => ({ role: String(m.role || "user"), content: String(m.content ?? "") }));
  }
  if (typeof spec.prompt === "string") return [{ role: "user", content: spec.prompt }];
  throw new Error("spec must carry a `prompt` string or a non-empty `messages` array");
}

function toPromptString(spec) {
  if (typeof spec.prompt === "string") return spec.prompt;
  if (Array.isArray(spec.messages) && spec.messages.length) {
    return spec.messages.map((m) => `${String(m.role || "user")}: ${String(m.content ?? "")}`).join("\n\n");
  }
  throw new Error("spec must carry a `prompt` string or a non-empty `messages` array");
}

// When a schema is requested, every shape also gets an explicit instruction so a
// model without native structured-output support still returns bare JSON.
function schemaInstruction(schema) {
  return (
    "You must respond with ONLY a single JSON object that conforms to this JSON schema. " +
    "Do not include any prose, explanation, or markdown code fences.\nSchema:\n" +
    JSON.stringify(schema)
  );
}

function withSchemaSystem(spec) {
  const base = typeof spec.system === "string" ? spec.system.trim() : "";
  if (!spec.schema) return base || undefined;
  return [base, schemaInstruction(spec.schema)].filter(Boolean).join("\n\n");
}

// ── Per-shape request builders ───────────────────────────────────────────────
// Each returns { url, headers, body } — pure, no fetch, no env.

export function buildRequest(spec, target, token) {
  const model = assertModelAllowed(spec.model);
  const maxTokens = Number.isFinite(spec.maxTokens) ? spec.maxTokens : DEFAULT_MAX_TOKENS;
  const system = withSchemaSystem(spec);

  if (spec.shape === "anthropic") {
    const body = { model, max_tokens: maxTokens, messages: toMessages(spec) };
    if (system) body.system = system;
    return {
      url: `${target.baseUrl}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": token
      },
      body
    };
  }

  if (spec.shape === "openai") {
    const messages = toMessages(spec);
    if (system) messages.unshift({ role: "system", content: system });
    const body = { model, messages, max_tokens: maxTokens, stream: false };
    // OpenAI-compatible JSON mode (json_object is the broadly-supported form;
    // the schema instruction above carries the actual shape).
    if (spec.schema) body.response_format = { type: "json_object" };
    return {
      url: `${target.baseUrl}/v1/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body
    };
  }

  if (spec.shape === "ollama") {
    const body = { model, prompt: toPromptString(spec), stream: false, options: { num_predict: maxTokens } };
    if (system) body.system = system;
    // Ollama native structured output: `format` accepts a full JSON schema.
    if (spec.schema) body.format = spec.schema;
    return {
      url: `${target.baseUrl}/api/generate`,
      headers: { "content-type": "application/json" },
      body
    };
  }

  throw new ShapeError(spec.shape);
}

// ── Per-shape response extraction ────────────────────────────────────────────
// Returns { text, usage } from the shape-specific JSON envelope.

export function extractResponse(shape, json) {
  if (shape === "anthropic") {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    const text = blocks
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    const u = json?.usage || {};
    return { text, usage: { inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null } };
  }
  if (shape === "openai") {
    const text = json?.choices?.[0]?.message?.content ?? "";
    const u = json?.usage || {};
    return {
      text: typeof text === "string" ? text : "",
      usage: { inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null }
    };
  }
  if (shape === "ollama") {
    return {
      text: typeof json?.response === "string" ? json.response : "",
      usage: { inputTokens: json?.prompt_eval_count ?? null, outputTokens: json?.eval_count ?? null }
    };
  }
  throw new ShapeError(shape);
}

// ── Structured output: parse + minimal schema validation ─────────────────────

// Tolerant JSON extraction: strips ```json fences and, failing a direct parse,
// falls back to the first {...} / [...] span.
export function parseJson(text) {
  const stripped = String(text)
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.search(/[[{]/);
    const end = Math.max(stripped.lastIndexOf("}"), stripped.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1));
    }
    throw new Error("model output is not valid JSON");
  }
}

function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v; // string | number | boolean | object
}

function typeMatches(expected, value) {
  const actual = jsonType(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

// Minimal structural validator: enough to prove a schema-constrained parse. Checks
// `type`, `required`, and each declared property's `type` (recursing into object
// properties + array `items`). Returns an array of error strings ([] = valid).
export function validateAgainstSchema(value, schema, path = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected type ${schema.type}, got ${jsonType(value)}`);
    return errors; // a wrong container type makes deeper checks meaningless
  }

  // enum / const value constraints (codex S2b finding: schema-violating output
  // like {status:"bad"} against enum:["ok"] was returned as ok:true). Compared
  // by JSON identity so objects/arrays in an enum work.
  if (Array.isArray(schema.enum)) {
    const target = JSON.stringify(value);
    if (!schema.enum.some((allowed) => JSON.stringify(allowed) === target)) {
      errors.push(`${path}: value ${target} is not one of enum ${JSON.stringify(schema.enum)}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      errors.push(`${path}: value must equal const ${JSON.stringify(schema.const)}`);
    }
  }

  if ((schema.type === "object" || (!schema.type && schema.properties)) && value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}: missing required property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateAgainstSchema(value[key], sub, `${path}.${key}`));
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, `${path}[${i}]`)));
  }

  return errors;
}

// ── The one round-trip ───────────────────────────────────────────────────────

// runCall(spec, opts) -> { ok, text|structured, usage?, error? }. Never throws for
// operational failures (fence, missing key, network, non-2xx, bad JSON) — those
// come back as { ok:false, error } with a secret-free message. `opts.env` and
// `opts.fetch` are injectable for tests.
export async function runCall(spec = {}, opts = {}) {
  const env = opts.env || process.env;
  const doFetch = opts.fetch || globalThis.fetch;
  const timeoutMs = Number.isFinite(spec.timeoutMs) ? spec.timeoutMs : DEFAULT_TIMEOUT_MS;

  let target;
  let token;
  let req;
  try {
    target = resolveTarget(spec); // default-deny fence
    token = resolveAuthToken(target, env); // by vault name, never logged
    req = buildRequest(spec, target, token);
  } catch (err) {
    return { ok: false, error: scrub(err?.message || String(err)) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") return { ok: false, error: `request timed out after ${timeoutMs}ms` };
    return { ok: false, error: `request failed: ${scrub(err?.message || String(err), token)}` };
  }

  // Read the body BEFORE clearing the timeout (codex S2b finding: an endpoint
  // that sends headers then hangs the body must still abort at timeoutMs — the
  // AbortController is wired to fetch, and res.text() rejects with AbortError on
  // abort). Clearing early left runCall pending forever.
  let raw;
  try {
    raw = await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") return { ok: false, error: `request timed out after ${timeoutMs}ms` };
    return { ok: false, error: `reading response failed: ${scrub(err?.message || String(err), token)}` };
  }
  clearTimeout(timer);

  if (!res.ok) {
    return { ok: false, error: `provider returned HTTP ${res.status}: ${scrub(raw, token).slice(0, 400)}` };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: `provider returned non-JSON body: ${scrub(raw, token).slice(0, 200)}` };
  }

  const { text, usage } = extractResponse(spec.shape, json);

  if (spec.schema) {
    let parsed;
    try {
      parsed = parseJson(text);
    } catch (err) {
      return { ok: false, error: `structured output parse failed: ${scrub(err?.message || String(err), token)}`, usage };
    }
    const schemaErrors = validateAgainstSchema(parsed, spec.schema);
    if (schemaErrors.length) {
      return { ok: false, error: `structured output failed schema validation: ${schemaErrors.join("; ")}`, usage };
    }
    return { ok: true, structured: parsed, usage };
  }

  return { ok: true, text, usage };
}

// Defense-in-depth: strip any accidental secret echo from a message. Beyond the
// Bearer/x-api-key header shapes, redact the ACTUAL resolved token value literally
// (codex S2b finding: a provider's 401 body can echo an unprefixed raw key, which
// the pattern scrubbers miss) — the literal value is the only reliable catch.
function scrub(message, token) {
  let out = String(message)
    .replace(/Bearer\s+[\w.\-]+/gi, "Bearer [redacted]")
    .replace(/x-api-key["'\s:=]+[\w.\-]+/gi, "x-api-key [redacted]");
  if (token && typeof token === "string" && token.length >= 6) {
    out = out.split(token).join("[redacted]");
  }
  return out;
}

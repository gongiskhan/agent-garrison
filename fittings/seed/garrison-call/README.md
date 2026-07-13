# garrison-call

Single-shot, structured LLM calls for Garrison. **One request, one response, never
a primary** — no tool loop, no session, no streaming. This is the call target the
Dispatcher duty cells and (in a later slice) the probe-question cell resolve to.

## What it is

A script consumed by name. It exposes **no capability provision**: none of the
existing `capabilityKinds` fits a non-agentic single-shot caller, and declaring
`kind: runtime` (the closest) would wrongly make it primary-/agentic-cell-eligible.
Consumers invoke `scripts/call.mjs` directly.

## Interface

```
echo '<spec_json>' | node scripts/call.mjs      # spec via STDIN (never argv)
node scripts/call.mjs --probe                    # read-only self-test, prints "ok"
```

### Spec (STDIN JSON)

```jsonc
{
  "shape": "anthropic | openai | ollama",   // wire protocol
  "provider": "ollama-local",                // OR an explicit "baseUrl"
  "baseUrl": "http://localhost:11434",       // allowed only if listed or loopback (ollama/openai)
  "model": "qwen2.5:3b",
  "prompt": "…",                             // OR "messages": [{ "role": "...", "content": "..." }]
  "system": "…",                             // optional system prompt
  "schema": { "type": "object", "…": "…" },  // present ⇒ STRUCTURED (parsed + validated)
  "timeoutMs": 60000,
  "maxTokens": 1024
}
```

### Result (STDOUT JSON)

```jsonc
{ "ok": true, "text": "…" }                        // unstructured
{ "ok": true, "structured": { … }, "usage": { … } } // schema-validated
{ "ok": false, "error": "…" }                       // fence / missing-key / network / non-2xx — secret-free
```

## Wire shapes

| shape      | endpoint                          | notes                                        |
|------------|-----------------------------------|----------------------------------------------|
| `anthropic`| `POST {baseUrl}/v1/messages`      | Anthropic Messages API                       |
| `openai`   | `POST {baseUrl}/v1/chat/completions` | OpenAI-compatible Chat Completions        |
| `ollama`   | `POST {baseUrl}/api/generate`     | Ollama native; native structured via `format`|

## Default-deny base-URL fence

A call may only reach a base URL that is **either** an exact entry in the named
provider table (`lib/providers.mjs`) **or** an explicit loopback URL (`localhost` /
`127.0.0.1` / `::1`) and only for the `ollama` / `openai` shapes. Every other base
URL is rejected loudly. There is **no** wildcard / configurable entry (this fitting
deliberately drops the agent-sdk-runtime `llm-proxy` escape hatch). Extend the
allowlist only by adding an explicit table entry.

## Secrets

Provider keys are resolved from the environment **by vault name** (`authTokenEnv`
per provider) — never hardcoded, never returned, never logged. A missing key names
the env var, not its value. Loopback (Ollama) endpoints need no key.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// S2b — garrison-call request/response wiring, deterministic (injected fetch, no
// network). Asserts each of the three wire shapes builds the correct URL + headers
// + body and extracts the reply, that structured calls set the native structured
// knob and validate the parse, and that non-2xx / timeout come back as clean
// { ok:false } results. Runs regardless of whether Ollama is up.
const REPO = path.resolve(__dirname, "..");
const CALL_CORE = path.join(REPO, "fittings/seed/garrison-call/lib/call-core.mjs");
const core = await import(pathToFileURL(CALL_CORE).href);

// A fetch stub that records the request and returns a shape-appropriate envelope.
function stubFetch(responderByPath: Record<string, { status?: number; json?: unknown; body?: string }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fn = async (url: string, opts: any) => {
    const u = new URL(url);
    const rec = responderByPath[u.pathname];
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const status = rec?.status ?? 200;
    const text = rec?.body ?? JSON.stringify(rec?.json ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text
    };
  };
  return { fn, calls };
}

describe("garrison-call wire shapes (mocked fetch)", () => {
  it("anthropic shape → POST /v1/messages with x-api-key + anthropic-version", async () => {
    const { fn, calls } = stubFetch({
      "/v1/messages": { json: { content: [{ type: "text", text: "pong" }], usage: { input_tokens: 5, output_tokens: 1 } } }
    });
    const res = await core.runCall(
      { shape: "anthropic", provider: "ollama-local", model: "qwen2.5:3b", prompt: "ping" },
      { fetch: fn }
    );
    expect(res).toEqual({ ok: true, text: "pong", usage: { inputTokens: 5, outputTokens: 1 } });
    expect(calls[0].url).toBe("http://localhost:11434/v1/messages");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].headers["x-api-key"]).toBeTruthy();
    expect(calls[0].body.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("openai shape → POST /v1/chat/completions with Bearer auth", async () => {
    const { fn, calls } = stubFetch({
      "/v1/chat/completions": {
        json: { choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }
      }
    });
    const res = await core.runCall(
      { shape: "openai", provider: "ollama-local", model: "qwen2.5:3b", prompt: "ping" },
      { fetch: fn }
    );
    expect(res.ok).toBe(true);
    expect(res.text).toBe("pong");
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0].headers.authorization).toMatch(/^Bearer /);
    expect(calls[0].body.stream).toBe(false);
  });

  it("ollama shape → POST /api/generate, no auth header", async () => {
    const { fn, calls } = stubFetch({
      "/api/generate": { json: { response: "pong", prompt_eval_count: 5, eval_count: 1 } }
    });
    const res = await core.runCall(
      { shape: "ollama", provider: "ollama-local", model: "qwen2.5:3b", prompt: "ping" },
      { fetch: fn }
    );
    expect(res.ok).toBe(true);
    expect(res.text).toBe("pong");
    expect(calls[0].url).toBe("http://localhost:11434/api/generate");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].headers["x-api-key"]).toBeUndefined();
    expect(calls[0].body.prompt).toBe("ping");
  });

  it("system prompt + messages array are threaded per shape", async () => {
    const { fn, calls } = stubFetch({
      "/v1/chat/completions": { json: { choices: [{ message: { content: "ok" } }] } }
    });
    await core.runCall(
      {
        shape: "openai",
        provider: "ollama-local",
        model: "qwen2.5:3b",
        system: "be terse",
        messages: [{ role: "user", content: "hi" }]
      },
      { fetch: fn }
    );
    expect(calls[0].body.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(calls[0].body.messages[1]).toEqual({ role: "user", content: "hi" });
  });
});

describe("garrison-call structured (mocked fetch)", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"]
  };

  it("ollama structured sets body.format = schema and returns a validated object", async () => {
    const { fn, calls } = stubFetch({
      "/api/generate": { json: { response: '{"name":"Alice","age":30}' } }
    });
    const res = await core.runCall(
      { shape: "ollama", provider: "ollama-local", model: "qwen2.5:3b", prompt: "Alice is 30", schema },
      { fetch: fn }
    );
    expect(res).toMatchObject({ ok: true, structured: { name: "Alice", age: 30 } });
    expect(calls[0].body.format).toEqual(schema);
  });

  it("openai structured sets response_format json_object and validates", async () => {
    const { fn, calls } = stubFetch({
      "/v1/chat/completions": { json: { choices: [{ message: { content: '```json\n{"name":"Bob","age":42}\n```' } }] } }
    });
    const res = await core.runCall(
      { shape: "openai", provider: "ollama-local", model: "qwen2.5:3b", prompt: "Bob is 42", schema },
      { fetch: fn }
    );
    expect(res).toMatchObject({ ok: true, structured: { name: "Bob", age: 42 } });
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
  });

  it("a structured reply that violates the schema comes back as ok:false", async () => {
    const { fn } = stubFetch({
      "/api/generate": { json: { response: '{"name":"Alice"}' } } // missing required age
    });
    const res = await core.runCall(
      { shape: "ollama", provider: "ollama-local", model: "qwen2.5:3b", prompt: "x", schema },
      { fetch: fn }
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/schema validation/i);
  });
});

describe("garrison-call failure paths (mocked fetch)", () => {
  it("a non-2xx status returns ok:false with the status and a bounded body", async () => {
    const { fn } = stubFetch({ "/api/generate": { status: 500, body: "internal boom" } });
    const res = await core.runCall(
      { shape: "ollama", provider: "ollama-local", model: "qwen2.5:3b", prompt: "x" },
      { fetch: fn }
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/HTTP 500/);
  });

  it("a timeout aborts and returns ok:false", async () => {
    const hangFetch = (_url: string, opts: any) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const res = await core.runCall(
      { shape: "ollama", provider: "ollama-local", model: "qwen2.5:3b", prompt: "x", timeoutMs: 20 },
      { fetch: hangFetch as any }
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out after 20ms/);
  });

  it("a non-JSON 2xx body returns ok:false", async () => {
    const { fn } = stubFetch({ "/api/generate": { body: "<html>not json</html>" } });
    const res = await core.runCall(
      { shape: "ollama", provider: "ollama-local", model: "qwen2.5:3b", prompt: "x" },
      { fetch: fn }
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/non-JSON/i);
  });
});

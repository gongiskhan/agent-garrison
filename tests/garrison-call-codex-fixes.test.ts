import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// S2b codex-slice regressions (3 real findings): (1) an unprefixed raw API key
// echoed in a provider 401 body must be redacted from the returned error; (2)
// enum/const schema constraints must fail validation, not pass through; (3) a
// hung response body must still abort at timeoutMs rather than leaving runCall
// pending. Deterministic — injected env + fetch, no network.
const REPO = path.resolve(__dirname, "..");
const CALL_CORE = path.join(REPO, "fittings/seed/garrison-call/lib/call-core.mjs");
const core = await import(pathToFileURL(CALL_CORE).href);
const providers = await import(
  pathToFileURL(path.join(REPO, "fittings/seed/garrison-call/lib/providers.mjs")).href
);

describe("garrison-call codex S2b finding 1 — secret redaction in error bodies", () => {
  it("redacts the literal token from a non-2xx body even when unprefixed", async () => {
    const SECRET = "sk-secret-with-plus+slash/equals=";
    const fn = async () => ({
      ok: false,
      status: 401,
      text: async () => `invalid api key ${SECRET}`
    });
    const res = await core.runCall(
      { shape: "openai", provider: "openai", model: "gpt-4o-mini", prompt: "x" },
      { fetch: fn as never, env: { OPENAI_API_KEY: SECRET } }
    );
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain(SECRET);
    expect(res.error).toContain("[redacted]");
    expect(res.error).toContain("HTTP 401");
  });
});

describe("garrison-call codex S2b finding 2 — enum/const validation", () => {
  it("fails a value outside an enum constraint", async () => {
    const fn = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ response: JSON.stringify({ status: "bad" }) })
    });
    const res = await core.runCall(
      {
        shape: "ollama",
        provider: "ollama-local",
        model: "x",
        prompt: "x",
        schema: { type: "object", properties: { status: { type: "string", enum: ["ok"] } }, required: ["status"] }
      },
      { fetch: fn as never }
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/enum/);
  });

  it("passes a value that satisfies the enum", async () => {
    const fn = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ response: JSON.stringify({ status: "ok" }) })
    });
    const res = await core.runCall(
      {
        shape: "ollama",
        provider: "ollama-local",
        model: "x",
        prompt: "x",
        schema: { type: "object", properties: { status: { type: "string", enum: ["ok"] } }, required: ["status"] }
      },
      { fetch: fn as never }
    );
    expect(res.ok).toBe(true);
    expect(res.structured).toEqual({ status: "ok" });
  });

  it("enforces a const constraint", () => {
    const errs = core.validateAgainstSchema({ v: 2 }, { type: "object", properties: { v: { const: 1 } } });
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe("garrison-call S2b review finding — no key egress via baseUrl override", () => {
  it("drops the provider credential when baseUrl overrides the provider's pinned host", async () => {
    const SECRET = "sk-real-openai-key";
    let sentAuth: string | undefined;
    const fn = async (_url: string, opts: any) => {
      sentAuth = opts.headers.authorization || opts.headers["x-api-key"];
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "x" } }] }) };
    };
    // Attacker-authored spec: real keyed provider + override to a loopback port.
    const res = await core.runCall(
      { shape: "openai", provider: "openai", baseUrl: "http://127.0.0.1:9999", model: "gpt-4o-mini", prompt: "x" },
      { fetch: fn as never, env: { OPENAI_API_KEY: SECRET } }
    );
    expect(res.ok).toBe(true);
    // The real key must NOT have been sent to the overridden loopback endpoint.
    expect(sentAuth ?? "").not.toContain(SECRET);
  });

  it("keeps the credential when the override resolves back to the provider's own URL", () => {
    const t = providers.resolveTarget({
      shape: "openai",
      provider: "openai",
      baseUrl: providers.PROVIDERS?.openai?.baseUrl
    });
    // Same host → provider auth retained (needsKey stays true for openai).
    expect(t.provider).toBe("openai");
  });
});

describe("garrison-call codex S2b finding 3 — hung body aborts at timeout", () => {
  it("aborts when the response body never resolves", async () => {
    // fetch resolves headers, but res.text() hangs; the AbortController wired to
    // fetch must reject text() with AbortError once the timer fires.
    const fn = async (_url: string, opts: any) =>
      ({
        ok: true,
        status: 200,
        text: () =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          })
      }) as never;
    const res = await core.runCall(
      { shape: "ollama", provider: "ollama-local", model: "x", prompt: "x", timeoutMs: 30 },
      { fetch: fn }
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/);
  });
});

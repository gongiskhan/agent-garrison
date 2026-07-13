import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// S2b — garrison-call default-deny base-URL fence + secret hygiene. Pure unit
// tests (no network): the fence, auth-by-vault-name resolution, the model
// allowlist, the minimal schema validator, and the guarantee that no error path
// leaks a secret VALUE.
const REPO = path.resolve(__dirname, "..");
const PROVIDERS = path.join(REPO, "fittings/seed/garrison-call/lib/providers.mjs");
const CALL_CORE = path.join(REPO, "fittings/seed/garrison-call/lib/call-core.mjs");

const providers = await import(pathToFileURL(PROVIDERS).href);
const core = await import(pathToFileURL(CALL_CORE).href);

describe("garrison-call fence — resolveTarget default-deny", () => {
  it("resolves a listed provider to its exact base URL for every shape it serves", () => {
    for (const shape of ["anthropic", "openai", "ollama"]) {
      const t = providers.resolveTarget({ shape, provider: "ollama-local", model: "qwen2.5:3b" });
      expect(t.baseUrl).toBe("http://localhost:11434");
      expect(t.needsKey).toBe(false);
    }
    const a = providers.resolveTarget({ shape: "anthropic", provider: "anthropic", model: "x" });
    expect(a.baseUrl).toBe("https://api.anthropic.com");
    expect(a.needsKey).toBe(true);
    expect(a.authTokenEnv).toBe("ANTHROPIC_API_KEY");
  });

  it("REJECTS an unknown provider loudly", () => {
    expect(() => providers.resolveTarget({ shape: "anthropic", provider: "made-up", model: "x" })).toThrow(
      /unknown provider/i
    );
  });

  it("REJECTS an unlisted, non-loopback base URL loudly (default-deny)", () => {
    expect(() => providers.resolveTarget({ shape: "openai", baseUrl: "https://evil.example.com", model: "x" })).toThrow(
      /not in the garrison-call allowlist and is not loopback/i
    );
  });

  it("allows a loopback base URL for the ollama and openai shapes", () => {
    for (const shape of ["ollama", "openai"]) {
      const t = providers.resolveTarget({ shape, baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:3b" });
      expect(t.baseUrl).toBe("http://127.0.0.1:11434");
      expect(t.needsKey).toBe(false);
    }
  });

  it("DENIES a loopback base URL for the anthropic shape unless it is a listed entry", () => {
    expect(() => providers.resolveTarget({ shape: "anthropic", baseUrl: "http://localhost:9999", model: "x" })).toThrow(
      /permitted only for the ollama\/openai shapes/i
    );
    // ...but the listed ollama-local entry DOES serve the anthropic shape.
    const ok = providers.resolveTarget({ shape: "anthropic", provider: "ollama-local", model: "x" });
    expect(ok.baseUrl).toBe("http://localhost:11434");
  });

  it("REJECTS a shape a provider does not serve", () => {
    expect(() => providers.resolveTarget({ shape: "anthropic", provider: "openai", model: "x" })).toThrow(
      /does not serve the "anthropic" shape/i
    );
  });

  it("REJECTS a spec with neither provider nor baseUrl", () => {
    expect(() => providers.resolveTarget({ shape: "ollama", model: "x" })).toThrow(/no target/i);
  });

  it("REJECTS an unknown shape", () => {
    expect(() => providers.resolveTarget({ shape: "grpc", provider: "ollama-local", model: "x" })).toThrow(
      /unknown call shape/i
    );
  });

  it("an https remote can never be mistaken for the loopback dev endpoint", () => {
    // Same port as ollama, but a remote host + TLS → still denied.
    expect(() => providers.resolveTarget({ shape: "ollama", baseUrl: "https://11434.example.com", model: "x" })).toThrow(
      /default-deny/i
    );
  });
});

describe("garrison-call secrets — resolved by vault NAME, never leaked", () => {
  it("resolveAuthToken reads the token from env by its vault name", () => {
    const t = providers.resolveTarget({ shape: "anthropic", provider: "anthropic", model: "x" });
    const token = providers.resolveAuthToken(t, { ANTHROPIC_API_KEY: "sk-secret-value" });
    expect(token).toBe("sk-secret-value");
  });

  it("a missing key names the env var, NEVER the value", () => {
    const t = providers.resolveTarget({ shape: "anthropic", provider: "anthropic", model: "x" });
    try {
      providers.resolveAuthToken(t, {}); // no key present
      throw new Error("expected MissingKeyError");
    } catch (err: any) {
      expect(err.name).toBe("MissingKeyError");
      expect(err.envName).toBe("ANTHROPIC_API_KEY");
      expect(err.message).toContain("ANTHROPIC_API_KEY");
      // structurally, there is no value to leak — but assert the shape anyway
      expect(err.message).not.toContain("sk-");
    }
  });

  it("keyless (loopback) endpoints get a dummy token, not a real secret", () => {
    const t = providers.resolveTarget({ shape: "ollama", provider: "ollama-local", model: "x" });
    expect(providers.resolveAuthToken(t, {})).toBe("ollama");
  });

  it("runCall never places a secret VALUE in an error string", async () => {
    const SECRET = "sk-super-secret-DO-NOT-LEAK-42";
    // Force a network failure so the error path runs, while the secret is in env.
    const failFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await core.runCall(
      { shape: "anthropic", provider: "anthropic", model: "claude-3-5-haiku", prompt: "hi" },
      { env: { ANTHROPIC_API_KEY: SECRET }, fetch: failFetch }
    );
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain(SECRET);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });
});

describe("garrison-call model allowlist", () => {
  it("accepts real model strings", () => {
    expect(providers.assertModelAllowed("qwen2.5:3b")).toBe("qwen2.5:3b");
    expect(providers.assertModelAllowed("claude-3-5-haiku-20241022")).toBeTruthy();
  });
  it("rejects a model string carrying whitespace / newlines / control chars / over-length", () => {
    // The endpoint fence lives on baseUrl; the model only lands in the request
    // body, so a slash/colon model (a tag) is fine — but whitespace, newlines,
    // control chars, an empty string, or an over-long value are rejected.
    expect(() => providers.assertModelAllowed("a b")).toThrow();
    expect(() => providers.assertModelAllowed("bad\nname")).toThrow();
    expect(() => providers.assertModelAllowed("")).toThrow();
    expect(() => providers.assertModelAllowed("x".repeat(129))).toThrow();
    expect(() => providers.assertModelAllowed(123 as unknown as string)).toThrow();
  });
});

describe("garrison-call structured helpers", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"]
  };

  it("validateAgainstSchema passes a conforming object", () => {
    expect(core.validateAgainstSchema({ name: "Alice", age: 30 }, schema)).toEqual([]);
  });
  it("flags a missing required property", () => {
    const errs = core.validateAgainstSchema({ name: "Alice" }, schema);
    expect(errs.join()).toMatch(/missing required property "age"/);
  });
  it("flags a wrong property type", () => {
    const errs = core.validateAgainstSchema({ name: "Alice", age: "thirty" }, schema);
    expect(errs.join()).toMatch(/expected type integer/);
  });
  it("parseJson strips ```json fences", () => {
    expect(core.parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(core.parseJson('prose {"a":1} trailer')).toEqual({ a: 1 });
  });
});

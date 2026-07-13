import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// S2b — garrison-call LIVE against the local Ollama (http://localhost:11434,
// qwen2.5:3b). Guarded: the whole block skips when Ollama is unreachable, so CI /
// a box without Ollama stays green (the mocked suite covers the wiring). When it
// IS up, all three wire shapes + a structured call run for real, and the STDIN →
// STDOUT script contract is exercised end-to-end.
const REPO = path.resolve(__dirname, "..");
const CALL_CORE = path.join(REPO, "fittings/seed/garrison-call/lib/call-core.mjs");
const CALL_CLI = path.join(REPO, "fittings/seed/garrison-call/scripts/call.mjs");
const MODEL = "qwen2.5:3b";

const core = await import(pathToFileURL(CALL_CORE).href);

const OLLAMA_UP = await fetch("http://localhost:11434/api/version", {
  signal: AbortSignal.timeout(2000)
})
  .then((r) => r.ok)
  .catch(() => false);

function runCli(spec: unknown): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CALL_CLI], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.write(JSON.stringify(spec));
    child.stdin.end();
  });
}

describe.skipIf(!OLLAMA_UP)("garrison-call LIVE (local Ollama, qwen2.5:3b)", () => {
  it("anthropic shape (/v1/messages) returns text", { timeout: 60000, retry: 1 }, async () => {
    const res = await core.runCall({
      shape: "anthropic",
      provider: "ollama-local",
      model: MODEL,
      prompt: "Reply with the single word: ping",
      maxTokens: 16
    });
    expect(res.ok).toBe(true);
    expect(typeof res.text).toBe("string");
    expect(res.text.length).toBeGreaterThan(0);
  });

  it("openai shape (/v1/chat/completions) returns text", { timeout: 60000, retry: 1 }, async () => {
    const res = await core.runCall({
      shape: "openai",
      provider: "ollama-local",
      model: MODEL,
      prompt: "Reply with the single word: ping",
      maxTokens: 16
    });
    expect(res.ok).toBe(true);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it("ollama shape (/api/generate) returns text", { timeout: 60000, retry: 1 }, async () => {
    const res = await core.runCall({
      shape: "ollama",
      provider: "ollama-local",
      model: MODEL,
      prompt: "Reply with the single word: ping",
      maxTokens: 16
    });
    expect(res.ok).toBe(true);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it("STRUCTURED call (ollama native format) returns a schema-valid object", { timeout: 60000, retry: 1 }, async () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name", "age"]
    };
    const res = await core.runCall({
      shape: "ollama",
      provider: "ollama-local",
      model: MODEL,
      prompt: "Extract the person: Alice is thirty years old.",
      schema,
      maxTokens: 64
    });
    expect(res.ok).toBe(true);
    expect(res.structured).toBeTruthy();
    expect(typeof res.structured.name).toBe("string");
    expect(Number.isInteger(res.structured.age)).toBe(true);
    // proves the schema-constrained parse held
    expect(core.validateAgainstSchema(res.structured, schema)).toEqual([]);
  });

  it("STDIN → STDOUT script contract: pipe a spec, get {ok:true,text}", { timeout: 60000, retry: 1 }, async () => {
    const { code, out } = await runCli({
      shape: "ollama",
      provider: "ollama-local",
      model: MODEL,
      prompt: "Reply with the single word: ping",
      maxTokens: 16
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.text.length).toBeGreaterThan(0);
    expect(code).toBe(0);
  });
});

describe("garrison-call script fence (no network needed)", () => {
  it("rejects an unlisted base URL loudly through the STDIN contract", async () => {
    const { code, out } = await runCli({
      shape: "openai",
      baseUrl: "https://evil.example.com",
      model: "gpt",
      prompt: "hi"
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/default-deny/i);
    expect(code).toBe(1);
  });

  it("--probe prints ok without a network call", async () => {
    const { code, out } = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn("node", [CALL_CLI, "--probe"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("close", (code) => resolve({ code, out }));
    });
    expect(out.trim()).toBe("ok");
    expect(code).toBe(0);
  });
});

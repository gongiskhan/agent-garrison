import { describe, expect, it } from "vitest";
import {
  accountAuthFailureMessage,
  accountFailureText,
  assertPrimaryGatewayCompatibility,
  classifyAccountFailure,
  midRunLimitHandling,
  primaryAccountRoute,
  resolveActiveAccountPlatform,
  splitBufferedLogChunk
} from "@/lib/runner";

describe("runner primary account routing", () => {
  it("requires the HTTP gateway for a non-Claude primary", () => {
    expect(() => assertPrimaryGatewayCompatibility("openai-agents", false)).toThrow(
      /requires a composed HTTP gateway/
    );
    expect(() => assertPrimaryGatewayCompatibility("claude-code", false)).not.toThrow();
  });

  it("keeps Anthropic-shaped off-plan providers off the account registry", () => {
    expect(primaryAccountRoute("claude-code", "anthropic-plan", "anthropic-plan")).toEqual({
      kind: "anthropic-plan"
    });
    expect(primaryAccountRoute("agent-sdk", "anthropic", "anthropic-plan")).toEqual({
      kind: "anthropic-plan"
    });
    expect(primaryAccountRoute("claude-code", "zai-glm", "cloud-oss").kind).toBe("ignored");
  });

  it("maps native CLI primaries to their own platform and permits auth files", () => {
    expect(primaryAccountRoute("codex", "", undefined)).toEqual({
      kind: "strict",
      platform: "openai",
      allowAuthFile: true
    });
    expect(primaryAccountRoute("gemini", "", undefined)).toEqual({
      kind: "strict",
      platform: "google",
      allowAuthFile: true
    });
  });

  it("distinguishes OpenAI-shaped provider aliases from keyless Ollama", () => {
    expect(primaryAccountRoute("openai-agents", "glm", "cloud-oss")).toMatchObject({
      kind: "strict",
      platform: "glm",
      allowAuthFile: false
    });
    expect(primaryAccountRoute("openai-agents", "openai-compat", "openai-compatible")).toMatchObject({
      kind: "strict",
      platform: "openai",
      allowAuthFile: false
    });
    expect(primaryAccountRoute("openai-agents", "openai", "openai-compatible")).toMatchObject({
      kind: "strict",
      platform: "openai",
      allowAuthFile: false
    });
    expect(primaryAccountRoute("openai-agents", "ollama-local", "local").kind).toBe("unsupported");
    expect(primaryAccountRoute("openai-agents", "zai-glm", "cloud-oss").kind).toBe("unsupported");
  });
});

describe("runner mid-run account limit handling", () => {
  it("records the primary account's actual platform", () => {
    expect(resolveActiveAccountPlatform("claude-work", undefined)).toBe("anthropic");
    expect(resolveActiveAccountPlatform(undefined, "glm")).toBe("glm");
    expect(resolveActiveAccountPlatform(undefined, undefined)).toBeUndefined();
  });

  it("routes only an explicit Anthropic account through the Paymaster", () => {
    expect(midRunLimitHandling("claude-work", "anthropic")).toEqual({
      kind: "anthropic-paymaster"
    });
  });

  it("keeps a GLM limit on the GLM provider rail", () => {
    const handling = midRunLimitHandling("glm-box", "glm");

    expect(handling.kind).toBe("provider");
    if (handling.kind !== "provider") throw new Error("expected provider handling");
    expect(handling.message).toContain('GLM (self-hosted) account "glm-box"');
    expect(handling.message).toContain("another glm account");
    expect(handling.message).not.toMatch(/Anthropic|Paymaster|\bAuto\b/);
  });

  it("fails closed when a hot-reloaded runner has no recorded platform", () => {
    const handling = midRunLimitHandling("legacy-account", undefined);

    expect(handling.kind).toBe("provider");
    if (handling.kind !== "provider") throw new Error("expected provider handling");
    expect(handling.message).toContain('Account "legacy-account"');
    expect(handling.message).not.toMatch(/Anthropic|Paymaster|\bAuto\b/);
  });
});

describe("runner account failure classification", () => {
  const gatewayError = (error: string) => JSON.stringify({
    component: "http-gateway-pty",
    stream: "stderr",
    kind: "chat-stream-failed",
    error
  });

  it("recognizes a real GLM/OpenAI 401 from the gateway error field", () => {
    const line = gatewayError('OpenAI request failed (401): {"error":"Unauthorized"}');
    expect(accountFailureText("stderr", line, "glm")).toContain("Unauthorized");
    expect(classifyAccountFailure("stderr", line, "glm")).toBe("auth");
    expect(classifyAccountFailure("stderr", line, "openai")).toBe("auth");
  });

  it("reassembles a structured gateway failure split across pipe chunks", () => {
    const line = gatewayError('OpenAI request failed (401): {"error":"Unauthorized"}');
    const cut = Math.floor(line.length / 2);
    const buffer = { pending: "" };

    expect(splitBufferedLogChunk(buffer, line.slice(0, cut))).toEqual([]);
    const completed = splitBufferedLogChunk(buffer, `${line.slice(cut)}\n`);

    expect(completed).toEqual([line]);
    expect(classifyAccountFailure("stderr", completed[0], "glm")).toBe("auth");
  });

  it("ignores user and assistant prose in structured gateway stdout", () => {
    const chatIn = JSON.stringify({
      component: "http-gateway-pty",
      stream: "stdout",
      kind: "chat-in",
      message: 'debug 401 {"error":"Unauthorized"}'
    });
    const chatOut = JSON.stringify({
      component: "http-gateway-pty",
      stream: "stdout",
      kind: "chat-out",
      reply: "The provider hit a 429 rate limit error"
    });
    expect(classifyAccountFailure("stdout", chatIn, "glm")).toBeNull();
    expect(classifyAccountFailure("stdout", chatOut, "glm")).toBeNull();
  });

  it("does not attribute unrelated raw stderr or another gateway event kind to GLM", () => {
    expect(classifyAccountFailure("stderr", "npm ERR! 401 Unauthorized", "glm")).toBeNull();
    expect(
      classifyAccountFailure(
        "stderr",
        JSON.stringify({
          component: "http-gateway-pty",
          kind: "dependency-install-failed",
          error: "HTTP 401 Unauthorized"
        }),
        "glm"
      )
    ).toBeNull();
  });

  it("rejects lookalike gateway components and mismatched embedded streams", () => {
    expect(
      classifyAccountFailure(
        "stderr",
        JSON.stringify({
          component: "http-gateway-helper",
          stream: "stderr",
          kind: "chat-stream-failed",
          error: "HTTP 401 Unauthorized"
        }),
        "glm"
      )
    ).toBeNull();
    expect(
      classifyAccountFailure(
        "stderr",
        JSON.stringify({
          component: "http-gateway-pty",
          stream: "stdout",
          kind: "chat-stream-failed",
          error: "HTTP 401 Unauthorized"
        }),
        "glm"
      )
    ).toBeNull();
  });

  it("requires an explicit provider 429 or structured rate-limit code", () => {
    expect(
      classifyAccountFailure("stderr", gatewayError("HTTP 429: too many requests"), "glm")
    ).toBe("limit");
    expect(
      classifyAccountFailure(
        "stderr",
        gatewayError('{"error":{"type":"rate_limit_error"}}'),
        "openai"
      )
    ).toBe("limit");
    expect(
      classifyAccountFailure("stderr", gatewayError("please explain rate limit errors"), "glm")
    ).toBeNull();
  });

  it("keeps provider recovery guidance off the Anthropic setup-token rail", () => {
    const glm = accountAuthFailureMessage("glm-box", "glm");
    expect(glm).toContain("GLM (self-hosted)");
    expect(glm).toContain("Accounts");
    expect(glm).not.toContain("setup-token");
    expect(accountAuthFailureMessage("work", "anthropic")).toContain("setup-token");
  });
});

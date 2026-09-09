import { startAnthropicLogProxy } from "./anthropic-log-proxy.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeAdapterCallInvoker, resolveAgentSdkDir } from "./gateway-routing.mjs";

let proxyPromise;
let accountProxyPromise;
export function cheapestAnthropicTarget(model) {
  const targets = model?.targets ?? [];
  const rungs = Object.values(model?.dutyLadder ?? {}).flatMap((ladder) => ladder?.rungs ?? []);
  const choices = rungs.map((rung) => ({ ...targets.find((target) => target.id === rung.target), ...rung }))
    .filter((target) => target.provider === "anthropic" && typeof target.model === "string");
  const priceRank = (target) => /haiku/i.test(target.model) ? 0 : /sonnet/i.test(target.model) ? 1 : /opus/i.test(target.model) ? 2 : 3;
  return choices.sort((a, b) => priceRank(a) - priceRank(b))[0] ?? null;
}

export async function callCardInference(router, { system, prompt, signal }, { fetchImpl = fetch, proxyUrl, adapterFactory } = {}) {
  const target = cheapestAnthropicTarget(await router.executionModel());
  if (!target) throw new Error("No Anthropic model is configured in the board ladder.");
  const secrets = router.resolveSecrets() ?? {};
  const key = secrets[target.params?.apiKeyEnv || target.apiKeyEnv || "ANTHROPIC_API_KEY"];
  let base = proxyUrl || process.env.GARRISON_ANTHROPIC_PROXY_URL;
  if (!base) {
    proxyPromise ??= startAnthropicLogProxy().catch((error) => { proxyPromise = null; throw error; });
    base = (await proxyPromise).url;
  }
  if (!key || target.account) {
    if (!proxyUrl) {
      accountProxyPromise ??= startAnthropicLogProxy({ shape: { forceTool: "StructuredOutput" } }).catch((error) => { accountProxyPromise = null; throw error; });
      base = (await accountProxyPromise).url;
    }
    // Match the dispatcher's provider/account resolver, including its stored
    // login when this Anthropic target has no separate API key.
    const createAdapter = adapterFactory || (async () => {
      const dir = resolveAgentSdkDir(router.compositionDir);
      if (!dir) throw new Error("The configured Anthropic runtime is unavailable.");
      const { AgentSdkAdapter } = await import(pathToFileURL(path.join(dir, "lib/agent-sdk-adapter.mjs")));
      return new AgentSdkAdapter();
    });
    const adapter = await createAdapter();
    let active;
    const spawn = adapter.spawn.bind(adapter);
    const cancel = () => { if (active) void adapter.cancel?.(active); };
    adapter.spawn = async (config) => { active = await spawn(config); if (signal?.aborted) cancel(); return active; };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const invoke = makeAdapterCallInvoker(adapter, {
        ...target, compositionDir: router.compositionDir, secrets,
        env: { ...process.env, GARRISON_ANTHROPIC_PROXY_URL: base, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "800", CLAUDE_CODE_MAX_RETRIES: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1" },
        provider: "anthropic", model: target.model, effort: "low", thinking: { type: "disabled" },
        promptMode: "lean", leanPrompt: system, maxTurns: 1, tools: [], allowedTools: [], permissionMode: "bypassPermissions", persistSession: false,
        outputFormat: { type: "json_schema", schema: { type: "object", properties: {
          title: { type: "string", maxLength: 70 }, description: { type: "string" }, messageIds: { type: "array", items: { type: "string" } }, confidence: { type: "number" },
        }, required: ["title", "description", "messageIds", "confidence"], additionalProperties: false } },
      }, { timeoutMs: 20_000 });
      const result = await invoke({ model: target.model, prompt, timeoutMs: 20_000 });
      if (!result.ok) throw new Error(result.error || "Card inference failed.");
      return result.text;
    } finally { signal?.removeEventListener("abort", cancel); }
  }
  // Haiku has no effort field. The dispatcher uses thinking disabled for its
  // lowest-cost call; newer Sonnet and Opus models accept low explicitly.
  const supportsEffort = /(?:sonnet|opus)-(?:[5-9]|4-(?:[6-9]))/.test(target.model) || /opus-4-5/.test(target.model);
  const response = await fetchImpl(new URL("/v1/messages", base), {
    method: "POST", signal,
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key },
    body: JSON.stringify({ model: target.model, max_tokens: 800, thinking: { type: "disabled" },
      ...(supportsEffort ? { output_config: { effort: "low" } } : {}), system, messages: [{ role: "user", content: prompt }] }),
  });
  if (!response.ok) throw new Error(`Card inference returned HTTP ${response.status}.`);
  const body = await response.json();
  return (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

import { startAnthropicLogProxy } from "./anthropic-log-proxy.mjs";

let proxyPromise;
export function cheapestAnthropicTarget(model) {
  const targets = model?.targets ?? [];
  const rungs = Object.values(model?.dutyLadder ?? {}).flatMap((ladder) => ladder?.rungs ?? []);
  const choices = rungs.map((rung) => ({ ...targets.find((target) => target.id === rung.target), ...rung }))
    .filter((target) => target.provider === "anthropic" && typeof target.model === "string");
  const priceRank = (target) => /haiku/i.test(target.model) ? 0 : /sonnet/i.test(target.model) ? 1 : /opus/i.test(target.model) ? 2 : 3;
  return choices.sort((a, b) => priceRank(a) - priceRank(b))[0] ?? null;
}

export async function callCardInference(router, { system, prompt, signal }, { fetchImpl = fetch, proxyUrl } = {}) {
  const target = cheapestAnthropicTarget(await router.executionModel());
  if (!target) throw new Error("No Anthropic model is configured in the board ladder.");
  const secrets = router.resolveSecrets() ?? {};
  const key = secrets[target.params?.apiKeyEnv || target.apiKeyEnv || "ANTHROPIC_API_KEY"];
  if (!key) throw new Error("The configured Anthropic inference key is unavailable.");
  let base = proxyUrl || process.env.GARRISON_ANTHROPIC_PROXY_URL;
  if (!base) {
    proxyPromise ??= startAnthropicLogProxy().catch((error) => { proxyPromise = null; throw error; });
    base = (await proxyPromise).url;
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

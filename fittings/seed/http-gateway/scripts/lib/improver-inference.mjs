import { callStructuredInference, cheapestAnthropicTarget } from "./card-inference.mjs";
import { REVIEW_SYSTEM, REVIEW_SCHEMA } from "@garrison/improver/contracts";

// Reviews remain tool-free. Use the configured model and sealed accounts rather
// than depending on a particular node's interactive Claude login.
export async function callImproverInference(router, { prompt, signal }, { call = callStructuredInference } = {}) {
  const review = await router.executionRouteFor?.({ duty: "review", level: 2 });
  const configured = review?.target;
  const target = configured?.provider === "anthropic" && ["agent-sdk", "claude-code"].includes(configured.runtime)
    ? configured : cheapestAnthropicTarget(await router.executionModel());
  if (!target) throw new Error("Configure an Anthropic review model in Run routing.");
  const secrets = router.resolveSecrets() ?? {};
  const accounts = Object.keys(secrets).filter((key) => key.startsWith("ANTHROPIC_ACCOUNT__") && secrets[key])
    .map((key) => key.slice("ANTHROPIC_ACCOUNT__".length)).sort();
  // An explicit target account remains authoritative. With no pin, try the
  // inherited login, then the existing sealed accounts on authentication failure.
  const candidates = target.account ? [target] : [target, ...accounts.slice(0,3).map((account) => ({...target,account}))];
  const failed = [];
  for (const choice of candidates) {
    if (signal?.aborted) throw new Error("Review inference was cancelled");
    try {
      const text = await call(router, {system:REVIEW_SYSTEM,prompt,signal},
        {schema:REVIEW_SCHEMA,maxTokens:6000,timeoutMs:120_000,targetOverride:choice});
      return {text,inference:{runtime:"agent-sdk",model:choice.model,account:choice.account ?? null,fallbacks:failed}};
    } catch (error) {
      if (!/not logged in|authentication|unauthorized|token.*expired|invalid.*token|\b401\b/i.test(error.message) || signal?.aborted) throw error;
      failed.push({account:choice.account ?? null,error:"Authentication unavailable"});
      if (choice === candidates.at(-1)) throw new Error(`Review authentication failed for ${failed.length} configured login(s). Reconnect an account in Accounts.`);
    }
  }
}

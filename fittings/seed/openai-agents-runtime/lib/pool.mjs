// pool.mjs - openai-agents warm-pool integration (mirrors the agent-sdk pool).
//
// The MultiRuntimePool (packages/claude-pty/src/multi-runtime-pool.mjs) is keyed
// by runtime id and adapter-agnostic - it drives rt.adapter.spawn(rt.spawnConfig),
// so an openai-agents session warms EXACTLY like a PTY or agent-sdk session,
// heterogeneous in the same pool. A `full` and a `lean` session are NOT
// interchangeable (different instructions, tools, token floor), so the pool key
// includes promptMode - along with provider + model. One stateless
// OpenAiAgentsAdapter instance can back many pools (per-session state lives on the
// session object + a per-session WeakMap), so callers may share an adapter.
import { OpenAiAgentsAdapter } from "./openai-adapter.mjs";

// The pool key for an openai-agents target. Distinct per {provider, model,
// promptMode} so the pool warms a separate pool per non-interchangeable session.
export function openAiPoolKey({ provider, model, promptMode = "full" } = {}) {
  return ["openai-agents", provider ?? "?", model ?? "?", promptMode].join(":");
}

// Build a MultiRuntimePool runtime entry for an openai-agents target. opts.adapter
// lets callers/tests share/inject an adapter (a fake-runAgent one in tests);
// defaults to a real OpenAiAgentsAdapter.
export function openAiPoolEntry(target = {}, opts = {}) {
  const promptMode = target.promptMode ?? "full";
  const adapter = opts.adapter ?? new OpenAiAgentsAdapter(opts.adapterOpts ?? {});
  return {
    id: openAiPoolKey({ provider: target.provider, model: target.model, promptMode }),
    adapter,
    role: target.role ?? "secondary",
    size: target.size ?? 1,
    spawnConfig: {
      provider: target.provider,
      model: target.model,
      promptMode,
      baseUrl: target.baseUrl,
      compositionDir: target.compositionDir,
      maxTurns: target.maxTurns,
      budgetTokens: target.budgetTokens,
      secrets: target.secrets ?? null
    }
  };
}

// Convenience: build runtime entries for a set of openai-agents targets.
export function openAiPoolEntries(targets = [], opts = {}) {
  return targets.map((t) => openAiPoolEntry(t, opts));
}

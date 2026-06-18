// pool.mjs — agent-sdk warm-pool integration (BRIEF §"Pool").
//
// The MultiRuntimePool (packages/claude-pty/src/multi-runtime-pool.mjs) is keyed
// by runtime id and is adapter-agnostic — it drives rt.adapter.spawn(rt.spawnConfig)
// and stays runtime-agnostic, so an agent-sdk session warms EXACTLY like a PTY
// session, heterogeneous in the same pool. A `full` and a `lean` session are NOT
// interchangeable (different system prompt, settingSources, token floor), so the
// pool key includes promptMode — along with provider + model — as a composite
// runtime id. One stateless AgentSdkAdapter instance can back many pools (it keeps
// per-session state on the session object + a per-session WeakMap), so callers may
// share an adapter across keys.

import { AgentSdkAdapter } from "./agent-sdk-adapter.mjs";

// The pool key for an agent-sdk target. Distinct for each {provider, model,
// promptMode} so the pool warms a separate pool per non-interchangeable session.
export function agentSdkPoolKey({ provider, model, promptMode = "full" } = {}) {
  return ["agent-sdk", provider ?? "?", model ?? "?", promptMode].join(":");
}

// Build a MultiRuntimePool runtime entry for an agent-sdk target. opts.adapter
// lets callers/tests share/inject an adapter (a fake-client one in tests);
// defaults to a real AgentSdkAdapter.
export function agentSdkPoolEntry(target = {}, opts = {}) {
  const promptMode = target.promptMode ?? "full";
  const adapter = opts.adapter ?? new AgentSdkAdapter(opts.adapterOpts ?? {});
  return {
    id: agentSdkPoolKey({ provider: target.provider, model: target.model, promptMode }),
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
      acceptApiBilling: !!target.acceptApiBilling,
      secrets: target.secrets ?? null,
      settingsJson: target.settingsJson
    }
  };
}

// Convenience: build the runtime entries for a set of agent-sdk targets, ready to
// pass to `new MultiRuntimePool({ runtimes: [...ptyEntries, ...agentSdkPoolEntries(targets)] })`.
export function agentSdkPoolEntries(targets = [], opts = {}) {
  return targets.map((t) => agentSdkPoolEntry(t, opts));
}

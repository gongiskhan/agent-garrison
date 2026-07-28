// stage-b.mjs — Stage B: act on the resolved runtime-target (BRIEF v4 §2).
//
// Pure decision + env builders (no I/O), so they are unit-testable and shared by
// the gateway. Given the live session's current target and the resolved target:
//   - model / effort differ, same provider + soul → SLASH-INJECT (/model, /effort
//     between turns; MR0e verdict slash-inject = works).
//   - provider or soul differ → RESPAWN-WITH-RESUME (launch-fixed: env base-URL /
//     vault key + soul system-prompt are read only at spawn), preserving context
//     via --continue in the same cwd.

// Providers are POLICY DATA (GARRISON-RUNTIMES-V1 P2/D2). The historical
// hardcoded PROVIDERS registry is gone: buildLaunchEnv resolves the provider
// spec from the policy's `providers` section (opts.providers), which the
// migration seeds with the four historical entries (anthropic-plan,
// ollama-local, deepseek, zai-glm) so existing routing resolves identically.
// A missing providers list or an unknown provider id is a LOUD error — never a
// silent fallback to a built-in table.

// Normalize a policy provider entry (camelCase policy-file shape) into the
// spec shape the env builder consumes. needsKey derives from vaultKey.
function resolveProviderSpec(providers, id) {
  if (!Array.isArray(providers) || !providers.length) {
    throw new Error(
      `provider "${id}" cannot be resolved: no providers section supplied — pass the policy's providers (compilePolicy/ensureProviders output) in opts.providers`
    );
  }
  const p = providers.find((entry) => entry && entry.id === id);
  if (!p) {
    throw new Error(
      `unknown provider "${id}" — not in the policy providers section (known: ${providers.map((e) => e && e.id).join(", ")})`
    );
  }
  // ONLY an explicit kind "anthropic-plan" is the Max-OAuth no-launch path —
  // a kindless entry with a null baseUrl is MALFORMED and throws (mirrors the
  // 7e19e34 hardening of buildPrimaryRuntimeEnv; never silently the plan path).
  const kind = p.kind ?? (p.baseUrl == null ? null : "cloud-oss");
  if (kind === null) {
    throw new Error(
      `provider "${id}" is malformed: no kind and no baseUrl — declare kind "anthropic-plan" explicitly for the Max-OAuth path, or set a baseUrl`
    );
  }
  return {
    kind,
    baseUrl: p.baseUrl ?? null,
    needsKey: !!p.vaultKey,
    vaultKey: p.vaultKey,
    dummyToken: p.dummyToken
  };
}

export class MissingProviderKeyError extends Error {
  constructor(provider, vaultKey, vaultLocked) {
    super(
      vaultLocked
        ? `provider "${provider}" needs ${vaultKey} but the vault is LOCKED — unlock it`
        : `provider "${provider}" needs ${vaultKey} but it is ABSENT from the materialized env`
    );
    this.name = "MissingProviderKeyError";
    this.provider = provider;
    this.vaultKey = vaultKey;
    this.vaultLocked = !!vaultLocked;
  }
}

// Build the launch env for a runtime-target. baseEnv is the inherited process
// env; opts.secrets is the materialized vault (key->value) or null when locked;
// opts.providers is the policy's providers section (REQUIRED — P2).
// Throws MissingProviderKeyError (loud, distinguishes locked vs absent) for a
// cloud provider with no key.
export function buildLaunchEnv(target, opts = {}) {
  const baseEnv = opts.baseEnv ?? {};
  const secrets = opts.secrets ?? null; // null = vault locked
  const provider = target.provider || "anthropic-plan";
  const spec = resolveProviderSpec(opts.providers, provider);
  const out = { ...baseEnv };
  // Always strip ANTHROPIC_API_KEY: for anthropic-plan it would force API
  // billing off the Max plan; for third-party providers we use AUTH_TOKEN.
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_BASE_URL;
  delete out.ANTHROPIC_AUTH_TOKEN;
  // RUNTIME-ACCOUNTS-V1: an inherited account token (the PRIMARY session's
  // pin) must never leak into a target with a different — or no — account.
  delete out.CLAUDE_CODE_OAUTH_TOKEN;
  delete out.GARRISON_ACCOUNT;

  if (spec.kind === "anthropic-plan") {
    // RUNTIME-ACCOUNTS-V1: the plan path may be pinned to a named account.
    // target.account (carried from the runtime fitting's config) wins; a plan
    // target WITHOUT its own account INHERITS the launching session's pin
    // (baseEnv.GARRISON_ACCOUNT + token) so a soul-switch respawn never drops
    // the operative back onto the machine's ambient login mid-conversation.
    // The token is the vault secret ANTHROPIC_ACCOUNT__<name> (mirror of
    // src/lib/account-env.ts — fittings cannot import src/lib). Injected as
    // ANTHROPIC_AUTH_TOKEN because stored /login credentials beat
    // CLAUDE_CODE_OAUTH_TOKEN in the CLI, while ANTHROPIC_AUTH_TOKEN beats
    // stored credentials (verified live, 2.1.216); CLAUDE_CODE_OAUTH_TOKEN is
    // set too for credential-less config dirs. A named account whose token
    // cannot resolve throws LOUD — riding the ambient login would be the
    // wrong-account bug this feature exists to kill.
    const account = String(target.account ?? "").trim();
    if (account) {
      const accountKey = `ANTHROPIC_ACCOUNT__${account}`;
      const vaultLocked = secrets === null;
      const token = vaultLocked ? undefined : secrets[accountKey];
      if (!token) throw new MissingProviderKeyError(`${provider} (account "${account}")`, accountKey, vaultLocked);
      out.ANTHROPIC_AUTH_TOKEN = token;
      out.CLAUDE_CODE_OAUTH_TOKEN = token;
      out.GARRISON_ACCOUNT = account;
      // Empty (not merely deleted): the spawned process inherits the PROCESS
      // env underneath this map — a stray raw API key would outrank the token.
      out.ANTHROPIC_API_KEY = "";
    } else if (baseEnv.GARRISON_ACCOUNT && baseEnv.ANTHROPIC_AUTH_TOKEN) {
      out.ANTHROPIC_AUTH_TOKEN = baseEnv.ANTHROPIC_AUTH_TOKEN;
      out.CLAUDE_CODE_OAUTH_TOKEN = baseEnv.CLAUDE_CODE_OAUTH_TOKEN ?? baseEnv.ANTHROPIC_AUTH_TOKEN;
      out.GARRISON_ACCOUNT = baseEnv.GARRISON_ACCOUNT;
      out.ANTHROPIC_API_KEY = "";
    }
    return out; // Max OAuth (optionally account-pinned), no base URL
  }
  out.ANTHROPIC_BASE_URL = spec.baseUrl;
  if (spec.needsKey) {
    const vaultLocked = secrets === null;
    const key = vaultLocked ? undefined : secrets[spec.vaultKey];
    if (!key) throw new MissingProviderKeyError(provider, spec.vaultKey, vaultLocked);
    out.ANTHROPIC_AUTH_TOKEN = key;
  } else {
    out.ANTHROPIC_AUTH_TOKEN = spec.dummyToken || "local"; // Ollama ignores auth
  }
  return out;
}

function targetKey(t) {
  // launch-fixed dimensions: provider + soul (env / system-prompt read at spawn)
  return `${t?.provider || "anthropic-plan"}::${t?.soul || ""}`;
}

// Decide how to move the live session onto the resolved target.
// Returns { path: 'noop'|'slash-inject'|'respawn-resume', injections?, reasons }.
export function planSwitch(current, resolved, opts = {}) {
  const slashInjectWorks = opts.slashInjectWorks !== false; // MR0e verdict: works
  const reasons = [];
  if (!resolved) return { path: "noop", reasons: ["no resolved target"] };
  if (!current) {
    return { path: "respawn-resume", injections: [], reasons: ["no live session — cold spawn of the target"] };
  }
  const providerOrSoulChanged = targetKey(current) !== targetKey(resolved);
  const modelChanged = (current.model || null) !== (resolved.model || null);
  const effortChanged = (current.effort || null) !== (resolved.effort || null);

  if (providerOrSoulChanged) {
    if (current.provider !== resolved.provider) reasons.push(`provider ${current.provider}→${resolved.provider}`);
    if ((current.soul || "") !== (resolved.soul || "")) reasons.push(`soul ${current.soul || "∅"}→${resolved.soul || "∅"}`);
    return { path: "respawn-resume", injections: [], reasons };
  }
  if (!modelChanged && !effortChanged) return { path: "noop", reasons: ["already on target"] };
  if (!slashInjectWorks) {
    // fallback mode: model/effort are pool keys → respawn too
    if (modelChanged) reasons.push(`model ${current.model}→${resolved.model} (respawn-fallback)`);
    if (effortChanged) reasons.push(`effort ${current.effort}→${resolved.effort} (respawn-fallback)`);
    return { path: "respawn-resume", injections: [], reasons };
  }
  const injections = [];
  if (modelChanged) {
    injections.push(`/model ${resolved.model}`);
    reasons.push(`model ${current.model}→${resolved.model}`);
  }
  if (effortChanged) {
    injections.push(`/effort ${resolved.effort}`);
    reasons.push(`effort ${current.effort}→${resolved.effort}`);
  }
  return { path: "slash-inject", injections, reasons };
}

// On a respawn-resume (soul/provider change), `claude --continue` MAY not restore
// an ephemeral session's context (2.1.x doesn't persist ultra-short sessions to a
// readable transcript — verified). buildContextCarryover produces a compact
// summary of the recent turns that the gateway re-injects as the first turn's
// preamble after a respawn, so context survives regardless of --continue. Pure +
// deterministic. (BRIEF U4 soul-switch self-unblock.)
export function buildContextCarryover(priorTurns, opts = {}) {
  const keep = opts.keep ?? 6;
  const maxChars = opts.maxChars ?? 1200;
  const turns = (priorTurns || []).filter((t) => t && t.text).slice(-keep);
  if (!turns.length) return "";
  const lines = turns.map((t) => `${t.role === "user" ? "User" : "You"}: ${String(t.text).replace(/\s+/g, " ").trim()}`);
  let summary = lines.join("\n");
  if (summary.length > maxChars) summary = "…" + summary.slice(summary.length - maxChars);
  return `[context carried over from your prior session — you switched models/soul mid-conversation; continue seamlessly]\n${summary}`;
}

// The respawn spawn opts for a respawn-resume switch (context preserved via
// --continue in the same cwd; soul applied as the append-system-prompt file).
export function buildRespawnOpts(resolved, opts = {}) {
  const provider = resolved.provider || "anthropic-plan";
  return {
    compositionDir: opts.compositionDir,
    model: resolved.model,
    continueSession: true, // --continue: reliable resume (JSONL transcript is absent on 2.1.x)
    appendSystemPromptFile: opts.appendSystemPromptFile, // soul / assembled prompt
    env: buildLaunchEnv(resolved, opts),
    // A non-anthropic-plan target sets ANTHROPIC_BASE_URL/AUTH_TOKEN in env;
    // providerLaunch tells the spawner to KEEP them (else session.mjs scrubs the
    // base URL back to the Max plan). Verified live U4 (ollama-local).
    providerLaunch: provider !== "anthropic-plan",
    permissionMode: opts.permissionMode ?? "bypassPermissions",
    // Carry the spawn-time extra claude args (e.g. --mcp-config) across a
    // model-switch respawn so the fresh operative keeps its MCP tools.
    ...(Array.isArray(opts.extraArgs) && opts.extraArgs.length ? { extraArgs: opts.extraArgs } : {})
  };
}

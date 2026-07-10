// stage-b.mjs — Stage B: act on the resolved runtime-target (BRIEF v4 §2).
//
// Pure decision + env builders (no I/O), so they are unit-testable and shared by
// the gateway. Given the live session's current target and the resolved target:
//   - model / effort differ, same provider + soul → SLASH-INJECT (/model, /effort
//     between turns; MR0e verdict slash-inject = works).
//   - provider or soul differ → RESPAWN-WITH-RESUME (launch-fixed: env base-URL /
//     vault key + soul system-prompt are read only at spawn), preserving context
//     via --continue in the same cwd.

// Anthropic-compatible provider registry. anthropic-plan is the default (Max
// OAuth, NO base URL, the -p ban applies). Non-anthropic-plan providers set
// ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN and bill on their own account.
// Base URLs are the documented Anthropic-compatible endpoints (no live round-trip
// is asserted — provider-launch-ok asserts the launch ENV is wired correctly).
export const PROVIDERS = {
  "anthropic-plan": { kind: "anthropic-plan", baseUrl: null, needsKey: false },
  "ollama-local": { kind: "local", baseUrl: "http://localhost:11434", needsKey: false, dummyToken: "ollama" },
  deepseek: { kind: "cloud-oss", baseUrl: "https://api.deepseek.com/anthropic", needsKey: true, vaultKey: "DEEPSEEK_API_KEY" },
  "zai-glm": { kind: "cloud-oss", baseUrl: "https://api.z.ai/api/anthropic", needsKey: true, vaultKey: "ZAI_API_KEY" }
};

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
// env; opts.secrets is the materialized vault (key->value) or null when locked.
// Throws MissingProviderKeyError (loud, distinguishes locked vs absent) for a
// cloud provider with no key.
export function buildLaunchEnv(target, opts = {}) {
  const baseEnv = opts.baseEnv ?? {};
  const secrets = opts.secrets ?? null; // null = vault locked
  const provider = target.provider || "anthropic-plan";
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`unknown provider "${provider}"`);
  const out = { ...baseEnv };
  // Always strip ANTHROPIC_API_KEY: for anthropic-plan it would force API
  // billing off the Max plan; for third-party providers we use AUTH_TOKEN.
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_BASE_URL;
  delete out.ANTHROPIC_AUTH_TOKEN;

  if (spec.kind === "anthropic-plan") {
    return out; // Max OAuth, no base URL, no key
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
    permissionMode: opts.permissionMode ?? "bypassPermissions"
  };
}

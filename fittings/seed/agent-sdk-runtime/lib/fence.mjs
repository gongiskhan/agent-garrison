// fence.mjs — THE FENCE (BRIEF: Agent SDK Runtime §"THE FENCE").
//
// The Claude Agent SDK bills against a separate API credit pool at full rates
// when it talks to the Anthropic endpoint — the exact path the v4
// programmatic-path purge removed. So the agent-sdk runtime is DEFAULT-DENY
// against Anthropic billing: it hard-refuses to launch unless the EFFECTIVE
// resolved base URL is non-Anthropic, OR an explicit per-target
// `acceptApiBilling: true` (ships off) is set.
//
// The fence asserts on the EFFECTIVE base URL, not the config value. Known SDK
// trap (anthropics/claude-code issue #217): an `env` block in
// ~/.claude/settings.json can override programmatic options.env, so a spawned
// process can reach the Anthropic endpoint even when the per-target config set a
// non-Anthropic URL. The fence therefore inspects settings.json's env block and
// treats an Anthropic ANTHROPIC_BASE_URL there as the effective value (and a
// violation). The adapter additionally sets settingSources WITHOUT 'user' so the
// user settings block does not load — defence in depth, but the fence does not
// rely on it.
//
// NOTE: this guard detects Anthropic by hostname SUFFIX ("anthropic.com" and
// "*.anthropic.com"), matched via the URL parser — never by the narrower banned
// host literal — so the fence code itself never trips the programmatic-purge ban.

export class FenceViolation extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "FenceViolation";
    this.code = "fence-violation";
    Object.assign(this, extra);
  }
}

// True if a base URL resolves to Anthropic billing. A null/empty base URL means
// the SDK would use the default Anthropic / Max OAuth path → Anthropic billing.
export function isAnthropicBaseUrl(baseUrl) {
  if (!baseUrl) return true;
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false; // unparseable → not Anthropic (it will fail to connect elsewhere)
  }
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}

// The ANTHROPIC_BASE_URL a settings.json `env` block would inject, or null.
export function settingsEnvBaseUrl(settingsJson) {
  const env = settingsJson && typeof settingsJson === "object" ? settingsJson.env : null;
  if (env && typeof env === "object" && typeof env.ANTHROPIC_BASE_URL === "string") {
    return env.ANTHROPIC_BASE_URL;
  }
  return null;
}

// Resolve the EFFECTIVE base URL the spawned process will actually use. Per
// issue #217 the settings.json env block wins over options.env, so it is the
// effective value when present.
export function resolveEffectiveBaseUrl({ configBaseUrl = null, settingsJson = null } = {}) {
  const fromSettings = settingsEnvBaseUrl(settingsJson);
  const effective = fromSettings != null ? fromSettings : configBaseUrl;
  return {
    effective: effective ?? null,
    fromSettings,
    overriddenBySettings: fromSettings != null && fromSettings !== configBaseUrl
  };
}

// THE FENCE. Default-deny. Throws FenceViolation unless the effective base URL is
// non-Anthropic, or acceptApiBilling === true. Returns a state record for the UI.
export function assertFence({ configBaseUrl = null, settingsJson = null, acceptApiBilling = false } = {}) {
  const { effective, fromSettings, overriddenBySettings } = resolveEffectiveBaseUrl({ configBaseUrl, settingsJson });
  const anthropic = isAnthropicBaseUrl(effective);

  if (anthropic && !acceptApiBilling) {
    if (overriddenBySettings) {
      throw new FenceViolation(
        `FENCE: ~/.claude/settings.json env injects an Anthropic base URL ("${fromSettings}", issue #217), ` +
          `overriding the configured base URL "${configBaseUrl ?? "(none)"}". Refusing to launch the Agent SDK ` +
          `against Anthropic billing. Remove ANTHROPIC_BASE_URL from settings.json env, or set acceptApiBilling: true.`,
        { effective, configBaseUrl, fromSettings, overriddenBySettings: true }
      );
    }
    throw new FenceViolation(
      effective
        ? `FENCE: effective ANTHROPIC_BASE_URL "${effective}" resolves to Anthropic billing. The Agent SDK runtime ` +
            `is default-deny against Anthropic — it bills your API credit pool at FULL RATES, outside plan limits. ` +
            `Set acceptApiBilling: true on the target to override (never the default).`
        : `FENCE: no ANTHROPIC_BASE_URL is set, so the Agent SDK would use the Anthropic / Max OAuth billing path ` +
            `(API credit pool, FULL RATES). The Agent SDK runtime hard-refuses to launch without a non-Anthropic base URL.`,
      { effective, configBaseUrl, acceptApiBilling: false }
    );
  }

  return {
    effective,
    anthropic,
    acceptApiBilling: !!acceptApiBilling,
    overriddenBySettings,
    // Human-readable state for the Quarters view / logs (cost stated in words).
    state: anthropic
      ? "anthropic-accepted (BILLS YOUR API CREDIT POOL AT FULL RATES — acceptApiBilling is on)"
      : "non-anthropic (fenced — no Anthropic billing)"
  };
}

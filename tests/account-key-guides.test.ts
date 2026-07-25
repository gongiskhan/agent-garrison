import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PLATFORMS,
  COMMON_CUSTOM_PROVIDERS,
  PLATFORM_SPECS,
  isValidEnvKey
} from "@/lib/account-env";

// RUNTIME-ACCOUNTS-V4 — "where do I get this key?" is answered next to the field
// that asks. These are pure-data assertions: the failure mode for a guide is a
// link that rots or a step that contradicts the platform, and both are cheap to
// pin here. (Reachability was checked live when the URLs were added; this guards
// the shape and the invariants a refactor could break.)

describe("api key guides", () => {
  it("every platform that accepts a pasted key explains where to get one", () => {
    for (const platform of ACCOUNT_PLATFORMS) {
      const guide = PLATFORM_SPECS[platform].apiKeyGuide;
      expect(guide, `${platform} has no apiKeyGuide`).toBeTruthy();
      expect(guide!.url).toMatch(/^https:\/\//);
      expect(guide!.urlLabel.length).toBeGreaterThan(3);
      expect(guide!.steps.length).toBeGreaterThanOrEqual(2);
      for (const step of guide!.steps) expect(step.trim().length).toBeGreaterThan(10);
      if (guide!.extra) expect(guide!.extra.url).toMatch(/^https:\/\//);
    }
  });

  it("names the key prefix a user can check their paste against", () => {
    // The single most common paste error is the wrong credential entirely.
    expect(PLATFORM_SPECS.anthropic.apiKeyGuide!.steps.join(" ")).toContain("sk-ant-");
    expect(PLATFORM_SPECS.openai.apiKeyGuide!.steps.join(" ")).toContain("sk-");
    expect(PLATFORM_SPECS.google.apiKeyGuide!.steps.join(" ")).toContain("AIza");
    expect(PLATFORM_SPECS.openrouter.apiKeyGuide!.steps.join(" ")).toContain("sk-or-v1-");
    expect(PLATFORM_SPECS.huggingface.apiKeyGuide!.steps.join(" ")).toContain("hf_");
  });

  it("warns that an API key is not the subscription, where both exist", () => {
    // Buying platform credits when you meant to use your Max/Plus plan is an
    // expensive mistake, so the distinction is stated on both platforms.
    expect(PLATFORM_SPECS.anthropic.apiKeyGuide!.note).toMatch(/SEPARATE|separate/);
    expect(PLATFORM_SPECS.anthropic.apiKeyGuide!.note).toMatch(/subscription/i);
    expect(PLATFORM_SPECS.openai.apiKeyGuide!.note).toMatch(/subscription/i);
  });

  it("points a custom account at real providers with valid env var names", () => {
    expect(COMMON_CUSTOM_PROVIDERS.length).toBeGreaterThanOrEqual(4);
    for (const provider of COMMON_CUSTOM_PROVIDERS) {
      expect(provider.url).toMatch(/^https:\/\//);
      // The suggested env var must be one addAccount would actually accept.
      expect(isValidEnvKey(provider.envKey), provider.envKey).toBe(true);
      expect(provider.envKey).toMatch(/_API_KEY$/);
    }
  });
});

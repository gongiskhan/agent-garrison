import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs core typed by routing-core.d.mts
import { biasRole, modeBiasFor } from "../fittings/seed/orchestrator/lib/routing-core.mjs";
// The multi-face `modes` seed fitting was retired (S3f2b); its routing-bias config
// lives on as a synthetic fixture so the still-live biasRole/modeBiasFor stay covered.
import { MODES_FIXTURE as MODES } from "./helpers/modes-fixture";

describe("mode bias (s1e)", () => {
  it("biasRole: Joe floors at expert, James floors at standard, Gary leans standard->fast (keeps expert)", () => {
    const joe = modeBiasFor("joe", MODES);
    expect(biasRole("fast", joe)).toBe("expert");
    expect(biasRole("standard", joe)).toBe("expert");
    expect(biasRole("expert", joe)).toBe("expert");

    const james = modeBiasFor("james", MODES);
    expect(biasRole("fast", james)).toBe("standard");
    expect(biasRole("standard", james)).toBe("standard");
    expect(biasRole("expert", james)).toBe("expert");

    // "standard-toward-fast": Gary downgrades a standard baseline to fast (the cheap
    // PA face), but still keeps expert for genuinely hard tasks. NOT a no-op.
    const gary = modeBiasFor("gary", MODES);
    expect(biasRole("fast", gary)).toBe("fast");
    expect(biasRole("standard", gary)).toBe("fast");
    expect(biasRole("expert", gary)).toBe("expert");
  });

  it("biasRole leaves task-specific roles (image/video/review) untouched", () => {
    const joe = modeBiasFor("joe", MODES);
    expect(biasRole("image", joe)).toBe("image");
    expect(biasRole("video", joe)).toBe("video");
    expect(biasRole("review", joe)).toBe("review");
  });

  it("biasRole + modeBiasFor yield each mode's nominal tier (the value baked into the orchestrator prompt)", () => {
    const nominal = (m: string) => biasRole("standard", modeBiasFor(m, MODES));
    expect(nominal("joe")).toBe("expert");
    expect(nominal("james")).toBe("standard");
    expect(nominal("gary")).toBe("fast");
  });

  it("modeBiasFor returns null for an unknown mode or missing config", () => {
    expect(modeBiasFor("nonexistent", MODES)).toBeNull();
    expect(modeBiasFor("joe", null)).toBeNull();
    expect(modeBiasFor("joe", {})).toBeNull();
  });

  it("biasRole is a no-op without a bias", () => {
    expect(biasRole("standard", null)).toBe("standard");
    expect(biasRole("standard", undefined)).toBe("standard");
  });
});

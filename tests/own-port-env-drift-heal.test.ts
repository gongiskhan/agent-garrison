import { describe, expect, it } from "vitest";
import { envFingerprintForExtraEnv } from "@/lib/own-port-lifecycle";

// The env-drift heal added in V1d hinges on a stable, narrow fingerprint over a
// FIXED set of tracked env keys (GARRISON_GATEWAY_URL, GARRISON_COMPOSITION_ID).
// These tests pin the fingerprint contract: untracked keys never participate, a
// missing key is distinct from an empty value, and the function is stable across
// calls so the heal can never spuriously fire on a repeat `up`. The integration
// half of the heal (kill + respawn under the per-fitting lock) is covered by the
// runner-eager-lifecycle test the broader suite already exercises.

describe("envFingerprintForExtraEnv (V1d env-drift detection)", () => {
  it("returns a stable 64-char hex digest for any input", () => {
    const fp = envFingerprintForExtraEnv({ GARRISON_GATEWAY_URL: "http://127.0.0.1:4777" });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    const a = envFingerprintForExtraEnv({ GARRISON_GATEWAY_URL: "http://127.0.0.1:4777", GARRISON_COMPOSITION_ID: "default" });
    const b = envFingerprintForExtraEnv({ GARRISON_GATEWAY_URL: "http://127.0.0.1:4777", GARRISON_COMPOSITION_ID: "default" });
    expect(a).toBe(b);
  });

  it("changes when a tracked key's value changes", () => {
    const before = envFingerprintForExtraEnv({ GARRISON_GATEWAY_URL: "http://127.0.0.1:4777" });
    const after = envFingerprintForExtraEnv({ GARRISON_GATEWAY_URL: "http://127.0.0.1:4778" });
    expect(after).not.toBe(before);
  });

  it("does NOT change when an UNTRACKED key changes", () => {
    // If untracked keys leaked in, every dev-env spawn would heal every other
    // fitting on every up — a noisy regression.
    const a = envFingerprintForExtraEnv({ GARRISON_GATEWAY_URL: "http://127.0.0.1:4777", SOMETHING_ELSE: "a" });
    const b = envFingerprintForExtraEnv({ GARRISON_GATEWAY_URL: "http://127.0.0.1:4777", SOMETHING_ELSE: "b" });
    expect(a).toBe(b);
  });

  it("distinguishes a MISSING tracked key from an empty-string value", () => {
    // Critical for the "gateway-not-installed" case: a composition with no
    // gateway has GARRISON_GATEWAY_URL absent. A user that explicitly set
    // GARRISON_GATEWAY_URL='' for some reason is a different intent and must
    // hash differently — otherwise the heal would miss a legitimate drift.
    const absent = envFingerprintForExtraEnv({});
    const empty = envFingerprintForExtraEnv({ GARRISON_GATEWAY_URL: "" });
    expect(empty).not.toBe(absent);
  });

  it("treats undefined extraEnv as the same as {} ", () => {
    // Some call sites don't pass extraEnv; the function must still produce a
    // stable hash (the "all keys absent" hash) and never throw.
    expect(envFingerprintForExtraEnv(undefined)).toBe(envFingerprintForExtraEnv({}));
  });

  it("ignores the order of keys in the input", () => {
    // Object iteration order in JS is insertion-ordered. The fingerprint
    // iterates the TRACKED_KEYS list (fixed order), so two runs that build
    // extraEnv in different key orders still hash identically.
    const a = envFingerprintForExtraEnv({ GARRISON_GATEWAY_URL: "http://127.0.0.1:4777", GARRISON_COMPOSITION_ID: "default" });
    const b = envFingerprintForExtraEnv({ GARRISON_COMPOSITION_ID: "default", GARRISON_GATEWAY_URL: "http://127.0.0.1:4777" });
    expect(a).toBe(b);
  });

  it("a heal-then-restart with the same env produces the SAME fingerprint", () => {
    // Pins the no-loop property: after a heal respawns with the desired env,
    // the next `up` sees fingerprint match → alreadyRunning, no heal.
    const desired = { GARRISON_GATEWAY_URL: "http://127.0.0.1:4777", GARRISON_COMPOSITION_ID: "default" };
    const firstSpawnFingerprint = envFingerprintForExtraEnv(desired);
    const secondSpawnFingerprint = envFingerprintForExtraEnv(desired);
    expect(secondSpawnFingerprint).toBe(firstSpawnFingerprint);
  });
});

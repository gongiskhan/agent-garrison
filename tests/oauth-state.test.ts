import { afterEach, describe, expect, it } from "vitest";
import { createOAuthState, consumeOAuthState, _resetOAuthState } from "@/lib/oauth-state";

// CSRF state for the connector OAuth flow: single-use, connector-bound, expiring.

afterEach(() => _resetOAuthState());

describe("oauth-state (connector connect CSRF)", () => {
  it("round-trips a valid state bound to its connector", () => {
    const s = createOAuthState("google", "http://localhost:3000/cb");
    const bound = consumeOAuthState(s, "google");
    expect(bound?.connector).toBe("google");
    expect(bound?.redirectUri).toBe("http://localhost:3000/cb");
  });

  it("is single-use — a replayed state is rejected", () => {
    const s = createOAuthState("google", "http://localhost/cb");
    expect(consumeOAuthState(s, "google")).not.toBeNull();
    expect(consumeOAuthState(s, "google")).toBeNull(); // replay
  });

  it("rejects a state used for a DIFFERENT connector", () => {
    const s = createOAuthState("google", "http://localhost/cb");
    expect(consumeOAuthState(s, "slack-channel")).toBeNull();
  });

  it("rejects an unknown / forged state", () => {
    expect(consumeOAuthState("not-a-real-state", "google")).toBeNull();
    expect(consumeOAuthState("", "google")).toBeNull();
  });

  it("rejects an expired state", () => {
    const t0 = 1_000_000;
    const s = createOAuthState("google", "http://localhost/cb", t0);
    // 11 minutes later (TTL is 10m)
    expect(consumeOAuthState(s, "google", t0 + 11 * 60 * 1000)).toBeNull();
  });
});

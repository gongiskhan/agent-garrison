import { describe, expect, it } from "vitest";
import {
  GATEWAY_RECOVERY_DELAYS_MS,
  GATEWAY_RECOVERY_WINDOW_MS,
  nextGatewayRecoveryDelay
} from "@/lib/runner";

// A gateway that crashed after becoming ready used to stay dead until a human
// ran the composition again (2026-09-11: four days of dropped scheduled jobs).
// The runner now restarts it, on a budget that a boot-time crash loop exhausts.

describe("gateway crash recovery budget", () => {
  const now = 10 * GATEWAY_RECOVERY_WINDOW_MS;

  it("restarts quickly after the first crash, then backs off", () => {
    expect(nextGatewayRecoveryDelay([], now)).toBe(GATEWAY_RECOVERY_DELAYS_MS[0]);
    expect(nextGatewayRecoveryDelay([now - 1_000], now)).toBe(GATEWAY_RECOVERY_DELAYS_MS[1]);
    expect(nextGatewayRecoveryDelay([now - 2_000, now - 1_000], now)).toBe(GATEWAY_RECOVERY_DELAYS_MS[2]);
  });

  it("gives up once every attempt in the window is spent", () => {
    const spent = GATEWAY_RECOVERY_DELAYS_MS.map((_, i) => now - 1_000 * (i + 1));
    expect(nextGatewayRecoveryDelay(spent, now)).toBeNull();
  });

  it("forgets attempts older than the window, so a crash days later still recovers", () => {
    const old = GATEWAY_RECOVERY_DELAYS_MS.map((_, i) => now - GATEWAY_RECOVERY_WINDOW_MS - 1_000 * (i + 1));
    expect(nextGatewayRecoveryDelay(old, now)).toBe(GATEWAY_RECOVERY_DELAYS_MS[0]);
  });
});

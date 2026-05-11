import { describe, expect, it } from "vitest";
import {
  GARRISON_PORT_RANGE_START,
  GARRISON_PORT_RANGE_END,
  allocatePort,
  allocatePortMap,
  basePort,
  fnv1a32,
  isPortInGarrisonRange
} from "@/lib/worktree/ports";

describe("fnv1a32", () => {
  it("is deterministic for the same input", () => {
    expect(fnv1a32("foo")).toBe(fnv1a32("foo"));
  });

  it("returns different hashes for distinct inputs", () => {
    expect(fnv1a32("main:cortex")).not.toBe(fnv1a32("main:ekoa_app"));
    expect(fnv1a32("main:cortex")).not.toBe(fnv1a32("feature/foo:cortex"));
  });

  it("returns an unsigned 32-bit integer", () => {
    const h = fnv1a32("anything");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
  });
});

describe("basePort", () => {
  it("falls inside the Garrison port range", () => {
    const p = basePort("main", "cortex");
    expect(p).toBeGreaterThanOrEqual(GARRISON_PORT_RANGE_START);
    expect(p).toBeLessThanOrEqual(GARRISON_PORT_RANGE_END);
  });

  it("is stable across calls", () => {
    expect(basePort("feature/foo", "cortex")).toBe(basePort("feature/foo", "cortex"));
  });
});

describe("isPortInGarrisonRange", () => {
  it("returns true for ports in [50000, 54999]", () => {
    expect(isPortInGarrisonRange(50000)).toBe(true);
    expect(isPortInGarrisonRange(54999)).toBe(true);
    expect(isPortInGarrisonRange(52000)).toBe(true);
  });

  it("returns false outside the range", () => {
    expect(isPortInGarrisonRange(3000)).toBe(false);
    expect(isPortInGarrisonRange(49999)).toBe(false);
    expect(isPortInGarrisonRange(55000)).toBe(false);
  });
});

describe("allocatePort", () => {
  it("returns the base port when nothing is in use", async () => {
    const port = await allocatePort("main", "cortex", {
      isInUse: async () => false
    });
    expect(port).toBe(basePort("main", "cortex"));
  });

  it("probes forward when the base port is reserved", async () => {
    const reserved = new Set<number>([basePort("main", "cortex")]);
    const port = await allocatePort("main", "cortex", {
      reserved,
      isInUse: async () => false
    });
    expect(port).toBe(basePort("main", "cortex") + 1);
  });

  it("skips ports reported as in use", async () => {
    const base = basePort("main", "cortex");
    const inUse = new Set<number>([base, base + 1, base + 2]);
    const port = await allocatePort("main", "cortex", {
      isInUse: async (p) => inUse.has(p)
    });
    expect(port).toBe(base + 3);
  });

  it("throws when no port can be found within the probe limit", async () => {
    await expect(
      allocatePort("main", "cortex", { isInUse: async () => true })
    ).rejects.toThrow(/no free port/);
  });
});

describe("allocatePortMap", () => {
  it("returns a port per service and never repeats within the same call", async () => {
    const reserved = new Set<number>();
    const ports = await allocatePortMap("feat/x", ["cortex", "ekoa_app", "api"], {
      reserved,
      isInUse: async () => false
    });
    expect(Object.keys(ports).sort()).toEqual(["api", "cortex", "ekoa_app"]);
    const values = Object.values(ports);
    expect(new Set(values).size).toBe(values.length);
  });
});

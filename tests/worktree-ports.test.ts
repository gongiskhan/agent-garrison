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

describe("port range overrides (env vars + explicit option)", () => {
  it("defaultPortRange reads GARRISON_PORT_RANGE_START / _END at call time", async () => {
    const { defaultPortRange } = await import("@/lib/worktree/ports");
    const before = defaultPortRange();
    expect(before.start).toBe(50000);
    expect(before.end).toBe(54999);

    const oldStart = process.env.GARRISON_PORT_RANGE_START;
    const oldEnd = process.env.GARRISON_PORT_RANGE_END;
    try {
      process.env.GARRISON_PORT_RANGE_START = "30000";
      process.env.GARRISON_PORT_RANGE_END = "30099";
      const next = defaultPortRange();
      expect(next.start).toBe(30000);
      expect(next.end).toBe(30099);
    } finally {
      if (oldStart === undefined) delete process.env.GARRISON_PORT_RANGE_START;
      else process.env.GARRISON_PORT_RANGE_START = oldStart;
      if (oldEnd === undefined) delete process.env.GARRISON_PORT_RANGE_END;
      else process.env.GARRISON_PORT_RANGE_END = oldEnd;
    }
  });

  it("ignores nonsense values and falls back to defaults", async () => {
    const { defaultPortRange } = await import("@/lib/worktree/ports");
    const oldStart = process.env.GARRISON_PORT_RANGE_START;
    const oldEnd = process.env.GARRISON_PORT_RANGE_END;
    try {
      process.env.GARRISON_PORT_RANGE_START = "100";
      process.env.GARRISON_PORT_RANGE_END = "50"; // end < start ⇒ defaults
      const next = defaultPortRange();
      expect(next.start).toBe(50000);
      expect(next.end).toBe(54999);
    } finally {
      if (oldStart === undefined) delete process.env.GARRISON_PORT_RANGE_START;
      else process.env.GARRISON_PORT_RANGE_START = oldStart;
      if (oldEnd === undefined) delete process.env.GARRISON_PORT_RANGE_END;
      else process.env.GARRISON_PORT_RANGE_END = oldEnd;
    }
  });

  it("allocatePort honors an explicit range option", async () => {
    const port = await allocatePort("main", "cortex", {
      isInUse: async () => false,
      range: { start: 4000, end: 4099 }
    });
    expect(port).toBeGreaterThanOrEqual(4000);
    expect(port).toBeLessThanOrEqual(4099);
  });

  it("basePort respects an explicit range option", async () => {
    const { basePort } = await import("@/lib/worktree/ports");
    const range = { start: 4000, end: 4099 };
    const p = basePort("main", "frontend", range);
    expect(p).toBeGreaterThanOrEqual(4000);
    expect(p).toBeLessThanOrEqual(4099);
  });
});

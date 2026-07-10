import { describe, it, expect, vi } from "vitest";
// @ts-ignore — pure .mjs vitals collector (fittings/seed/monitor-default/scripts/vitals.mjs); single-line so @ts-ignore covers the module specifier (TS7016)
import { diskSeverity, parseSystemdUnits, listGarrisonUnits, collectVitals, DISK_WARN_PERCENT, DISK_CRITICAL_PERCENT } from "../fittings/seed/monitor-default/scripts/vitals.mjs";

describe("monitor vitals collector (S10)", () => {
  it("diskSeverity classifies at the 85 / 95 thresholds", () => {
    expect(DISK_WARN_PERCENT).toBe(85);
    expect(DISK_CRITICAL_PERCENT).toBe(95);

    expect(diskSeverity(0)).toBe("ok");
    expect(diskSeverity(84.9)).toBe("ok");
    expect(diskSeverity(85)).toBe("warn"); // boundary is inclusive
    expect(diskSeverity(90)).toBe("warn");
    expect(diskSeverity(94.9)).toBe("warn");
    expect(diskSeverity(95)).toBe("critical"); // boundary is inclusive
    expect(diskSeverity(100)).toBe("critical");
  });

  it("diskSeverity treats unknown values as ok (never a false alarm)", () => {
    expect(diskSeverity(null)).toBe("ok");
    expect(diskSeverity(undefined)).toBe("ok");
    expect(diskSeverity(NaN)).toBe("ok");
    expect(diskSeverity("not a number")).toBe("ok");
  });

  it("parseSystemdUnits parses canned systemctl --plain --no-legend lines", () => {
    const out =
      "garrison-monitor.service loaded active running Garrison Monitor own-port server\n" +
      "garrison-gateway.socket  loaded active listening Garrison Gateway Socket\n";
    const units = parseSystemdUnits(out);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({
      unit: "garrison-monitor.service",
      load: "loaded",
      active: "active",
      sub: "running"
    });
    expect(units[0].description).toBe("Garrison Monitor own-port server");
    expect(units[1].unit).toBe("garrison-gateway.socket");
    expect(units[1].sub).toBe("listening");
  });

  it("parseSystemdUnits returns [] on empty / blank / garbage input", () => {
    expect(parseSystemdUnits("")).toEqual([]);
    expect(parseSystemdUnits("   \n\n  \t\n")).toEqual([]);
    expect(parseSystemdUnits(null)).toEqual([]);
    expect(parseSystemdUnits(undefined)).toEqual([]);
    // Non-unit noise: first token has no systemd suffix -> filtered out.
    expect(parseSystemdUnits("this is not systemd output at all")).toEqual([]);
    expect(parseSystemdUnits("random words with enough columns here too")).toEqual([]);
  });

  it("listGarrisonUnits returns [] on non-Linux platforms without spawning", async () => {
    let spawned = false;
    const exec = async () => {
      spawned = true;
      return { stdout: "garrison-x.service loaded active running x", stderr: "", code: 0 };
    };
    const units = await listGarrisonUnits({ platform: "darwin", exec });
    expect(units).toEqual([]);
    expect(spawned).toBe(false);
  });

  it("listGarrisonUnits parses injected systemctl output on linux", async () => {
    const seen: Array<{ cmd: string; args: string[] }> = [];
    const exec = async (cmd: string, args: string[]) => {
      seen.push({ cmd, args });
      return {
        stdout: "garrison-monitor.service loaded active running Garrison Monitor\n",
        stderr: "",
        code: 0
      };
    };
    const units = await listGarrisonUnits({ platform: "linux", exec });
    expect(units).toHaveLength(1);
    expect(units[0].unit).toBe("garrison-monitor.service");
    expect(seen[0].cmd).toBe("systemctl");
    expect(seen[0].args).toContain("--user");
    expect(seen[0].args).toContain("garrison-*");
  });

  it("listGarrisonUnits degrades to [] when the exec throws", async () => {
    const exec = async () => {
      throw new Error("systemctl not found");
    };
    const units = await listGarrisonUnits({ platform: "linux", exec });
    expect(units).toEqual([]);
  });

  it(
    "collectVitals returns a well-typed sample with cpu / mem / disks / net / units fields",
    async () => {
      // Force the systemd listing to be a no-op regardless of host so the test
      // is deterministic; the real OS metrics still exercise systeminformation.
      const v = await collectVitals({ platform: "test-platform" });

      expect(typeof v.ts).toBe("string");

      // cpu: object with numeric cores + nullable load numbers, or null.
      expect(v.cpu === null || typeof v.cpu === "object").toBe(true);
      if (v.cpu) {
        expect(typeof v.cpu.cores).toBe("number");
        for (const k of ["currentLoad", "load1", "load5", "load15"] as const) {
          expect(v.cpu[k] === null || typeof v.cpu[k] === "number").toBe(true);
        }
      }

      // mem: numeric fields or null.
      expect(v.mem === null || typeof v.mem === "object").toBe(true);
      if (v.mem) {
        expect(typeof v.mem.total).toBe("number");
        expect(typeof v.mem.used).toBe("number");
        expect(typeof v.mem.usePercent).toBe("number");
        expect(v.mem.usePercent).toBeGreaterThanOrEqual(0);
      }

      // disks: array; every row severity-classified and consistent.
      expect(Array.isArray(v.disks)).toBe(true);
      for (const d of v.disks) {
        expect(typeof d.mount).toBe("string");
        expect(typeof d.size).toBe("number");
        expect(d.usePercent === null || typeof d.usePercent === "number").toBe(true);
        expect(["ok", "warn", "critical"]).toContain(d.severity);
        expect(d.severity).toBe(diskSeverity(d.usePercent));
      }

      // net: aggregate throughput or null; per-second values are non-negative.
      expect(v.net === null || typeof v.net === "object").toBe(true);
      if (v.net) {
        expect(typeof v.net.rxSec).toBe("number");
        expect(typeof v.net.txSec).toBe("number");
        expect(v.net.rxSec).toBeGreaterThanOrEqual(0);
        expect(v.net.txSec).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(v.net.interfaces)).toBe(true);
      }

      // units: always an array (empty here because platform is not "linux").
      expect(Array.isArray(v.units)).toBe(true);
      expect(v.units).toEqual([]);
    },
    20000
  );
  it(
    "a hung systeminformation probe degrades to a fallback within the timeout (never wedges the loop)",
    async () => {
      // A stale-NFS fsSize that never resolves must not freeze the whole sample:
      // withTimeout races each si probe and returns the fallback so the poll
      // loop's re-entrancy guard is always released.
      const prev = process.env.MONITOR_SI_TIMEOUT_MS;
      process.env.MONITOR_SI_TIMEOUT_MS = "150";
      const si = (await import("systeminformation")).default;
      const realFsSize = si.fsSize;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (si as any).fsSize = () => new Promise(() => {}); // hang forever
      try {
        const t0 = Date.now();
        const v = await collectVitals({ platform: "linux", exec: async () => ({ stdout: "", code: 0 }) });
        const ms = Date.now() - t0;
        expect(ms).toBeLessThan(2000);       // did NOT hang on fsSize
        expect(v.disks).toEqual([]);         // the stuck field degraded to []
        expect(v.ts).toBeTruthy();           // the sample still completed
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (si as any).fsSize = realFsSize;
        if (prev === undefined) delete process.env.MONITOR_SI_TIMEOUT_MS;
        else process.env.MONITOR_SI_TIMEOUT_MS = prev;
      }
    },
    10000
  );
});

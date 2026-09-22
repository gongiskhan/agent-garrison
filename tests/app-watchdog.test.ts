import { describe, expect, it } from "vitest";

import {
  MAX_HEALS_PER_WINDOW,
  createAppWatchdog,
  healRecordPath,
  resolveUnit,
  startAppWatchdog
} from "../fittings/seed/scheduler/scripts/lib/app-watchdog.mjs";

// The outage this watchdog exists for, on dev-madrid 2026-09-21: SIGTERM
// reached the `next start` child alone, Next called server.close(), and the
// process then never exited because one SSE stream never drained. No listener,
// live pid, `systemctl is-active` saying `active (running)` for nine hours.
// Every test below is one rule that outage taught.

const BUDGET = 60_000;

function harness({
  env,
  heals = [],
  now = 0
}: {
  env: Record<string, string | undefined>;
  heals?: { at: string }[];
  now?: number;
}) {
  const logs: string[] = [];
  const restarted: string[] = [];
  const written: string[] = [];
  let clock = now;
  const watchdog = createAppWatchdog({
    env,
    budgetMs: BUDGET,
    log: (m: string) => logs.push(m),
    now: () => clock,
    readFileSync: (p: string) => {
      if (p === "/proc/self/cgroup") {
        return "0::/user.slice/user-1001.slice/user@1001.service/app.slice/garrison-prod.service\n";
      }
      if (p === healRecordPath(env)) return JSON.stringify({ heals });
      throw new Error(`ENOENT ${p}`);
    },
    writeFileSync: (_p: string, data: string) => void written.push(data),
    restart: async (unit: string) => {
      restarted.push(unit);
      return { queued: true, error: null };
    }
  });
  return { watchdog, logs, restarted, written, tick: (ms: number) => void (clock += ms) };
}

const baseEnv = { GARRISON_HOME: "/tmp/garrison-watchdog-test", INVOCATION_ID: "abc123" };

describe("app watchdog", () => {
  it("restarts the unit once the app has been unreachable for the whole budget", async () => {
    const h = harness({ env: baseEnv });

    expect(await h.watchdog.record({ beat: false, appReachable: false })).toMatchObject({ state: "watching" });
    h.tick(BUDGET - 1);
    expect(await h.watchdog.record({ beat: false, appReachable: false })).toMatchObject({ state: "watching" });
    expect(h.restarted).toEqual([]);

    h.tick(2);
    expect(await h.watchdog.record({ beat: false, appReachable: false })).toMatchObject({
      state: "healed",
      unit: "garrison-prod.service",
      queued: true
    });
    expect(h.restarted).toEqual(["garrison-prod.service"]);
  });

  // The whole point of the separation: a reachable app is never restarted, no
  // matter what else on the beat failed. Restarting every node in the mesh
  // because the state service on dev-madrid blinked would be a far worse
  // outage than the one this prevents.
  it("counts only a probe that threw, not a failed post or an unenrolled node", async () => {
    const h = harness({ env: baseEnv });
    for (const result of [
      { beat: false, reason: "post-failed", appReachable: true },
      { beat: false, reason: "not-enrolled", appReachable: true },
      { beat: false, reason: "no-health", appReachable: null },
      { beat: true, appReachable: true }
    ]) {
      h.tick(BUDGET * 2);
      expect(await h.watchdog.record(result)).toMatchObject({ state: "ok" });
    }
    expect(h.restarted).toEqual([]);
  });

  it("forgets the outage as soon as the app answers again", async () => {
    const h = harness({ env: baseEnv });
    await h.watchdog.record({ beat: false, appReachable: false });
    h.tick(BUDGET - 1);
    await h.watchdog.record({ beat: true, appReachable: true });
    h.tick(BUDGET * 2);

    expect(await h.watchdog.record({ beat: false, appReachable: false })).toMatchObject({ state: "watching" });
    expect(h.restarted).toEqual([]);
    expect(h.logs.some((line) => line.includes("answering again"))).toBe(true);
  });

  // The process that would hold this count in memory is the process the heal
  // kills, so the cap lives in a file or it does not hold at all.
  it("stops after three heals in an hour rather than looping", async () => {
    const recent = [
      { at: new Date(0).toISOString() },
      { at: new Date(1_000).toISOString() },
      { at: new Date(2_000).toISOString() }
    ];
    expect(recent).toHaveLength(MAX_HEALS_PER_WINDOW);
    const h = harness({ env: baseEnv, heals: recent, now: 3_000 });

    await h.watchdog.record({ beat: false, appReachable: false });
    h.tick(BUDGET + 1);
    expect(await h.watchdog.record({ beat: false, appReachable: false })).toMatchObject({
      state: "capped",
      heals: MAX_HEALS_PER_WINDOW
    });
    expect(h.restarted).toEqual([]);
    expect(h.logs.some((line) => line.includes("needs a human"))).toBe(true);
  });

  it("records each heal so the cap survives the restart it just caused", async () => {
    const h = harness({ env: baseEnv });
    await h.watchdog.record({ beat: false, appReachable: false });
    h.tick(BUDGET + 1);
    await h.watchdog.record({ beat: false, appReachable: false });

    expect(h.written).toHaveLength(1);
    const record = JSON.parse(h.written[0]);
    expect(record.heals).toHaveLength(1);
    expect(record.heals[0]).toMatchObject({ unit: "garrison-prod.service" });
  });

  it("says it cannot heal exactly once, not once per beat", async () => {
    const h = harness({ env: { GARRISON_HOME: baseEnv.GARRISON_HOME } });
    await h.watchdog.record({ beat: false, appReachable: false });
    for (let i = 0; i < 4; i += 1) {
      h.tick(BUDGET + 1);
      expect(await h.watchdog.record({ beat: false, appReachable: false })).toMatchObject({ state: "no-unit" });
    }
    expect(h.logs.filter((line) => line.includes("restart the instance by hand"))).toHaveLength(1);
    expect(h.restarted).toEqual([]);
  });

  it("is switched off by GARRISON_DISABLE_APP_WATCHDOG", () => {
    expect(startAppWatchdog({ env: { ...baseEnv, GARRISON_DISABLE_APP_WATCHDOG: "1" } })).toBeNull();
    expect(startAppWatchdog({ env: baseEnv })).not.toBeNull();
  });
});

describe("app watchdog unit resolution", () => {
  const cgroup = (body: string) => (p: string) => {
    if (p === "/proc/self/cgroup") return body;
    throw new Error(`ENOENT ${p}`);
  };

  it("names the innermost unit, never the user manager it is nested in", () => {
    expect(
      resolveUnit({
        env: { INVOCATION_ID: "x" },
        readFileSync: cgroup("0::/user.slice/user-1001.slice/user@1001.service/app.slice/garrison-prod.service\n")
      })
    ).toBe("garrison-prod.service");
  });

  // Restarting user@1001.service would take the entire login session with it.
  it("refuses the user manager when it is the innermost thing there", () => {
    expect(
      resolveUnit({
        env: { INVOCATION_ID: "x" },
        readFileSync: cgroup("0::/user.slice/user-1001.slice/user@1001.service\n")
      })
    ).toBeNull();
  });

  it("heals nothing for a scheduler started by hand in a terminal", () => {
    expect(
      resolveUnit({
        env: { INVOCATION_ID: "x" },
        readFileSync: cgroup("0::/user.slice/user-1001.slice/session.scope\n")
      })
    ).toBeNull();
  });

  // INVOCATION_ID comes from systemd and nothing else sets it, so its absence
  // settles the question before the cgroup is even read - which is what keeps
  // a Mac node under launchd from trying to run systemctl.
  it("heals nothing without systemd's own marker in the env", () => {
    expect(
      resolveUnit({
        env: {},
        readFileSync: cgroup("0::/user.slice/user-1001.slice/app.slice/garrison-prod.service\n")
      })
    ).toBeNull();
  });
});

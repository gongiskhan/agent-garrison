import { describe, expect, it } from "vitest";
import {
  parseIdleSeconds,
  isRemoteFrom,
  parseW,
  sessionsSignal,
  kanbanSignal,
  presenceSignal,
  sshSignal,
  loadSignal,
  keepAwakeSignal,
  aggregateSignals,
  tickCountdown,
  awakeMillis,
  awakeHoursSummary
} from "../fittings/seed/power-default/lib/power-core.mjs";
import { suspendSelf, suspendUrl } from "../fittings/seed/power-default/lib/gcp-suspend.mjs";

// Module shapes for the .mjs libs live in tests/power-mjs.d.ts (allowJs is off).

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// ── (d) SSH idle parsing ─────────────────────────────────────────────────────

describe("parseIdleSeconds — every w idle format", () => {
  it("seconds SS.CCs", () => expect(parseIdleSeconds("10.00s")).toBe(10));
  it("MM:SS", () => expect(parseIdleSeconds("3:20")).toBe(200));
  it("HH:MMm (trailing m = hours:minutes)", () => expect(parseIdleSeconds("2:01m")).toBe(2 * 3600 + 60));
  it("Ndays", () => expect(parseIdleSeconds("5days")).toBe(5 * 86400));
  it("dash / empty → 0 (active)", () => {
    expect(parseIdleSeconds("-")).toBe(0);
    expect(parseIdleSeconds("")).toBe(0);
  });
});

describe("isRemoteFrom", () => {
  it("remote IPs / hostnames are remote", () => {
    expect(isRemoteFrom("203.0.113.9")).toBe(true);
    expect(isRemoteFrom("laptop.local")).toBe(true);
  });
  it("local console markers are not remote", () => {
    expect(isRemoteFrom("-")).toBe(false);
    expect(isRemoteFrom(":0")).toBe(false);
    expect(isRemoteFrom("localhost")).toBe(false);
    expect(isRemoteFrom("tmux(1234).%0")).toBe(false);
  });
});

describe("parseW", () => {
  it("parses positional columns with a spaced WHAT tail", () => {
    const out = "ggomes   tty2     -                Thu09   2:01m  1:46m  0.04s /usr/libexec/gnome-session-binary --session=ubuntu\n";
    const [s] = parseW(out);
    expect(s.user).toBe("ggomes");
    expect(s.tty).toBe("tty2");
    expect(s.from).toBe("-");
    expect(s.idle).toBe("2:01m");
    expect(s.what).toBe("/usr/libexec/gnome-session-binary --session=ubuntu");
    expect(s.remote).toBe(false);
    expect(s.idleSeconds).toBe(2 * 3600 + 60);
  });
});

describe("sshSignal — attached-idle does NOT block, active does", () => {
  const canned =
    "ggomes   pts/0    203.0.113.9      10:00    5.00s  0.10s  0.05s -bash\n" + // active SSH (5s idle)
    "ggomes   pts/1    198.51.100.2     09:00    45:00  1:00   0.20s vim\n" + // idle SSH 45m — attached, idle
    "ggomes   tty2     -                Thu09    1.00s  1:46m  0.04s /usr/libexec/gnome-session\n"; // local, active but not SSH

  it("an active SSH session (idle < window) blocks", () => {
    const sig = sshSignal(parseW(canned), { idleMinutes: 30 });
    expect(sig.blocking).toBe(true);
    expect(sig.value).toBe(1); // only the 5s SSH session is active
    expect(sig.detail.attached).toBe(2); // both remote sessions are attached
  });

  it("an attached-but-idle SSH session (idle >= window) does NOT block", () => {
    const onlyIdle =
      "ggomes   pts/1    198.51.100.2     09:00    45:00  1:00   0.20s vim\n" +
      "ggomes   tty2     -                Thu09    2.00s  1:46m  0.04s /usr/libexec/gnome-session\n";
    const sig = sshSignal(parseW(onlyIdle), { idleMinutes: 30 });
    expect(sig.blocking).toBe(false);
    expect(sig.value).toBe(0);
    expect(sig.detail.attached).toBe(1);
  });
});

// ── (a) working sessions + staleness ─────────────────────────────────────────

describe("sessionsSignal — working within 10m window; stale does not count", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");
  const state = {
    projects: {
      "/p": {
        sessions: {
          fresh: { lastStatus: "working", lastStatusAt: new Date(now - 1 * MIN).toISOString() },
          stale: { lastStatus: "working", lastStatusAt: new Date(now - 20 * MIN).toISOString() },
          waiting: { lastStatus: "waiting", lastStatusAt: new Date(now - 1 * MIN).toISOString() }
        }
      }
    }
  };
  it("counts only the fresh working session", () => {
    const sig = sessionsSignal(state, { now });
    expect(sig.value).toBe(1);
    expect(sig.blocking).toBe(true);
  });
  it("no fresh working sessions → not blocking", () => {
    const onlyStale = { projects: { "/p": { sessions: { stale: state.projects["/p"].sessions.stale } } } };
    expect(sessionsSignal(onlyStale, { now }).blocking).toBe(false);
  });
});

// ── (b) kanban in-flight lanes ───────────────────────────────────────────────

describe("kanbanSignal — running anywhere OR an agent list while ok", () => {
  const board = {
    lists: [
      { id: "backlog", kind: "manual" },
      { id: "plan", kind: "agent" },
      { id: "discuss", kind: "agent-interactive" }
    ]
  };
  it("counts running + agent-list-ok, ignores manual-ok + needs-attention", () => {
    const cards = [
      { list: "plan", status: "ok" }, // agent list + ok → in-flight
      { list: "backlog", status: "running" }, // running anywhere → in-flight
      { list: "backlog", status: "ok" }, // manual + ok → not
      { list: "plan", status: "needs-attention" } // agent + needs-attention → not
    ];
    const sig = kanbanSignal(cards, board);
    expect(sig.value).toBe(2);
    expect(sig.blocking).toBe(true);
  });
  it("empty board / no cards → not blocking", () => {
    expect(kanbanSignal([], board).blocking).toBe(false);
    expect(kanbanSignal([{ list: "backlog", status: "ok" }], board).blocking).toBe(false);
  });
});

// ── (c) presence ─────────────────────────────────────────────────────────────

describe("presenceSignal — any heartbeat within the idle window blocks", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");
  it("a heartbeat 2m ago blocks; picks the most-recent as value", () => {
    const records = [
      { source: "web", at: new Date(now - 40 * MIN).toISOString() },
      { source: "dev-env", at: new Date(now - 2 * MIN).toISOString() }
    ];
    const sig = presenceSignal(records, { now, idleMinutes: 30 });
    expect(sig.blocking).toBe(true);
    expect(sig.value).toBe(new Date(now - 2 * MIN).toISOString());
  });
  it("all heartbeats older than the window → not blocking", () => {
    const records = [{ source: "web", at: new Date(now - 40 * MIN).toISOString() }];
    expect(presenceSignal(records, { now, idleMinutes: 30 }).blocking).toBe(false);
  });
});

// ── (e) load + (f) keep-awake ────────────────────────────────────────────────

describe("loadSignal", () => {
  it("over threshold blocks", () => expect(loadSignal(1.5, 1.0).blocking).toBe(true));
  it("at/under threshold does not block", () => {
    expect(loadSignal(1.0, 1.0).blocking).toBe(false);
    expect(loadSignal(0.5, 1.0).blocking).toBe(false);
  });
});

describe("keepAwakeSignal — active while now < until", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");
  it("future until → active/blocking", () => {
    expect(keepAwakeSignal({ until: new Date(now + HOUR).toISOString() }, { now }).blocking).toBe(true);
  });
  it("past until → expired/not blocking", () => {
    expect(keepAwakeSignal({ until: new Date(now - HOUR).toISOString() }, { now }).blocking).toBe(false);
  });
  it("no pin → not blocking", () => {
    expect(keepAwakeSignal(null, { now }).blocking).toBe(false);
  });
});

// ── aggregation + eval-error → busy ──────────────────────────────────────────

describe("aggregateSignals", () => {
  it("busy if ANY signal blocks", () => {
    expect(aggregateSignals([{ blocking: false }, { blocking: true }]).busy).toBe(true);
  });
  it("not busy if every signal is clear", () => {
    expect(aggregateSignals([{ blocking: false }, { blocking: false }]).busy).toBe(false);
  });
  it("an evaluation error counts as busy (fail safe)", () => {
    expect(aggregateSignals([{ blocking: false, error: "boom" }]).busy).toBe(true);
  });
});

// ── continuous-clear countdown (injectable clock) ────────────────────────────

describe("tickCountdown — continuous-clear then suspend", () => {
  const idleMinutes = 30;
  const idleMs = idleMinutes * MIN;
  const t0 = Date.parse("2026-07-10T12:00:00.000Z");

  it("first clear tick anchors clearSince and shows the full window", () => {
    const s = tickCountdown({ clearSince: null }, { busy: false, now: t0, idleMinutes });
    expect(s.clearSince).toBe(t0);
    expect(s.remainingMs).toBe(idleMs);
    expect(s.suspend).toBe(false);
  });

  it("counts down while clear", () => {
    let s = tickCountdown({ clearSince: null }, { busy: false, now: t0, idleMinutes });
    s = tickCountdown(s, { busy: false, now: t0 + 10 * MIN, idleMinutes });
    expect(s.remainingMs).toBe(20 * MIN);
    expect(s.suspend).toBe(false);
  });

  it("a busy tick resets the timer", () => {
    let s = tickCountdown({ clearSince: null }, { busy: false, now: t0, idleMinutes });
    s = tickCountdown(s, { busy: true, now: t0 + 10 * MIN, idleMinutes });
    expect(s.clearSince).toBe(null);
    expect(s.remainingMs).toBe(idleMs);
    expect(s.suspend).toBe(false);
  });

  it("suspends once clear for the full idle window", () => {
    let s = tickCountdown({ clearSince: null }, { busy: false, now: t0, idleMinutes });
    s = tickCountdown(s, { busy: false, now: t0 + idleMs, idleMinutes });
    expect(s.suspend).toBe(true);
    expect(s.remainingMs).toBe(0);
  });
});

// ── awake-hours from a canned log ────────────────────────────────────────────

describe("awake-hours — wall-clock minus measured sleep gaps", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");
  // One measured suspend: slept for 1h, resume observed at now-1h → asleep over
  // [now-2h, now-1h].
  const log = [{ kind: "resume-detected", at: new Date(now - 1 * HOUR).toISOString(), gapSeconds: 3600 }];

  it("subtracts the sleep interval inside the window", () => {
    const windowStart = now - 6 * HOUR; // 6h window, 1h of it asleep
    expect(awakeMillis(log, windowStart, now)).toBe(5 * HOUR);
  });

  it("today + 7d summary", () => {
    const summary = awakeHoursSummary(log, { now, dayStartMs: now - 6 * HOUR });
    expect(summary.today).toBeCloseTo(5, 5);
    expect(summary.last7d).toBeCloseTo(7 * 24 - 1, 5);
  });

  it("ignores non-resume entries and malformed gaps", () => {
    const noisy = [
      { kind: "suspend-requested", at: new Date(now - 3 * HOUR).toISOString() },
      { kind: "resume-detected", at: new Date(now - 1 * HOUR).toISOString(), gapSeconds: "bad" }
    ];
    expect(awakeMillis(noisy, now - 6 * HOUR, now)).toBe(6 * HOUR);
  });
});

// ── gcp-suspend with injectable fetch ────────────────────────────────────────

function resp(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

// Fake fetch: answers the four metadata reads, delegates the suspend POST.
function metaFetch(onSuspend: (url: string, opts: any) => any) {
  const calls: Array<{ url: string; opts: any }> = [];
  const f = async (u: unknown, opts?: any) => {
    const url = String(u);
    calls.push({ url, opts });
    if (url.endsWith("/service-accounts/default/token")) {
      return resp(200, { access_token: "TOK123", expires_in: 3599, token_type: "Bearer" });
    }
    if (url.endsWith("/project/project-id")) return resp(200, "my-project");
    if (url.endsWith("/instance/zone")) return resp(200, "projects/123/zones/us-central1-a");
    if (url.endsWith("/instance/name")) return resp(200, "my-instance");
    if (url.includes("compute.googleapis.com")) return onSuspend(url, opts);
    throw new Error("unexpected fetch: " + url);
  };
  (f as any).calls = calls;
  return f as any;
}

const EXPECTED_URL =
  "https://compute.googleapis.com/compute/v1/projects/my-project/zones/us-central1-a/instances/my-instance/suspend";

describe("gcp-suspend", () => {
  it("suspendUrl builds the Compute Engine suspend endpoint", () => {
    expect(suspendUrl({ project: "my-project", zone: "us-central1-a", name: "my-instance" })).toBe(EXPECTED_URL);
  });

  it("issues a correctly-shaped POST (right URL + Bearer token)", async () => {
    let seen: any = null;
    const fetchImpl = metaFetch((url, opts) => {
      seen = { url, opts };
      return resp(200, { name: "operation-123", status: "RUNNING" });
    });
    const result = await suspendSelf({ fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(seen.url).toBe(EXPECTED_URL);
    expect(seen.opts.method).toBe("POST");
    expect(seen.opts.headers.Authorization).toBe("Bearer TOK123");
    expect(result.request).toEqual({ method: "POST", url: EXPECTED_URL });
  });

  it("a 403 scope error becomes a suspend-failed result and never throws", async () => {
    const fetchImpl = metaFetch(() =>
      resp(403, {
        error: { code: 403, message: "Request had insufficient authentication scopes.", status: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }
      })
    );
    const result = await suspendSelf({ fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("insufficient authentication scopes");
    expect(result.request.url).toBe(EXPECTED_URL);
  });

  it("a thrown fetch is caught (the watcher is never killed)", async () => {
    const fetchImpl = metaFetch(() => {
      throw new Error("network down");
    });
    const result = await suspendSelf({ fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(null);
    expect(result.error).toContain("network down");
  });

  it("a metadata failure is caught before any suspend call", async () => {
    const fetchImpl = async (u: unknown) => {
      if (String(u).endsWith("/service-accounts/default/token")) return resp(500, "boom");
      throw new Error("should not reach here");
    };
    const result = await suspendSelf({ fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(null);
    expect(result.request).toBe(null);
  });

  it("returns a graceful result when no fetch is available", async () => {
    const result = await suspendSelf({ fetchImpl: undefined as any });
    expect(result.ok).toBe(false);
  });
});

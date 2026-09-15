import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// A 202 from /jobs only means the briefing turn was queued. On 2026-09-11 the
// gateway crashed and refused every fire for four days; on 2026-09-15 the turn
// died on an API 429 after the ack. The WhatsApp delivery watcher confirms the
// briefing left, re-fires once, and finally sends a plain briefing built from
// the data the script already gathered. These tests pin its timing policy and
// the fallback text without a gateway or a phone.

const SCRIPTS = path.resolve(__dirname, "../fittings/seed/morning-briefing/scripts");

function py(code: string): any {
  const r = spawnSync("python3", ["-c", `import json, briefing as b\n${code}`], {
    cwd: SCRIPTS,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

const MIN = 60;

function plan(state: Record<string, unknown>, elapsedMin: number, delivered = false): string {
  return py(
    `s = json.loads(${JSON.stringify(JSON.stringify(state))})\n` +
      `print(json.dumps(b.plan_watch_action(s, s["fired_at"] + ${elapsedMin * MIN}, ${delivered ? "True" : "False"})))`
  );
}

describe("morning-briefing delivery watcher", () => {
  const posted = { fired_at: 1000, posts: [1000], attempts: 1 };

  it("stops as soon as the briefing is seen leaving", () => {
    expect(plan(posted, 1, true)).toBe("done");
    expect(plan(posted, 60, true)).toBe("done");
  });

  it("waits for a queued turn, then re-fires once", () => {
    expect(plan(posted, 5)).toBe("wait");
    expect(plan(posted, 15)).toBe("retry");
    const retried = { fired_at: 1000, posts: [1000, 1000 + 15 * MIN], attempts: 2 };
    expect(plan(retried, 20)).toBe("wait");
  });

  it("falls back only when no turn is still fresh, so it never races a slow one", () => {
    const retried = { fired_at: 1000, posts: [1000, 1000 + 30 * MIN], attempts: 2 };
    expect(plan(retried, 40)).toBe("wait");
    expect(plan(retried, 45)).toBe("fallback");
  });

  it("keeps knocking while the gateway is down, then falls back", () => {
    const unposted = { fired_at: 1000, posts: [], attempts: 1 };
    expect(plan(unposted, 1)).toBe("post");
    expect(plan(unposted, 40)).toBe("fallback");
    expect(plan(unposted, 95)).toBe("give-up");
  });

  it("builds a plain Portuguese briefing that says which source failed", () => {
    const text: string = py(
      `print(json.dumps(b.fallback_text({"date": "2026-09-15", "sources": {` +
        `"events": [{"when": "2026-09-15T10:30:00+01:00", "summary": "Dentista"}, {"when": "2026-09-15", "summary": "Feriado"}],` +
        `"events_error": None, "tasks": None, "tasks_error": "not connected"}})))`
    );
    expect(text).toContain("Briefing 15/09 (terça)");
    expect(text).toContain("• 10:30 Dentista");
    expect(text).toContain("• dia todo Feriado");
    expect(text).toContain("A Fazer: indisponível (not connected)");
  });

  it("gives a retry its own payload hash, leaving the first fire's payload unchanged", () => {
    const bodies = py(
      `import os\nos.environ["GARRISON_BRIEFING_DELIVERY"] = "stdout"\nfrom datetime import date\n` +
        `src = {"events": [], "events_error": None, "tasks": [], "tasks_error": None}\n` +
        `print(json.dumps([b.job_body(date(2026, 9, 15), src), b.job_body(date(2026, 9, 15), src, 2)]))`
    );
    expect(bodies[0]).not.toHaveProperty("attempt");
    expect(bodies[1].attempt).toBe(2);
  });
});

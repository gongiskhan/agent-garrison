import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  normalizeDecision,
  readDecisionsTail,
  readRoutingInferenceStatus,
  DECISIONS_REL,
  MAX_DECISIONS_LIMIT,
  type DecisionView
} from "@/lib/decisions-feed";

// S5c — the Muster Decisions panel reads the tail of a composition's routing
// decisions log and normalizes heterogeneous records into {at, kind, duty, level,
// target, reason}. Pure shaping is unit-tested via normalizeDecision; the tail
// reader is tested against a real .garrison/decisions.jsonl.

const DIRS: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "muster-decisions-"));
  DIRS.push(dir);
  return dir;
}
async function writeLog(dir: string, lines: string[]): Promise<void> {
  const file = path.join(dir, DECISIONS_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
}
afterEach(async () => {
  while (DIRS.length) {
    const dir = DIRS.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("normalizeDecision", () => {
  it("normalizes a Dispatcher record and trusts its code-composed reason", () => {
    const v = normalizeDecision({
      kind: "dispatch",
      at: "2026-07-13T10:00:00.000Z",
      messageDigest: "abc123",
      duty: "develop",
      level: 2,
      confidence: "high",
      reason: "→ develop L2, confidence high"
    });
    expect(v).toEqual<DecisionView>({
      // Derived, because this record carries no `id` — the ~3800 already on disk
      // never will, and a row with no handle is a row the user cannot judge.
      id: expect.stringMatching(/^[0-9a-f]{16}$/) as unknown as string,
      at: "2026-07-13T10:00:00.000Z",
      kind: "dispatch",
      duty: "develop",
      flow: null,
      level: 2,
      target: null,
      reason: "→ develop L2, confidence high",
      // The run dimensions this record does not carry stay null - the feed reports
      // what was logged and never fills a gap with a guess.
      runtime: null,
      model: null,
      effort: null,
      tier: null,
      taskType: null,
      via: null,
      classifierSkipped: null,
      // The digest IS surfaced - it is the safe correlation handle (a sha256
      // prefix, never the raw message; codex S5b/S5c).
      messageDigest: "abc123",
      // Absent on this record: it predates session capture, which is exactly the
      // case the panel must render as "no link" rather than a dead one.
      sessionId: null,
      sessionTitle: null,
      source: null,
      inferenceUsed: null,
      dispatchOk: null,
      latencyMs: null,
      failureCode: null
    });
  });

  it("gives every record a STABLE handle, distinct per line, and prefers a written id", () => {
    const raw = { at: "2026-07-13T10:00:00.000Z", promptDigest: "abc123", targetId: "cc-opus-high" };
    // Same record + same position → same id, so a verdict survives a re-read.
    expect(normalizeDecision(raw, 7)!.id).toBe(normalizeDecision(raw, 7)!.id);
    // A misroute appends a SECOND full copy of a decision with the same timestamp,
    // digest and target. Keyed on content alone a verdict would land on both, so
    // the line position disambiguates them.
    expect(normalizeDecision(raw, 7)!.id).not.toBe(normalizeDecision(raw, 8)!.id);
    // A record the gateway stamped keeps ITS id rather than a derived one.
    expect(normalizeDecision({ ...raw, id: "written00000000" }, 7)!.id).toBe("written00000000");
  });

  it("surfaces the run dimensions as fields instead of burying them in the reason", () => {
    const v = normalizeDecision({
      at: "2026-07-13T10:00:00.000Z",
      taskType: "implement",
      tier: "T2-deep",
      targetId: "cc-opus-high",
      runtime: "agent-sdk",
      model: "opus",
      effort: "high",
      via: "turn-override",
      classifierSkipped: true
    })!;
    expect(v).toMatchObject({
      runtime: "agent-sdk",
      model: "opus",
      effort: "high",
      tier: "T2-deep",
      taskType: "implement",
      via: "turn-override",
      classifierSkipped: true
    });
  });

  it("classifies a routed record (no explicit kind) and maps targetId → target", () => {
    const v = normalizeDecision({
      at: "2026-07-13T10:01:00.000Z",
      promptDigest: "def456",
      taskType: "code",
      tier: "expert",
      role: "runtimes",
      targetId: "cc-sonnet",
      runtime: "claude-code",
      model: "sonnet"
    })!;
    expect(v.kind).toBe("route");
    expect(v.target).toBe("cc-sonnet");
    expect(v.duty).toBeNull();
    expect(v.reason).toContain("code");
    expect(v.reason).toContain("runtimes");
  });

  it("classifies a placement record (channel + mode)", () => {
    const v = normalizeDecision({
      at: "2026-07-13T10:02:00.000Z",
      taskType: "chat",
      role: "channels",
      channel: "dev-env",
      mode: "joe"
    })!;
    expect(v.kind).toBe("placement");
    expect(v.reason).toContain("dev-env:joe");
  });

  it("flags a misrouted (honored:false) record", () => {
    const v = normalizeDecision({ at: "x", taskType: "code", role: "runtimes", honored: false })!;
    expect(v.reason).toContain("misrouted");
  });

  it("returns null for a non-object line", () => {
    expect(normalizeDecision(null)).toBeNull();
    expect(normalizeDecision("a string")).toBeNull();
    expect(normalizeDecision([1, 2, 3])).toBeNull();
  });

  it("NEVER surfaces a path or arbitrary field — only the whitelisted keys", () => {
    const v = normalizeDecision({
      at: "x",
      kind: "dispatch",
      duty: "develop",
      level: 1,
      reason: "→ develop L1",
      // hostile / leaky fields that must not survive normalization:
      promptPath: "/home/ggomes/.garrison/secret.txt",
      rawMessage: "my private prompt text",
      apiKey: "sk-should-never-appear"
    })!;
    // The list GREW for RUN-SPEC-V1 (id + the run dimensions a verdict is given
    // about), and it is still a closed list of scalars. Every addition is a value
    // the writer already logged - no new source, no free text, no paths.
    expect(Object.keys(v).sort()).toEqual([
      "at",
      "classifierSkipped",
      "dispatchOk",
      "duty",
      "effort",
      "failureCode",
      "flow",
      "id",
      "inferenceUsed",
      "kind",
      "latencyMs",
      "level",
      "messageDigest",
      "model",
      "reason",
      "runtime",
      "sessionId",
      "sessionTitle",
      "source",
      "target",
      "taskType",
      "tier",
      "via"
    ]);
    const serialized = JSON.stringify(v);
    expect(serialized).not.toContain("/home/");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("sk-should-never-appear");
  });
});

describe("readDecisionsTail", () => {
  it("returns [] when the log is absent", async () => {
    const dir = await tmpDir();
    expect(await readDecisionsTail(dir)).toEqual([]);
  });

  it("returns the tail NEWEST FIRST, skipping unparseable lines", async () => {
    const dir = await tmpDir();
    await writeLog(dir, [
      JSON.stringify({ kind: "dispatch", at: "t1", duty: "a", level: 1, reason: "r1" }),
      "{ not json",
      JSON.stringify({ kind: "dispatch", at: "t2", duty: "b", level: 2, reason: "r2" }),
      JSON.stringify({ kind: "dispatch", at: "t3", duty: "c", level: 3, reason: "r3" })
    ]);
    const feed = await readDecisionsTail(dir, 10);
    expect(feed.map((d) => d.duty)).toEqual(["c", "b", "a"]);
  });

  it("respects the limit (most recent N)", async () => {
    const dir = await tmpDir();
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ kind: "dispatch", at: `t${i}`, duty: `d${i}`, level: 1, reason: "r" })
    );
    await writeLog(dir, lines);
    const feed = await readDecisionsTail(dir, 2);
    expect(feed.map((d) => d.duty)).toEqual(["d4", "d3"]);
  });

  it("clamps an over-large limit to the max", async () => {
    const dir = await tmpDir();
    const lines = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({ kind: "dispatch", at: `t${i}`, duty: `d${i}`, level: 1, reason: "r" })
    );
    await writeLog(dir, lines);
    const feed = await readDecisionsTail(dir, MAX_DECISIONS_LIMIT + 9999);
    expect(feed.length).toBe(3);
  });
});

describe("readRoutingInferenceStatus", () => {
  it("reports latest degraded reason/latency and a cumulative fallback count", async () => {
    const dir = await tmpDir();
    await writeLog(dir, [
      JSON.stringify({ kind: "dispatch", at: "t1", source: "model", dispatchOk: true, latencyMs: 32, runtime: "agent-sdk", model: "claude-haiku-4-5" }),
      JSON.stringify({ kind: "route", at: "ignored" }),
      JSON.stringify({ kind: "dispatch", at: "t2", source: "fallback", dispatchOk: false, failureCode: "timeout", latencyMs: 8001, runtime: "agent-sdk", model: "claude-haiku-4-5" })
    ]);
    expect(await readRoutingInferenceStatus(dir)).toEqual({
      total: 2,
      fallbackCount: 1,
      degraded: true,
      latest: { at: "t2", source: "fallback", dispatchOk: false, latencyMs: 8001, failureCode: "timeout", runtime: "agent-sdk", model: "claude-haiku-4-5" }
    });
  });
});

describe("decisions-feed codex fix — reason sanitization + digest", () => {
  it("redacts a raw path/secret in a dispatch reason and surfaces the digest", async () => {
    const { normalizeDecision } = await import("@/lib/decisions-feed");
    const v = normalizeDecision({
      kind: "dispatch", at: "t", messageDigest: "abc123", duty: "develop", level: 1,
      reason: "raw user message: my password is secret and path /home/ggomes/.ssh/id_rsa"
    });
    expect(v).not.toBeNull();
    expect(v!.messageDigest).toBe("abc123");
    expect(v!.reason).not.toContain("/home/ggomes");
    expect(v!.reason).not.toContain("id_rsa");
    expect(v!.reason).toContain("[path]");
    expect(v!.reason).toContain("[redacted]");
  });
})

describe("normalizeDecision session linkage", () => {
  it("surfaces the session handle under either spelling so the feed can link back", () => {
    // The web channel names its conversation key `thread`; other hosts send
    // `sessionId`. Both must resolve, or the Decisions feed links only for some
    // surfaces.
    expect(normalizeDecision({ kind: "route", sessionId: "abc-123" })!.sessionId).toBe("abc-123");
    expect(normalizeDecision({ kind: "route", thread: "wc-9" })!.sessionId).toBe("wc-9");
    expect(normalizeDecision({ kind: "route" })!.sessionId).toBeNull();
  });

  it("sanitizes a session TITLE like any other human-authored field", () => {
    // Unlike the id, a title is user/host text, so it gets the same redaction as
    // `reason` - a leaky title must not become a leak just because it is a label.
    const leaky = normalizeDecision({
      kind: "route",
      sessionId: "s1",
      sessionTitle: "notes in /home/ggomes/private/plan.md"
    })!;
    expect(leaky.sessionTitle).not.toContain("/home/ggomes");
    expect(leaky.sessionTitle).toContain("[path]");

    const long = normalizeDecision({ kind: "route", sessionId: "s1", sessionTitle: "x".repeat(200) })!;
    expect(long.sessionTitle!.length).toBeLessThanOrEqual(81);

    // Blank/whitespace titles collapse to null rather than rendering an empty link.
    expect(normalizeDecision({ kind: "route", sessionTitle: "   " })!.sessionTitle).toBeNull();
  });
});

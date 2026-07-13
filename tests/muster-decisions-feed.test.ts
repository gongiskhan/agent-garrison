import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  normalizeDecision,
  readDecisionsTail,
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
      at: "2026-07-13T10:00:00.000Z",
      kind: "dispatch",
      duty: "develop",
      level: 2,
      target: null,
      reason: "→ develop L2, confidence high",
      messageDigest: null
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

  it("NEVER surfaces a path or arbitrary field — only the 6 whitelisted keys", () => {
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
    expect(Object.keys(v).sort()).toEqual(["at", "duty", "kind", "level", "reason", "target"]);
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

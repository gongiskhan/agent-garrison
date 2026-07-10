import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Drives the real installed USER-scope skill script. The Kanban Validate list
// invokes exactly this file, so the test exercises the shipped artifact, not a copy.
const SCRIPT = path.join(os.homedir(), ".claude", "skills", "autothing-validate", "scripts", "validate.mjs");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gar-validate-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a slice gate-status.json under a fresh runDir and return [runDir, sliceId]. */
function makeRun(sliceId: string, gateStatus: Record<string, unknown>): [string, string] {
  const runDir = fs.mkdtempSync(path.join(dir, "run-"));
  const sliceDir = path.join(runDir, "slices", sliceId);
  fs.mkdirSync(sliceDir, { recursive: true });
  fs.writeFileSync(path.join(sliceDir, "gate-status.json"), JSON.stringify(gateStatus, null, 2) + "\n");
  return [runDir, sliceId];
}

function readMarker(runDir: string, sliceId: string): any {
  const raw = fs.readFileSync(path.join(runDir, "slices", sliceId, "gate-status.json"), "utf8");
  return JSON.parse(raw);
}

/** Run the script; return [lastNonEmptyLine, fullStdout]. */
function runValidate(runDir: string, sliceId: string, extra: string[] = []): [string, string] {
  let stdout: string;
  try {
    stdout = execFileSync("node", [SCRIPT, runDir, sliceId, ...extra], { encoding: "utf8" });
  } catch (e: any) {
    // --strict exits non-zero on Fail; capture its stdout anyway.
    stdout = (e.stdout ?? "").toString();
    if (!stdout) throw e;
  }
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return [lines[lines.length - 1], stdout];
}

const PASSING_GATES = (sliceId: string) => ({
  slice: sliceId,
  title: "passing slice",
  kind: "ui",
  gates: {
    tests: { exit: 0 },
    typecheck: { exit: 0 },
    lint: { exit: 0 },
    build: { exit: 0 },
    e2e: { exit: 0 },
    designAudit: { verdict: "clean" },
    // 2026-07-07 decorrelation rename: the per-slice review is the fresh-context
    // adversarialReview; the independent test pass is adversarialTest.
    adversarialReview: { verdict: "approve" },
    adversarialTest: { result: "pass" },
    video: { status: "verified" }
  }
});

describe("autothing-validate validate.mjs", () => {
  it("ships the skill script", () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });

  it("PASSING slice → last line Done and writes validated.status=Done", () => {
    const [runDir, sliceId] = makeRun("ok-slice", PASSING_GATES("ok-slice"));
    const [last] = runValidate(runDir, sliceId);
    expect(last).toBe("Done");

    const marker = readMarker(runDir, sliceId);
    expect(marker.validated.status).toBe("Done");
    expect(marker.validated.failed).toEqual([]);
    expect(typeof marker.validated.at).toBe("string");
    // Other fields are preserved (no clobber).
    expect(marker.gates.tests.exit).toBe(0);
    expect(marker.title).toBe("passing slice");
  });

  it("FAILING slice (failed-but-unblocking video) → last line Implement and validated.status=Implement", () => {
    const gs = PASSING_GATES("bad-video");
    gs.gates.video = { status: "failed-but-unblocking" } as any;
    const [runDir, sliceId] = makeRun("bad-video", gs);
    const [last] = runValidate(runDir, sliceId);
    expect(last).toBe("Implement");

    const marker = readMarker(runDir, sliceId);
    expect(marker.validated.status).toBe("Implement");
    expect(marker.validated.failed.some((r: string) => r.startsWith("video"))).toBe(true);
  });

  it("FAILING slice (tests.exit=1) → last line Implement", () => {
    const gs = PASSING_GATES("bad-tests");
    gs.gates.tests = { exit: 1 } as any;
    const [runDir, sliceId] = makeRun("bad-tests", gs);
    const [last] = runValidate(runDir, sliceId);
    expect(last).toBe("Implement");
    const marker = readMarker(runDir, sliceId);
    expect(marker.validated.failed.some((r: string) => r.startsWith("tests"))).toBe(true);
  });

  it("missing gate-status.json → last line Implement (robust)", () => {
    const runDir = fs.mkdtempSync(path.join(dir, "run-"));
    const [last, stdout] = runValidate(runDir, "no-such-slice");
    expect(last).toBe("Implement");
    expect(stdout).toContain("no gate-status.json");
  });

  it("pure-CLI slice (kind=automation) tolerates n/a adversarialTest and no designAudit → Done", () => {
    const [runDir, sliceId] = makeRun("cli-slice", {
      slice: "cli-slice",
      kind: "automation",
      gates: {
        tests: { exit: 0 },
        typecheck: { exit: 0 },
        lint: { exit: 0 },
        build: { exit: 0 },
        e2e: { exit: 0 },
        adversarialReview: { verdict: "approve" },
        adversarialTest: { result: "n/a" },
        video: { status: "verified" }
      }
    });
    const [last] = runValidate(runDir, sliceId);
    expect(last).toBe("Done");
    expect(readMarker(runDir, sliceId).validated.status).toBe("Done");
  });

  it("UI slice with adversarialTest n/a → Implement (a UI slice always has an app; n/a is not acceptable)", () => {
    const gs = PASSING_GATES("ui-na-pw");
    gs.gates.adversarialTest = { result: "n/a" } as any; // kind stays "ui"
    const [runDir, sliceId] = makeRun("ui-na-pw", gs);
    const [last] = runValidate(runDir, sliceId);
    expect(last).toBe("Implement");
    expect(readMarker(runDir, sliceId).validated.failed.some((r: string) => r.startsWith("adversarialTest"))).toBe(true);
  });

  it("missing kind → Implement (fail closed; never infer the lenient kind)", () => {
    const gs: any = PASSING_GATES("no-kind");
    delete gs.kind;
    const [runDir, sliceId] = makeRun("no-kind", gs);
    const [last, stdout] = runValidate(runDir, sliceId);
    expect(last).toBe("Implement");
    expect(stdout).toContain("VALIDATE check kind: FAIL");
  });

  it("garbage kind → Implement (fail closed; kind must be in the enum)", () => {
    const gs: any = PASSING_GATES("bad-kind");
    gs.kind = "frontend"; // not in ui|automation|mixed
    const [runDir, sliceId] = makeRun("bad-kind", gs);
    const [last] = runValidate(runDir, sliceId);
    expect(last).toBe("Implement");
    expect(readMarker(runDir, sliceId).validated.status).toBe("Implement");
  });

  it("cannot persist the validated marker → Implement (the durable record is part of the DoD)", () => {
    const [runDir, sliceId] = makeRun("ro-slice", PASSING_GATES("ro-slice"));
    const sliceDir = path.join(runDir, "slices", sliceId);
    fs.chmodSync(sliceDir, 0o555); // read-only dir: temp-file create for the atomic rewrite fails
    try {
      const [last, stdout] = runValidate(runDir, sliceId);
      expect(last).toBe("Implement");
      expect(stdout).toContain("validated-marker: FAIL");
    } finally {
      fs.chmodSync(sliceDir, 0o755); // restore so afterEach can clean up
    }
  });

  it("--strict exits non-zero on a Fail while still printing Implement last", () => {
    const gs = PASSING_GATES("strict-fail");
    gs.gates.build = { exit: 2 } as any;
    const [runDir, sliceId] = makeRun("strict-fail", gs);
    let threw = false;
    let lastLine = "";
    try {
      const out = execFileSync("node", [SCRIPT, runDir, sliceId, "--strict"], { encoding: "utf8" });
      lastLine = out.trim().split("\n").pop()!.trim();
    } catch (e: any) {
      threw = true;
      lastLine = (e.stdout ?? "").toString().trim().split("\n").pop().trim();
    }
    expect(threw).toBe(true);
    expect(lastLine).toBe("Implement");
  });
});

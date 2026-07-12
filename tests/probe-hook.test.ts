// GARRISON-FLOW-V2 S8 — the Improver Probe hook path end-to-end: the Stop-hook
// generator (probe-generate.mjs) and the PostToolUse capture (probe-capture.mjs)
// driven as real CLIs in a sandbox home, plus the settings.json hook install.
// Acceptance #17 (attended completed-task turn probed, pool/worker never probed,
// target printed from the policy cell), #18 (answer record + dismissed on
// escape/timeout + mute), #19 (retrospective once/day).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const GEN = path.join(ROOT, "fittings/seed/improver/scripts/probe-generate.mjs");
const CAP = path.join(ROOT, "fittings/seed/improver/scripts/probe-capture.mjs");
const INSTALL = path.join(ROOT, "fittings/seed/improver/scripts/install-probe-hooks.mjs");
const SEED_POLICY = path.join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json");
const COMPILE = path.join(ROOT, "fittings/seed/orchestrator/scripts/compile.mjs");

const NOW = "2026-07-11T12:00:00.000Z";
let sb: string;
let env: NodeJS.ProcessEnv;

function writePolicy(home: string) {
  // Compile the real seed into the sandbox policy so the probe-question cell is
  // the same one the live composition resolves.
  execFileSync("node", [COMPILE, "--config", SEED_POLICY, "--policy", path.join(home, "orchestrator", "policy.json")]);
}

function writeSessions(home: string, rows: Record<string, any>) {
  writeFileSync(path.join(home, "sessions", "state.json"), JSON.stringify({ version: 1, projects: { "/repo": { sessions: rows } } }));
}

function writeTranscript(real = true): string {
  const p = path.join(sb, "transcript.jsonl");
  const events = real
    ? [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(120) }] } }]
    : [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }];
  writeFileSync(p, events.map((e) => JSON.stringify(e)).join("\n"));
  return p;
}

function runGen(payload: object): string {
  return execFileSync("node", [GEN], { input: JSON.stringify(payload), env, encoding: "utf8" }).trim();
}
function runCap(payload: object): void {
  execFileSync("node", [CAP], { input: JSON.stringify(payload), env, encoding: "utf8" });
}
function readQueue(): any[] {
  const f = path.join(sb, "garrison", "improver", "feedback-queue.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function pendingFile(session = "attended-1"): string {
  return path.join(sb, "garrison", "improver", `probe-pending-${session}.json`);
}
function readPending(session = "attended-1"): any | null {
  const f = pendingFile(session);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

beforeEach(() => {
  sb = mkdtempSync(path.join(tmpdir(), "probe-hook-"));
  const home = path.join(sb, "garrison");
  for (const d of ["orchestrator", "sessions", "improver", "kanban-loop/cards"]) mkdirSync(path.join(home, d), { recursive: true });
  mkdirSync(path.join(sb, "comp", ".garrison"), { recursive: true });
  writePolicy(home);
  writeSessions(home, { "attended-1": { claudeSessionId: "attended-1", source: "dev-env-open", openedInDevEnv: true } });
  writeFileSync(
    path.join(sb, "comp", ".garrison", "decisions.jsonl"),
    JSON.stringify({ at: "2026-07-11T11:59:00Z", promptDigest: "x", taskType: "code", tier: "T1-standard" }) + "\n"
  );
  env = {
    ...process.env,
    GARRISON_HOME: home,
    GARRISON_POLICY_PATH: path.join(home, "orchestrator", "policy.json"),
    GARRISON_SESSIONS_STATE: path.join(home, "sessions", "state.json"),
    GARRISON_KANBAN_DIR: path.join(home, "kanban-loop"),
    GARRISON_COMPOSITION_DIR: path.join(sb, "comp"),
    PROBE_NOW: NOW,
  };
});
afterEach(() => rmSync(sb, { recursive: true, force: true }));

describe("probe-generate — gating + block (#17)", () => {
  it("attended session + a real completed task → blocks with a verbatim relay + writes a pending", () => {
    const t = writeTranscript(true);
    const out = runGen({ session_id: "attended-1", stop_hook_active: false, transcript_path: t });
    const decision = JSON.parse(out);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("AskUserQuestion");
    const pending = readPending();
    expect(pending.session_id).toBe("attended-1");
    expect(pending.questions.length).toBeGreaterThanOrEqual(1);
  });

  it("prints the resolved target FROM THE POLICY CELL on stderr", () => {
    const t = writeTranscript(true);
    const proc = spawnSync("node", [GEN], {
      input: JSON.stringify({ session_id: "attended-1", stop_hook_active: false, transcript_path: t }),
      env,
      encoding: "utf8",
    });
    // WS7: probe-question resolves to the LOCAL ollama target (never Anthropic).
    expect(proc.stderr).toContain("sdk-ollama-probe");
    expect(proc.stderr).toContain("probe-question");
    expect(proc.stdout).toContain("block");
  });

  it("a pool/worker/ambient (not-attended) session is NEVER probed", () => {
    writeSessions(path.join(sb, "garrison"), { "worker-1": { claudeSessionId: "worker-1", source: "hook-autocreated", openedInDevEnv: false } });
    const t = writeTranscript(true);
    const out = runGen({ session_id: "worker-1", stop_hook_active: false, transcript_path: t });
    expect(out).toBe("");
    expect(readPending()).toBeNull();
  });

  it("stop_hook_active loop guard → no probe", () => {
    const t = writeTranscript(true);
    expect(runGen({ session_id: "attended-1", stop_hook_active: true, transcript_path: t })).toBe("");
  });

  it("a goal sentinel for the session → defer to the goal loop (no probe)", () => {
    mkdirSync(path.join(sb, "garrison", "sentinels"), { recursive: true });
    writeFileSync(path.join(sb, "garrison", "sentinels", "attended-1.json"), "{}");
    const t = writeTranscript(true);
    expect(runGen({ session_id: "attended-1", stop_hook_active: false, transcript_path: t })).toBe("");
  });

  it("a trivial (non-task) turn → no probe", () => {
    const t = writeTranscript(false);
    expect(runGen({ session_id: "attended-1", stop_hook_active: false, transcript_path: t })).toBe("");
  });
});

describe("probe-generate — mute + target-unreachable (#18, fail loud)", () => {
  it("muted today → no probe", () => {
    writeFileSync(path.join(sb, "garrison", "improver", "probe-mute-2026-07-11"), "");
    const t = writeTranscript(true);
    expect(runGen({ session_id: "attended-1", stop_hook_active: false, transcript_path: t })).toBe("");
  });

  it("policy has no probe-question cell → writes a probe-skip log line, no block (never silent)", () => {
    // overwrite the sandbox policy with one lacking the probe-question row
    const stripped = { policyVersion: 1, matrix: { code: { "T1-standard": { targetId: "cc-sonnet-med" } } } };
    writeFileSync(env.GARRISON_POLICY_PATH as string, JSON.stringify(stripped));
    const t = writeTranscript(true);
    const out = runGen({ session_id: "attended-1", stop_hook_active: false, transcript_path: t });
    expect(out).toBe("");
    const skip = readFileSync(path.join(sb, "garrison", "improver", "probe-skip.log"), "utf8");
    expect(skip).toMatch(/probe-question target unreachable/);
  });
});

describe("probe-capture — answer + dismissed + unrelated (#18)", () => {
  function seedProbe() {
    const t = writeTranscript(true);
    runGen({ session_id: "attended-1", stop_hook_active: false, transcript_path: t });
    return readPending();
  }

  it("captures the selected answer into a D26 record and clears the pending", () => {
    const pending = seedProbe();
    const q = pending.questions[0].question;
    runCap({ session_id: "attended-1", tool_name: "AskUserQuestion", tool_response: { answers: { [q]: "Went well" } } });
    const recs = readQueue();
    expect(recs).toHaveLength(1);
    expect(recs[0].answer).toBe("Went well");
    expect(recs[0].provenance).toBe("probe");
    expect(recs[0].classification.kind).toBe("code");
    expect(readPending()).toBeNull();
  });

  it("a multi-question (retrospective) pending ignores an unrelated single-answer AskUserQuestion (left for the sweeper)", () => {
    // A retrospective pending carries 2+ questions; an answer that matches none of
    // them is the operative's OWN AskUserQuestion — never captured against a
    // multi-question probe (the single-question rephrase fallback does not apply).
    const pending = {
      id: "p-x",
      session_id: "attended-1",
      mode: "retrospective",
      askedAt: NOW,
      questions: [
        { area: "orchestrator", question: "Q1?", options: ["a", "b"], classification: { kind: "ui-change", tier: null, plan: "ui-change" }, card_id: "c1" },
        { area: "orchestrator", question: "Q2?", options: ["a", "b"], classification: { kind: "docs-change", tier: null, plan: "implement-only-text" }, card_id: "c2" },
      ],
    };
    writeFileSync(pendingFile("attended-1"), JSON.stringify(pending));
    runCap({ session_id: "attended-1", tool_name: "AskUserQuestion", tool_response: { answers: { "operative's own question?": "whatever" } } });
    expect(readQueue()).toHaveLength(0);
    expect(readPending()).not.toBeNull(); // left for the sweeper
  });

  it("a retrospective partial answer captures the answered task and dismisses the rest", () => {
    const pending = {
      id: "p-y",
      session_id: "attended-1",
      mode: "retrospective",
      askedAt: NOW,
      questions: [
        { area: "orchestrator", question: "Q1?", options: ["a", "b"], classification: { kind: "ui-change", tier: null, plan: "ui-change" }, card_id: "c1" },
        { area: "orchestrator", question: "Q2?", options: ["a", "b"], classification: { kind: "docs-change", tier: null, plan: "implement-only-text" }, card_id: "c2" },
      ],
    };
    writeFileSync(pendingFile("attended-1"), JSON.stringify(pending));
    runCap({ session_id: "attended-1", tool_name: "AskUserQuestion", tool_response: { answers: { "Q1?": "Should have run less" } } });
    const recs = readQueue();
    expect(recs).toHaveLength(2);
    const q1 = recs.find((r) => r.card_id === "c1");
    const q2 = recs.find((r) => r.card_id === "c2");
    expect(q1.answer).toBe("Should have run less");
    expect(q1.provenance).toBe("retrospective");
    expect(q2.answer).toBe("dismissed");
    expect(readPending()).toBeNull();
  });

  it("a stale pending (>90s) is swept into an explicit dismissed record on the next Stop", () => {
    const pending = seedProbe();
    pending.askedAt = "2026-07-11T11:58:00.000Z"; // 2 min old
    writeFileSync(pendingFile("attended-1"), JSON.stringify(pending));
    const t = writeTranscript(true);
    const out = runGen({ session_id: "attended-1", stop_hook_active: false, transcript_path: t });
    expect(out).toBe(""); // pass through, no re-ask
    const recs = readQueue();
    expect(recs).toHaveLength(1);
    expect(recs[0].answer).toBe("dismissed");
    expect(readPending()).toBeNull();
  });
});

describe("probe — per-session pending isolation (F1)", () => {
  // Two attended sessions coexist on the shared machine.
  function twoAttended() {
    writeSessions(path.join(sb, "garrison"), {
      "sess-A": { claudeSessionId: "sess-A", source: "dev-env-open", openedInDevEnv: true },
      "sess-B": { claudeSessionId: "sess-B", source: "dev-env-open", openedInDevEnv: true },
    });
  }

  it("session B's Stop does NOT sweep session A's (even stale) pending", () => {
    twoAttended();
    // A has an OPEN, already-stale pending (its user has not answered yet).
    const aPending = {
      id: "p-A",
      session_id: "sess-A",
      mode: "probe",
      askedAt: "2026-07-11T11:58:00.000Z", // 2 min old — would be swept if a foreign stop could
      questions: [{ area: "went-well", question: "How did A go?", options: ["ok"], classification: { kind: "code", tier: "T1-standard", plan: null }, card_id: null }],
    };
    writeFileSync(pendingFile("sess-A"), JSON.stringify(aPending));

    // B stops (a real completed task). B sweeps only ITS OWN pending (none).
    const t = writeTranscript(true);
    runGen({ session_id: "sess-B", stop_hook_active: false, transcript_path: t });

    // A's pending survives untouched; no dismissed record was written for A.
    expect(readPending("sess-A")).not.toBeNull();
    expect(readQueue().some((r) => r.answer === "dismissed")).toBe(false);
  });

  it("A's answer arriving AFTER B's stop still records provenance probe (no false dismissed)", () => {
    twoAttended();
    // A is probed and writes its own pending (fresh).
    const t = writeTranscript(true);
    runGen({ session_id: "sess-A", stop_hook_active: false, transcript_path: t });
    const aPending = readPending("sess-A");
    expect(aPending).not.toBeNull();

    // B stops in between (does not touch A's pending).
    runGen({ session_id: "sess-B", stop_hook_active: false, transcript_path: t });
    expect(readPending("sess-A")).not.toBeNull();

    // A's user answers → the real answer is recorded, not a dismissed.
    const q = aPending.questions[0].question;
    runCap({ session_id: "sess-A", tool_name: "AskUserQuestion", tool_response: { answers: { [q]: "Went well" } } });
    const recs = readQueue();
    const answered = recs.filter((r) => r.session_id === "sess-A");
    expect(answered).toHaveLength(1);
    expect(answered[0].answer).toBe("Went well");
    expect(answered[0].provenance).toBe("probe");
    expect(recs.some((r) => r.answer === "dismissed")).toBe(false);
    expect(readPending("sess-A")).toBeNull();
  });
});

describe("probe-generate — retrospective once/day (#19)", () => {
  function seedYesterdayCard() {
    const dir = path.join(sb, "garrison", "kanban-loop", "cards", "c1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "card.json"),
      JSON.stringify({ id: "c1", title: "toggle", workKind: "ui-change", phasePlan: "ui-change", updatedAt: "2026-07-10T09:00:00Z" })
    );
  }
  it("first attended boundary of the day → retrospective; a record per task; flag prevents a second", () => {
    seedYesterdayCard();
    const t = writeTranscript(true);
    runGen({ session_id: "attended-1", stop_hook_active: false, transcript_path: t });
    const pending = readPending();
    expect(pending.mode).toBe("retrospective");
    expect(pending.questions[0].card_id).toBe("c1");
    expect(existsSync(path.join(sb, "garrison", "improver", "retro-2026-07-11"))).toBe(true);

    // answer → one retrospective record per listed task
    const q = pending.questions[0].question;
    runCap({ session_id: "attended-1", tool_name: "AskUserQuestion", tool_response: { answers: { [q]: "Should have run the full pipeline" } } });
    const recs = readQueue();
    expect(recs).toHaveLength(1);
    expect(recs[0].provenance).toBe("retrospective");
    expect(recs[0].card_id).toBe("c1");

    // second boundary same day → NOT a retrospective (flag set) → a normal probe
    runGen({ session_id: "attended-1", stop_hook_active: false, transcript_path: t });
    expect(readPending().mode).toBe("probe");
  });
});

describe("install-probe-hooks — additive + idempotent settings.json edit (#21 containment)", () => {
  it("adds a Stop + PostToolUse(AskUserQuestion) group, preserves others, and re-running does not duplicate", () => {
    const settings = path.join(sb, "settings.json");
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ _garrison: "fitting:dev-env", matcher: "", hooks: [] }] } }));
    const runEnv = { ...env, GARRISON_CLAUDE_SETTINGS_PATH: settings };
    execFileSync("node", [INSTALL], { env: runEnv });
    execFileSync("node", [INSTALL], { env: runEnv }); // idempotent re-run
    const s = JSON.parse(readFileSync(settings, "utf8"));
    const own = (event: string) => s.hooks[event].filter((g: any) => g._garrison === "fitting:improver-probe");
    expect(own("Stop")).toHaveLength(1); // not duplicated
    expect(own("PostToolUse")).toHaveLength(1);
    expect(own("PostToolUse")[0].matcher).toBe("AskUserQuestion");
    expect(own("Stop")[0].hooks[0].command).toContain("probe-stop-hook.sh");
    // the unrelated dev-env group is preserved
    expect(s.hooks.Stop.some((g: any) => g._garrison === "fitting:dev-env")).toBe(true);
  });
});

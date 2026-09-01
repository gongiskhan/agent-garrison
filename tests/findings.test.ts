// The findings record. Three properties are load-bearing and each is enforced
// rather than hoped for: claims carry no content, entries are append-only with
// one writer, and nothing in the format is provider-shaped.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore - pure .mjs module (single line: TS7016 lands on the closing line of a multi-line import)
import { normalizeFinding, composeFindings, markStaleness, anchorFor, readFindings, assertUnderCap, repetitionReport, targetsForToolUse, FindingRejected, FindingsCapReached, FINDINGS_CAP, CLAIM_MAX_CHARS } from "../packages/claude-pty/src/findings.mjs";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "findings-"));
  mkdirSync(path.join(cwd, "src", "lib"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "lib", "identity.js"), "export function mintKey() { return 'k'; }\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const ev = (payload: unknown, seq: number, stretch = "s1") =>
  ({ kind: "finding", seq, stretch, payload });

describe("an entry is a claim and pointers, never content", () => {
  it("accepts a one-line finding with pointers", () => {
    const f = normalizeFinding(
      { kind: "fact", claim: "mintKey lives in src/lib/identity.js and returns a sortable id",
        pointers: ["src/lib/identity.js", "mintKey"], anchorPath: "src/lib/identity.js" },
      { stretchId: "s1", duty: "implement", cwd });
    expect(f.kind).toBe("fact");
    expect(f.pointers).toEqual(["src/lib/identity.js", "mintKey"]);
    expect(f.anchor).toMatchObject({ path: "src/lib/identity.js" });
    expect(f.anchor.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects a claim containing a code block - that is a transcript, not a finding", () => {
    expect(() => normalizeFinding(
      { kind: "fact", claim: "identity exports ```export function mintKey(){}```", anchorPath: "src/lib/identity.js" },
      { stretchId: "s1", cwd })).toThrow(FindingRejected);
  });

  it("rejects a multi-line claim for the same reason", () => {
    expect(() => normalizeFinding(
      { kind: "decision", claim: "we will use sqlite\nbecause it is already a dependency" },
      { stretchId: "s1", cwd })).toThrow(/one line/);
  });

  it("rejects a claim over the cap rather than truncating it", () => {
    expect(() => normalizeFinding(
      { kind: "decision", claim: "x".repeat(CLAIM_MAX_CHARS + 1) },
      { stretchId: "s1", cwd })).toThrow(new RegExp(String(CLAIM_MAX_CHARS)));
  });

  it("rejects an unknown kind", () => {
    expect(() => normalizeFinding({ kind: "note", claim: "hi" }, { stretchId: "s1", cwd })).toThrow(FindingRejected);
  });
});

describe("anchors follow the kind, because the kind says what the claim is about", () => {
  it("requires an anchor on fact and change", () => {
    for (const kind of ["fact", "change"]) {
      expect(() => normalizeFinding({ kind, claim: "something about a file" }, { stretchId: "s1", cwd }))
        .toThrow(/needs an anchor/);
    }
  });

  it("refuses an anchor on decision, rejected and failure", () => {
    for (const kind of ["decision", "rejected", "failure"]) {
      expect(() => normalizeFinding({ kind, claim: "a choice", anchorPath: "src/lib/identity.js" }, { stretchId: "s1", cwd }))
        .toThrow(/takes no anchor/);
    }
  });

  it("refuses to anchor a file that is not there, rather than recording a null hash", () => {
    expect(() => normalizeFinding({ kind: "fact", claim: "x", anchorPath: "src/nope.js" }, { stretchId: "s1", cwd }))
      .toThrow(/could not be hashed/);
  });

  it("accepts a commit anchor for a claim about a commit", () => {
    const f = normalizeFinding({ kind: "change", claim: "landed the store change", anchorCommit: "abc1234" }, { stretchId: "s1", cwd });
    expect(f.anchor).toEqual({ commit: "abc1234" });
  });
});

// The failure mode this whole mechanism exists to prevent is a stretch trusting
// a claim about a file that has since moved. If this test ever passes silently
// while staleness is broken, the record is worse than nothing.
describe("staleness", () => {
  it("marks an entry STALE once its file changes, and keeps it", () => {
    const f = normalizeFinding(
      { kind: "fact", claim: "mintKey lives in src/lib/identity.js and returns a sortable id",
        pointers: ["src/lib/identity.js"], anchorPath: "src/lib/identity.js" },
      { stretchId: "s1", duty: "implement", cwd });
    const events = [ev(f, 10)];

    // Composing before the change: fresh, no warning.
    const before = composeFindings(events, { cwd });
    expect(before.staleCount).toBe(0);
    expect(before.text).toContain("mintKey lives in");
    // The preamble explains what STALE means, so assert on the ENTRY marker.
    expect(before.text).not.toContain("**STALE**");

    // A later stretch edits the file the claim was about.
    writeFileSync(path.join(cwd, "src", "lib", "identity.js"), "export function mintKey() { return 'CHANGED'; }\n");

    // Composing a third context: the entry is STALE, still present, and the
    // stretch is told to re-read rather than trust it.
    const after = composeFindings(events, { cwd });
    expect(after.staleCount).toBe(1);
    expect(after.entries[0].stale).toBe(true);
    expect(after.entries[0].staleReason).toMatch(/changed/);
    expect(after.text).toContain("**STALE**");
    expect(after.text).toContain("mintKey lives in");
    expect(after.text).toMatch(/re-read/i);
  });

  it("marks an entry STALE when the file is deleted, and says which", () => {
    const f = normalizeFinding({ kind: "fact", claim: "identity exists", anchorPath: "src/lib/identity.js" }, { stretchId: "s1", cwd });
    rmSync(path.join(cwd, "src", "lib", "identity.js"));
    const [marked] = markStaleness([f], { cwd });
    expect(marked.stale).toBe(true);
    expect(marked.staleReason).toMatch(/gone/);
  });

  it("never marks an unanchored entry stale - it is not about a file", () => {
    const f = normalizeFinding({ kind: "decision", claim: "sqlite, not a new dependency" }, { stretchId: "s1", cwd });
    writeFileSync(path.join(cwd, "src", "lib", "identity.js"), "different\n");
    expect(markStaleness([f], { cwd })[0].stale).toBe(false);
  });
});

describe("composition is deterministic and ordered", () => {
  const mk = (claim: string, stretch: string) =>
    normalizeFinding({ kind: "decision", claim }, { stretchId: stretch, duty: "implement", cwd });

  it("concatenates in ledger order with no model in the path", () => {
    const events = [ev(mk("first thing", "s1"), 1, "s1"), ev(mk("second thing", "s2"), 2, "s2"), ev(mk("third thing", "s2"), 3, "s2")];
    const a = composeFindings(events, { cwd });
    const b = composeFindings(events, { cwd });
    expect(a.text).toBe(b.text);
    expect(a.text.indexOf("first thing")).toBeLessThan(a.text.indexOf("second thing"));
    expect(a.text.indexOf("second thing")).toBeLessThan(a.text.indexOf("third thing"));
  });

  it("is empty when nothing has been recorded", () => {
    expect(composeFindings([], { cwd }).text).toBe("");
  });

  it("reads only finding events out of a mixed ledger", () => {
    const events = [
      { kind: "usage", seq: 1, payload: { model: "x" } },
      ev(mk("a decision", "s1"), 2),
      { kind: "session-event", seq: 3, payload: { blocks: [] } },
    ];
    expect(readFindings(events)).toHaveLength(1);
  });
});

describe("the cap stops the task instead of compacting the record", () => {
  it("throws once the cap is reached, naming why it is not compacted", () => {
    const one = normalizeFinding({ kind: "decision", claim: "a" }, { stretchId: "s1", cwd });
    const full = Array.from({ length: FINDINGS_CAP }, (_, i) => ev(one, i));
    expect(() => assertUnderCap(full)).toThrow(FindingsCapReached);
    expect(() => assertUnderCap(full)).toThrow(/not compacted on purpose|too verbose/);
  });

  it("allows the write just under the cap", () => {
    const one = normalizeFinding({ kind: "decision", claim: "a" }, { stretchId: "s1", cwd });
    expect(assertUnderCap(Array.from({ length: FINDINGS_CAP - 1 }, (_, i) => ev(one, i)))).toBe(FINDINGS_CAP - 1);
  });
});

// If adding a second provider later requires touching the record, something
// provider-shaped got in. This is that test, run against the format itself.
describe("nothing in the record is provider-shaped", () => {
  it("an entry has no model, token, message-id or tool-shape field", () => {
    const f = normalizeFinding(
      { kind: "fact", claim: "store.js owns the one db handle", pointers: ["src/lib/store.js"], anchorPath: "src/lib/identity.js" },
      { stretchId: "s1", duty: "implement", cwd });
    expect(Object.keys(f).sort()).toEqual(["anchor", "claim", "duty", "id", "kind", "pointers", "stretch", "ts"]);
    const blob = JSON.stringify(f).toLowerCase();
    for (const forbidden of ["model", "token", "anthropic", "openai", "claude", "gpt", "message_id", "tool_use", "provider"]) {
      expect(blob, `entry mentions "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("the composed text names no provider either", () => {
    const f = normalizeFinding({ kind: "decision", claim: "sqlite, not a new dependency" }, { stretchId: "s1", cwd });
    const blob = composeFindings([ev(f, 1)], { cwd }).text.toLowerCase();
    for (const forbidden of ["anthropic", "openai", "sonnet", "haiku", "gpt-"]) {
      expect(blob).not.toContain(forbidden);
    }
  });
});

describe("read/search repetition", () => {
  const toolUse = (stretch: string, name: string, input: unknown, seq: number) =>
    ({ kind: "session-event", seq, stretch, duty: "implement",
       payload: { id: `m${seq}`, blocks: [{ type: "tool_use", toolUseId: `t${seq}`, name, input: JSON.stringify(input) }] } });

  it("pulls targets out of Read, Grep, Glob and Bash alike", () => {
    expect(targetsForToolUse({ name: "Read", input: JSON.stringify({ file_path: "/a/b.ts" }) })).toEqual(["read:/a/b.ts"]);
    expect(targetsForToolUse({ name: "Grep", input: JSON.stringify({ pattern: "mintKey" }) })).toEqual(["grep:mintKey"]);
    expect(targetsForToolUse({ name: "Bash", input: JSON.stringify({ command: 'grep -rn "mintKey" src' }) })).toContain("grep:mintKey");
    expect(targetsForToolUse({ name: "Bash", input: JSON.stringify({ command: "ls -la src/lib" }) })).toContain("ls:src/lib");
    expect(targetsForToolUse({ name: "Write", input: JSON.stringify({ file_path: "/a/b.ts" }) })).toEqual([]);
  });

  it("counts how many of a later stretch's targets an earlier one already hit", () => {
    const events = [
      { kind: "stretch-started", seq: 1, stretch: "s1", payload: { duty: "implement" } },
      toolUse("s1", "Read", { file_path: "src/lib/store.js" }, 2),
      toolUse("s1", "Read", { file_path: "src/lib/identity.js" }, 3),
      { kind: "stretch-started", seq: 4, stretch: "s2", payload: { duty: "test" } },
      toolUse("s2", "Read", { file_path: "src/lib/store.js" }, 5),      // repeat
      toolUse("s2", "Read", { file_path: "src/routes/todos.js" }, 6),   // new
    ];
    const rep = repetitionReport(events);
    expect(rep.stretches).toHaveLength(2);
    expect(rep.stretches[0].repeatedFromEarlierStretches).toBe(0);
    expect(rep.stretches[1].targets).toBe(2);
    expect(rep.stretches[1].repeatedFromEarlierStretches).toBe(1);
    expect(rep.stretches[1].fraction).toBe(0.5);
    expect(rep.stretches[1].repeatedTargets).toEqual(["read:src/lib/store.js"]);
    // The task figure excludes the first stretch, which has nothing to repeat.
    expect(rep.task.stretchesAfterTheFirst).toBe(1);
    expect(rep.task.repeated).toBe(1);
    expect(rep.task.fraction).toBe(0.5);
    expect(rep.task.distinctTargetsAcrossTask).toBe(3);
  });

  it("reports a null fraction rather than dividing by zero when a stretch read nothing", () => {
    const rep = repetitionReport([
      { kind: "stretch-started", seq: 1, stretch: "s1", payload: { duty: "triage" } },
      { kind: "stretch-started", seq: 2, stretch: "s2", payload: { duty: "report" } },
    ]);
    expect(rep.stretches[1].fraction).toBeNull();
    expect(rep.task.fraction).toBeNull();
  });
});

// A relative anchorPath is what a model naturally writes. Resolving it against
// the wrong directory rejected every one of them as "the file is not there" -
// found by a live stretch, which recorded it as a `failure` entry.
describe("anchor paths resolve against the stretch's working directory", () => {
  it("accepts a repo-relative anchorPath when cwd is the repo", () => {
    const f = normalizeFinding(
      { kind: "fact", claim: "mintKey lives in src/lib/identity.js", anchorPath: "src/lib/identity.js" },
      { stretchId: "s1", cwd });
    expect(f.anchor.path).toBe("src/lib/identity.js");
    expect(f.anchor.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("accepts the same file by absolute path, and both hash identically", () => {
    const rel = normalizeFinding({ kind: "fact", claim: "a", anchorPath: "src/lib/identity.js" }, { stretchId: "s1", cwd });
    const abs = normalizeFinding({ kind: "fact", claim: "a", anchorPath: path.join(cwd, "src/lib/identity.js") }, { stretchId: "s1", cwd });
    expect(abs.anchor.hash).toBe(rel.anchor.hash);
  });

  it("still marks a relative anchor stale when the file changes", () => {
    const f = normalizeFinding({ kind: "fact", claim: "a", anchorPath: "src/lib/identity.js" }, { stretchId: "s1", cwd });
    writeFileSync(path.join(cwd, "src", "lib", "identity.js"), "moved on\n");
    expect(markStaleness([f], { cwd })[0].stale).toBe(true);
  });
});

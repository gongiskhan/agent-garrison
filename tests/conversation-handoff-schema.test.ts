// The stretch handoff schema: mandatory KEYS (absent invalid, [] valid),
// cross-rules, and rule 10 — evidence refs must resolve on disk.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { validateHandoff, defaultResolveEvidence, HANDOFF_STATUSES } from "../packages/claude-pty/src/conversation-store.mjs";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "handoff-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const DUTIES = ["triage", "plan", "implement", "review", "test"];

function valid(): any {
  return {
    v: 1,
    stretchId: "st-1",
    duty: "implement",
    status: "complete",
    summary: "Wrote the thing; tests pass.",
    evidenceRefs: [],
    nextSteps: { next: "review", why: "code unread by anyone else", items: ["read the exit gate"] },
    blocker: null,
    activeConstraints: [],
    failedApproaches: [],
    surprises: [],
    forceEscalation: null,
    synthesized: false,
  };
}

describe("validateHandoff", () => {
  it("accepts a complete minimal handoff with empty arrays", () => {
    const res = validateHandoff(valid(), { selectedDuties: DUTIES });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("every mandatory KEY missing makes it invalid; [] stays valid", () => {
    for (const key of ["status", "summary", "evidenceRefs", "nextSteps", "blocker", "activeConstraints", "failedApproaches", "surprises"]) {
      const h = valid();
      delete h[key];
      const res = validateHandoff(h, { selectedDuties: DUTIES });
      expect(res.ok, `missing ${key} must be invalid`).toBe(false);
    }
  });

  it("statuses are the closed set; next must be a selected duty or done|needs-input", () => {
    expect(HANDOFF_STATUSES).toEqual(["complete", "partial", "blocked", "failed"]);
    const badStatus = { ...valid(), status: "great" };
    expect(validateHandoff(badStatus, { selectedDuties: DUTIES }).ok).toBe(false);
    const badNext = valid();
    badNext.nextSteps.next = "deploy-to-prod";
    expect(validateHandoff(badNext, { selectedDuties: DUTIES }).ok).toBe(false);
    const doneNext = valid();
    doneNext.nextSteps.next = "done";
    expect(validateHandoff(doneNext, { selectedDuties: DUTIES }).ok).toBe(true);
    const needsInput = valid();
    needsInput.nextSteps.next = "needs-input";
    expect(validateHandoff(needsInput, { selectedDuties: DUTIES }).ok).toBe(true);
  });

  it("cross-rules: blocked=>blocker, partial/failed=>failedApproaches, done=>complete", () => {
    const blocked = { ...valid(), status: "blocked" };
    expect(validateHandoff(blocked, { selectedDuties: DUTIES }).ok).toBe(false);
    blocked.blocker = { what: "vault locked", needs: "unlock", who: "user" };
    // blocked with a blocker is fine even with empty failedApproaches
    expect(validateHandoff(blocked, { selectedDuties: DUTIES }).ok).toBe(true);

    const partial = { ...valid(), status: "partial" };
    expect(validateHandoff(partial, { selectedDuties: DUTIES }).ok).toBe(false);
    partial.failedApproaches = [{ approach: "tried X", why: "deadlocks" }];
    expect(validateHandoff(partial, { selectedDuties: DUTIES }).ok).toBe(true);

    const doneButPartial = { ...valid(), status: "partial", failedApproaches: [{ approach: "a", why: "b" }] };
    doneButPartial.nextSteps = { next: "done", why: "w", items: [] };
    expect(validateHandoff(doneButPartial, { selectedDuties: DUTIES }).ok).toBe(false);
  });

  it("rule 10: a gate/run/file evidence ref must exist non-empty on disk", () => {
    const real = path.join(tmp, "evidence.md");
    writeFileSync(real, "proof\n");
    const empty = path.join(tmp, "empty.md");
    writeFileSync(empty, "");
    const resolve = defaultResolveEvidence(tmp);

    const good = { ...valid(), evidenceRefs: [{ kind: "run", ref: real }, { kind: "url", ref: "https://x" }] };
    const resGood = validateHandoff(good, { selectedDuties: DUTIES, resolveEvidence: resolve });
    expect(resGood.ok).toBe(true);
    expect(resGood.resolved).toEqual([{ ref: real, kind: "run", exists: true, bytes: 6 }]);

    const missing = { ...valid(), evidenceRefs: [{ kind: "gate", ref: path.join(tmp, "nope.json") }] };
    expect(validateHandoff(missing, { selectedDuties: DUTIES, resolveEvidence: resolve }).ok).toBe(false);

    const zeroByte = { ...valid(), evidenceRefs: [{ kind: "file", ref: empty }] };
    expect(validateHandoff(zeroByte, { selectedDuties: DUTIES, resolveEvidence: resolve }).ok).toBe(false);

    // url/commit/artifact kinds are not disk-resolved
    const urlOnly = { ...valid(), evidenceRefs: [{ kind: "commit", ref: "a1b2c3" }] };
    expect(validateHandoff(urlOnly, { selectedDuties: DUTIES, resolveEvidence: resolve }).ok).toBe(true);
  });

  it("bad evidence entry shapes and failedApproaches entries are named in errors", () => {
    const badEv = { ...valid(), evidenceRefs: [{ kind: "screenshot", ref: "x" }] };
    const res = validateHandoff(badEv, { selectedDuties: DUTIES });
    expect(res.ok).toBe(false);
    expect(res.errors.join()).toContain("evidenceRefs[0]");
    const badFa = { ...valid(), failedApproaches: [{ approach: "", why: "" }] };
    expect(validateHandoff(badFa, { selectedDuties: DUTIES }).ok).toBe(false);
  });
});

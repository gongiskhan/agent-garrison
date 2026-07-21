// S1b (D19, RUN_SPEC assumption 2) — EMPTY delegation output is a FAILURE, not a
// success. Before this fix `summarize("")` fabricated the placeholder "(no output)"
// — a non-empty string that slipped past validateDelegationResult's bare `.length`
// check, so a no-op delegation read as a valid result. These tests pin the two
// halves of the fix: validateDelegationResult rejects empty/placeholder summaries,
// and delegate() throws a loud "empty-output" DelegationError (never a fake summary).
import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs package
import { delegate, validateDelegationResult, DelegationError, EMPTY_OUTPUT_PLACEHOLDER } from "../packages/claude-pty/src/index.mjs";

// A stub secondary whose canned reply text is configurable, so a test can drive an
// EMPTY delegation (the premature-close / no-op case) and a real one.
function makeStubAdapter(text: string, id = "codex") {
  return {
    id,
    async spawn(c: any) { return { alive: true, cwd: c?.compositionDir }; },
    async awaitReady() {},
    async sendTurn() {},
    async awaitResponse() { return { text, artifacts: [] as string[] }; },
    async teardown() {}
  };
}

function deps(text: string, extra: any = {}) {
  const logged: any[] = [];
  const written: any[] = [];
  return {
    logged,
    written,
    adapter: makeStubAdapter(text),
    spawnConfig: { compositionDir: "/tmp/x", model: "gpt-5-codex" },
    writeArtifact: async (ns: string, name: string, content: string) => {
      written.push({ ns, name, content });
      return `artifacts/${ns}/${name}`;
    },
    logDecision: async (rec: any) => { logged.push(rec); },
    now: () => "2026-07-13T00:00:00Z",
    ...extra
  };
}

describe("runtime bridge — empty output is a validation failure (S1b/D19)", () => {
  it("validateDelegationResult rejects an empty, whitespace-only, and placeholder summary; accepts a real one", () => {
    expect(validateDelegationResult({ summary: "", artifacts: [] }).length).toBeGreaterThan(0);
    expect(validateDelegationResult({ summary: "   \n\t ", artifacts: [] }).length).toBeGreaterThan(0);
    // the historical fake — must be rejected as defense-in-depth
    expect(validateDelegationResult({ summary: EMPTY_OUTPUT_PLACEHOLDER, artifacts: [] }).length).toBeGreaterThan(0);
    // a real summary passes
    expect(validateDelegationResult({ summary: "[codex] handled: refactor", artifacts: [] })).toEqual([]);
  });

  it("the empty-summary error never reads as success", () => {
    const errs = validateDelegationResult({ summary: "", artifacts: [] }).join(" ").toLowerCase();
    expect(errs).toMatch(/empty|no `summary`|failure/);
    expect(errs).not.toMatch(/\bcompleted\b|\bsuccess\b/);
  });

  it("delegate() with EMPTY output throws a loud DelegationError('empty-output') — no artifact, no decision logged", async () => {
    const d = deps("   \n  "); // secondary returned only whitespace
    await expect(delegate({ task: "do the thing" }, d)).rejects.toMatchObject({
      name: "DelegationError",
      code: "empty-output"
    });
    // it failed BEFORE writing a bogus artifact or logging a fake success
    expect(d.written).toHaveLength(0);
    expect(d.logged).toHaveLength(0);
  });

  it("delegate() with real output still returns a schema-valid summary + artifact (non-empty passes)", async () => {
    const d = deps("[codex] handled: refactor utils.ts");
    const result = await delegate({ task: "refactor utils.ts" }, d);
    expect(validateDelegationResult(result)).toEqual([]);
    expect(result.summary).toContain("[codex] handled");
    expect(result.summary).not.toBe(EMPTY_OUTPUT_PLACEHOLDER);
    expect(d.written).toHaveLength(1);
    expect(d.logged).toHaveLength(1);
  });
});

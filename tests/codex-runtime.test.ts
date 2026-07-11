import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs
import { CodexAdapter, buildExecArgs } from "../fittings/seed/codex-runtime/lib/codex-adapter.mjs";
// @ts-ignore
import { delegate, validateDelegationResult } from "../packages/claude-pty/src/index.mjs";
// @ts-ignore
import { runAdapterConformance } from "../packages/claude-pty/src/index.mjs";

describe("Codex runtime adapter (MRr-codex)", () => {
  it("buildExecArgs: codex exec, model via -c, cwd via --cd, prompt via STDIN (never argv)", () => {
    const { bin, argv, stdinFromPrompt } = buildExecArgs({ model: "gpt-5-codex", compositionDir: "/work/proj" });
    expect(bin).toBe("codex");
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("-c");
    expect(argv).toContain("model=gpt-5-codex");
    expect(argv).toContain("--cd");
    expect(argv).toContain("/work/proj");
    expect(argv[argv.length - 1]).toBe("-"); // read prompt from stdin
    expect(argv).toContain("--skip-git-repo-check"); // runs in throwaway cwds (verified live U4)
    expect(stdinFromPrompt).toBe(true);
    // the prompt is NEVER in argv
    expect(argv.join(" ")).not.toContain("the actual task text");
  });

  it("the Codex adapter passes the RuntimeAdapter conformance harness (stub exec)", async () => {
    const adapter = new CodexAdapter({ runExec: async () => ({ code: 0, stdout: "codex did the work", stderr: "" }) });
    const report = await runAdapterConformance(adapter, { config: { compositionDir: "/tmp/x", model: "gpt-5-codex" }, turnText: "ping" });
    expect(report.ok).toBe(true);
    expect(report.runtime).toBe("codex");
  });

  it("the Codex adapter feeds the prompt to codex exec via stdin", async () => {
    let seenStdin = "";
    const adapter = new CodexAdapter({
      runExec: async ({ stdin, argv }: any) => {
        seenStdin = stdin;
        // assert the prompt never reached argv
        expect(argv.join(" ")).not.toContain("refactor the parser");
        return { code: 0, stdout: "done", stderr: "" };
      }
    });
    const s = await adapter.spawn({ model: "gpt-5-codex" });
    await adapter.sendTurn(s, "refactor the parser");
    const r = await adapter.awaitResponse(s);
    expect(seenStdin).toContain("refactor the parser");
    expect(r.text).toBe("done");
  });
});

describe("Codex runtime-bridge delegation (MRr-bridge / runtime-bridge-ok + secondary-delegate-ok)", () => {
  function harness(stdout = "[codex] refactored utils.ts; added tests") {
    const logged: any[] = [];
    const written: any[] = [];
    const adapter = new CodexAdapter({ runExec: async () => ({ code: 0, stdout, stderr: "" }) });
    return {
      logged,
      written,
      run: (spec: any, opts: any = {}) =>
        delegate(
          spec,
          {
            adapter,
            spawnConfig: { compositionDir: "/work", model: spec.model },
            writeArtifact: async (ns: string, name: string, content: string) => {
              written.push({ ns, name, content });
              return `artifacts/${ns}/${name}`;
            },
            logDecision: async (rec: any) => logged.push(rec),
            secrets: {},
            now: () => "2026-06-14T00:00:00Z"
          },
          { modelAllowlist: /^(gpt-5|o[34]|codex)/i, ...opts }
        )
    };
  }

  it("the Codex secondary validates the spec, returns schema-valid {summary, artifacts}, writes output, logs", async () => {
    const h = harness();
    const result = await h.run({ task: "refactor utils.ts", paths: ["utils.ts"], model: "gpt-5-codex" });
    expect(validateDelegationResult(result)).toEqual([]);
    expect(result.summary).toContain("[codex] refactored");
    expect(result.artifacts[0]).toMatch(/^artifacts\/delegations\//);
    expect(h.written).toHaveLength(1); // full output → Artifact Store
    expect(h.logged[0]).toMatchObject({ kind: "delegation", runtime: "codex" });
  });

  it("primary integrates the Codex summary (secondary-delegate-ok)", async () => {
    const h = harness("Implemented the migration in 3 files; all tests pass.");
    const result = await h.run({ task: "migrate the schema", model: "gpt-5-codex" });
    // the 'primary' would weave this summary into its own reply
    expect(result.summary).toContain("Implemented the migration");
    expect(Array.isArray(result.artifacts)).toBe(true);
  });

  it("rejects a model outside the Codex allowlist (loud)", async () => {
    const h = harness();
    await expect(h.run({ task: "x", model: "claude-opus" })).rejects.toMatchObject({ code: "invalid-task-spec" });
  });
});


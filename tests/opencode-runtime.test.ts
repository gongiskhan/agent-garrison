import path from "node:path";
import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs
import { OpenCodeAdapter, buildRunArgs, parseRunOutput } from "../fittings/seed/opencode-runtime/lib/opencode-adapter.mjs";
// @ts-ignore
import { delegate, validateDelegationResult, runAdapterConformance } from "../packages/claude-pty/src/index.mjs";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";

// A stub `opencode run` output line — the NDJSON event shape (text arrives as
// {type:"text", part:{text}}, session id as the top-level sessionID on every event).
function textEvent(text: string, sessionID = "ses_stub") {
  return JSON.stringify({ type: "text", part: { type: "text", text }, sessionID });
}

describe("OpenCode runtime adapter (MRr-opencode)", () => {
  it("buildRunArgs: opencode run --format json --auto, model via -m, effort via --variant, session via -s, prompt via STDIN (never argv)", () => {
    const { bin, argv, stdinFromPrompt } = buildRunArgs({
      model: "ollama-local/qwen2.5:3b",
      compositionDir: "/work/proj",
      variant: "high",
      sessionId: "ses_prior"
    });
    expect(bin).toBe("opencode");
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--format");
    expect(argv).toContain("json");
    expect(argv).toContain("--auto"); // headless auto-approve permissions
    expect(argv).toContain("-m");
    expect(argv).toContain("ollama-local/qwen2.5:3b");
    expect(argv).toContain("--variant");
    expect(argv).toContain("high");
    expect(argv).toContain("--dir");
    expect(argv).toContain("/work/proj");
    expect(argv).toContain("-s");
    expect(argv).toContain("ses_prior"); // resume the minted session
    expect(stdinFromPrompt).toBe(true);
    // the prompt is NEVER in argv (it travels on stdin)
    expect(argv.join(" ")).not.toContain("the actual task text");
  });

  it("parseRunOutput: text from text events, session id from top-level sessionID, terminal error surfaced", () => {
    const nd = [
      '{"type":"step-start","sessionID":"ses_z"}',
      textEvent("Implemented ", "ses_z"),
      "not-json-noise",
      textEvent("the migration.", "ses_z")
    ].join("\n");
    const ok = parseRunOutput(nd);
    expect(ok.text).toBe("Implemented the migration.");
    expect(ok.sessionId).toBe("ses_z");
    expect(ok.error).toBeNull();

    const errOut = '{"type":"error","sessionID":"ses_e","error":{"name":"UnknownError","data":{"message":"boom"}}}';
    const bad = parseRunOutput(errOut);
    expect(bad.text).toBe("");
    expect(bad.sessionId).toBe("ses_e");
    expect(bad.error).toBe("boom");
    expect(parseRunOutput("")).toEqual({ text: "", sessionId: null, error: null });
  });

  it("passes the RuntimeAdapter conformance harness (stub exec)", async () => {
    const adapter = new OpenCodeAdapter({ runExec: async () => ({ code: 0, stdout: textEvent("opencode did the work"), stderr: "" }) });
    const report = await runAdapterConformance(adapter, {
      config: { compositionDir: "/tmp/x", model: "ollama-local/qwen2.5:3b" },
      turnText: "ping"
    });
    expect(report.ok).toBe(true);
    expect(report.runtime).toBe("opencode");
  });

  it("feeds the prompt to opencode via stdin (never argv) and captures the minted session id", async () => {
    let seenStdin = "";
    const adapter = new OpenCodeAdapter({
      runExec: async ({ stdin, argv }: any) => {
        seenStdin = stdin;
        // the prompt never reaches argv
        expect(argv.join(" ")).not.toContain("refactor the parser");
        return { code: 0, stdout: textEvent("done", "ses_minted"), stderr: "" };
      }
    });
    const s = await adapter.spawn({ model: "ollama-local/qwen2.5:3b" });
    await adapter.sendTurn(s, "refactor the parser");
    const r = await adapter.awaitResponse(s);
    expect(seenStdin).toContain("refactor the parser");
    expect(r.text).toBe("done");
    // the session id is captured so the NEXT turn resumes it via -s
    expect(s.sessionId).toBe("ses_minted");
  });

  it("setEffort maps to --variant, and resume replays a prior opencode session id via -s", async () => {
    let seenArgv: string[] = [];
    const adapter = new OpenCodeAdapter({
      runExec: async ({ argv }: any) => {
        seenArgv = argv;
        return { code: 0, stdout: textEvent("k"), stderr: "" };
      }
    });
    const resumed = await adapter.resume({ model: "ollama-local/qwen2.5:3b", sessionId: "ses_old" });
    await adapter.setEffort(resumed, "max");
    await adapter.sendTurn(resumed, "continue");
    await adapter.awaitResponse(resumed);
    expect(seenArgv).toContain("-s");
    expect(seenArgv).toContain("ses_old");
    expect(seenArgv).toContain("--variant");
    expect(seenArgv).toContain("max");
  });

  it("a code-0 run that only errored (no text) fails loudly instead of returning empty", async () => {
    const adapter = new OpenCodeAdapter({
      runExec: async () => ({ code: 0, stdout: '{"type":"error","sessionID":"ses_e","error":{"data":{"message":"provider not configured"}}}', stderr: "" })
    });
    const s = await adapter.spawn({ model: "ollama-local/qwen2.5:3b" });
    await adapter.sendTurn(s, "x");
    await expect(adapter.awaitResponse(s)).rejects.toThrow(/provider not configured/);
  });
});

describe("OpenCode runtime-bridge delegation (MRr-bridge / opencode-runtime-ok)", () => {
  function harness(stdout = textEvent("[opencode] refactored utils.ts; added tests", "ses_d")) {
    const logged: any[] = [];
    const written: any[] = [];
    const adapter = new OpenCodeAdapter({ runExec: async () => ({ code: 0, stdout, stderr: "" }) });
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
            now: () => "2026-07-12T00:00:00Z"
          },
          { modelAllowlist: /^[a-z0-9][a-z0-9._-]*\/.+/i, ...opts }
        )
    };
  }

  it("validates the spec, returns schema-valid {summary, artifacts}, writes output, logs", async () => {
    const h = harness();
    const result = await h.run({ task: "refactor utils.ts", paths: ["utils.ts"], model: "ollama-local/qwen2.5:3b" });
    expect(validateDelegationResult(result)).toEqual([]);
    expect(result.summary).toContain("[opencode] refactored");
    expect(result.artifacts[0]).toMatch(/^artifacts\/delegations\//);
    expect(h.written).toHaveLength(1); // full output → Artifact Store
    expect(h.logged[0]).toMatchObject({ kind: "delegation", runtime: "opencode" });
  });

  it("primary integrates the OpenCode summary (secondary-delegate-ok)", async () => {
    const h = harness(textEvent("Implemented the migration in 3 files; all tests pass.", "ses_d"));
    const result = await h.run({ task: "migrate the schema", model: "ollama-local/qwen2.5:3b" });
    expect(result.summary).toContain("Implemented the migration");
    expect(Array.isArray(result.artifacts)).toBe(true);
  });

  it("rejects a model outside the provider/model allowlist (loud)", async () => {
    const h = harness();
    await expect(h.run({ task: "x", model: "just-a-bare-name" })).rejects.toMatchObject({ code: "invalid-task-spec" });
  });
});

describe("opencode-runtime seed manifest", () => {
  it("parses with faculty runtimes, provides runtime:opencode, config-file provider mechanism, generic quarters descriptor", async () => {
    const manifest = await readYamlFile<{ "x-garrison"?: unknown }>(
      path.resolve(__dirname, "..", "fittings", "seed", "opencode-runtime", "apm.yml")
    );
    const metadata = parseGarrisonMetadata(manifest!["x-garrison"]);
    expect(metadata.faculty).toBe("runtimes");
    expect(metadata.cardinality_hint).toBe("multi");
    expect(metadata.component_shape).toBe("cli-skill");
    expect(metadata.provides).toContainEqual({ kind: "runtime", name: "opencode" });
    expect(metadata.consumes).toEqual([]);
    expect(metadata.provider_mechanism).toMatchObject({ type: "config-file", config_format: "json", model_key: "model" });
    expect(metadata.quarters_descriptor).toMatchObject({ tier: "generic", id: "opencode", context_file: "AGENTS.md" });
    expect((metadata.summary ?? "").trim().length).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs package
import { delegate, validateTaskSpec, parseTaskSpec, validateDelegationResult, DelegationError } from "../packages/claude-pty/src/index.mjs";

// A stub secondary runtime adapter — returns canned output, no live model.
function makeStubAdapter(id = "codex") {
  return {
    id,
    _q: new WeakMap<object, string>(),
    async spawn(c: any) {
      return { alive: true, cwd: c?.compositionDir };
    },
    async awaitReady() {},
    async sendTurn(s: any, text: string) {
      (this as any)._q.set(s, `[${id}] handled: ${text.split("\n")[0]}`);
    },
    async awaitResponse(s: any) {
      return { text: (this as any)._q.get(s), artifacts: [] };
    },
    async teardown() {}
  };
}

function deps(extra: any = {}) {
  const logged: any[] = [];
  const written: any[] = [];
  return {
    logged,
    written,
    adapter: makeStubAdapter(),
    spawnConfig: { compositionDir: "/tmp/x", model: "gpt-5-codex" },
    writeArtifact: async (ns: string, name: string, content: string) => {
      written.push({ ns, name, content });
      return `artifacts/${ns}/${name}`;
    },
    logDecision: async (rec: any) => {
      logged.push(rec);
    },
    now: () => "2026-06-14T00:00:00Z",
    ...extra
  };
}

describe("runtime bridge — delegate contract (MRr-bridge)", () => {
  it("validateTaskSpec rejects a missing task + a model outside the allowlist", () => {
    expect(validateTaskSpec({}, {})).toContain("missing required `task` (string)");
    const e = validateTaskSpec({ task: "x", model: "evil-model" }, { modelAllowlist: /^gpt-5/ });
    expect(e.join()).toContain("not allowed by the provider allowlist");
    expect(validateTaskSpec({ task: "x", model: "gpt-5-codex" }, { modelAllowlist: /^gpt-5/ })).toEqual([]);
  });

  it("parseTaskSpec fails loudly on invalid JSON (never silently swallowed)", () => {
    expect(() => parseTaskSpec("{not json")).toThrowError(DelegationError);
  });

  it("delegate runs the secondary, writes full output to the Artifact Store, returns a schema-valid summary + artifact path", async () => {
    const d = deps();
    const result = await delegate({ task: "refactor utils.ts", paths: ["utils.ts"] }, d);
    expect(validateDelegationResult(result)).toEqual([]);
    expect(result.summary).toContain("[codex] handled");
    expect(result.artifacts[0]).toMatch(/^artifacts\/delegations\//);
    // full output written to the artifact store
    expect(d.written).toHaveLength(1);
    expect(d.written[0].content).toContain("[codex] handled");
  });

  it("delegate logs the delegation to decisions.jsonl", async () => {
    const d = deps();
    await delegate({ task: "do a thing" }, d);
    expect(d.logged).toHaveLength(1);
    expect(d.logged[0]).toMatchObject({ kind: "delegation", runtime: "codex" });
  });

  it("delegate fails loudly with locked-vs-absent when a required key is missing", async () => {
    await expect(delegate({ task: "x" }, deps({ secrets: null }), { requiredKey: "OPENAI_API_KEY" })).rejects.toMatchObject({
      code: "missing-key",
      vaultLocked: true
    });
    await expect(delegate({ task: "x" }, deps({ secrets: {} }), { requiredKey: "OPENAI_API_KEY" })).rejects.toMatchObject({
      code: "missing-key",
      vaultLocked: false
    });
  });

  it("delegate retries once then fails loudly when the adapter keeps throwing", async () => {
    let calls = 0;
    const flaky = makeStubAdapter();
    (flaky as any).spawn = async () => {
      calls++;
      throw new Error("spawn boom");
    };
    await expect(delegate({ task: "x" }, deps({ adapter: flaky }))).rejects.toMatchObject({ code: "delegation-failed" });
    expect(calls).toBe(2); // initial + one retry
  });
});

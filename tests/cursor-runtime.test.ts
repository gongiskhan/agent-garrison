import path from "node:path";
import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs
import { CursorAdapter, buildRunArgs, parseRunOutput, cursorPermissionArgs } from "../fittings/seed/cursor-runtime/lib/cursor-adapter.mjs";
// @ts-ignore
import { probeFailure } from "../fittings/seed/cursor-runtime/scripts/bridge.mjs";
// @ts-ignore
import { linkConfigHome } from "../fittings/seed/cursor-runtime/scripts/link-config-home.mjs";
// @ts-ignore
import { delegate, validateDelegationResult, runAdapterConformance, ADAPTER_METHODS } from "../packages/claude-pty/src/index.mjs";
import { parseGarrisonMetadata } from "@/lib/metadata";
import { readYamlFile } from "@/lib/yaml";

// The `--output-format json` terminal event, exactly as cursor-agent 2026.07.23
// prints it (captured live).
function resultEvent(text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 5765,
    result: text,
    session_id: "9a5cfb2b-8c9e-4942-b450-474d58cc13f4",
    usage: { inputTokens: 12566, outputTokens: 34, cacheReadTokens: 4608, cacheWriteTokens: 0 },
    ...extra
  });
}

describe("Cursor runtime adapter (MRr-cursor)", () => {
  it("buildRunArgs: cursor-agent -p --output-format json, model via --model, cwd via --workspace, session via --resume, prompt via STDIN (never argv)", () => {
    const { bin, argv, stdinFromPrompt } = buildRunArgs({
      model: "gpt-5.3-codex-high",
      compositionDir: "/work/proj",
      sessionId: "chat_prior",
      permissionMode: "bypassPermissions"
    });
    expect(bin).toBe("cursor-agent");
    expect(argv[0]).toBe("-p");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    expect(argv).toContain("--model");
    expect(argv).toContain("gpt-5.3-codex-high");
    expect(argv).toContain("--workspace");
    expect(argv).toContain("/work/proj");
    expect(argv).toContain("--resume");
    expect(argv).toContain("chat_prior"); // resume the minted chat
    expect(stdinFromPrompt).toBe(true);
    // the prompt is NEVER in argv (it travels on stdin)
    expect(argv.join(" ")).not.toContain("the actual task text");
  });

  it("carries NO effort flag — Cursor encodes effort in the model id, and its bracket override is rejected for non-parameterized models", () => {
    const { argv } = buildRunArgs({ model: "gpt-5.3-codex", effort: "high", permissionMode: "auto" });
    expect(argv).not.toContain("--effort");
    expect(argv.join(" ")).not.toContain("high");
  });

  it("permission mapping: full access runs everything, edit modes sandbox, everything else fails closed to read-only ask — --trust on every path", () => {
    for (const mode of ["auto", "bypassPermissions", "full-auto"]) {
      expect(cursorPermissionArgs({ permissionMode: mode })).toEqual(["--trust", "--force"]);
    }
    for (const mode of ["acceptEdits", "allow-file-edits"]) {
      expect(cursorPermissionArgs({ permissionMode: mode })).toEqual(["--trust", "--force", "--sandbox", "enabled"]);
    }
    for (const mode of ["plan", "default", "totally-unknown", null]) {
      expect(cursorPermissionArgs({ permissionMode: mode })).toEqual(["--trust", "--mode", "ask"]);
    }
    // the gateway's inherited env is honored when no explicit mode is configured
    expect(cursorPermissionArgs({ env: { GARRISON_PERMISSION_MODE: "bypassPermissions" } })).toEqual(["--trust", "--force"]);
    // an explicit config value wins over the environment
    expect(cursorPermissionArgs({ permissionMode: "plan", env: { GARRISON_PERMISSION_MODE: "auto" } })).toEqual([
      "--trust",
      "--mode",
      "ask"
    ]);
  });

  it("exposes every RuntimeAdapter method + a string id", () => {
    const adapter = new CursorAdapter();
    expect(adapter.id).toBe("cursor");
    for (const m of ADAPTER_METHODS) {
      expect(typeof adapter[m]).toBe("function");
    }
  });

  it("parseRunOutput: text + session id + usage from the result event, the LAST result wins", () => {
    const ok = parseRunOutput(resultEvent("Implemented the migration."));
    expect(ok.text).toBe("Implemented the migration.");
    expect(ok.sessionId).toBe("9a5cfb2b-8c9e-4942-b450-474d58cc13f4");
    expect(ok.error).toBeNull();
    expect(ok.usage).toMatchObject({ inputTokens: 12566, outputTokens: 34 });

    // noise lines are ignored; the final result object is authoritative
    const noisy = ["not-json-noise", resultEvent("first"), resultEvent("second")].join("\n");
    expect(parseRunOutput(noisy).text).toBe("second");

    // a failed result is an error even though the process exited 0
    const bad = parseRunOutput(resultEvent("rate limited", { is_error: true, subtype: "error" }));
    expect(bad.error).toBe("rate limited");

    expect(parseRunOutput("")).toEqual({ text: "", sessionId: null, error: null, usage: null });
  });

  it("passes the RuntimeAdapter conformance harness (stub exec)", async () => {
    const adapter = new CursorAdapter({ runExec: async () => ({ code: 0, stdout: resultEvent("cursor did the work"), stderr: "" }) });
    const report = await runAdapterConformance(adapter, {
      config: { compositionDir: "/tmp/x", model: "auto", permissionMode: "bypassPermissions" },
      turnText: "ping"
    });
    expect(report.ok).toBe(true);
    expect(report.runtime).toBe("cursor");
  });

  it("feeds the prompt to cursor-agent via stdin (never argv) and captures the minted chat id + usage", async () => {
    let seenStdin = "";
    const adapter = new CursorAdapter({
      runExec: async ({ stdin, argv }: any) => {
        seenStdin = stdin;
        // the prompt never reaches argv
        expect(argv.join(" ")).not.toContain("refactor the parser");
        return { code: 0, stdout: resultEvent("done", { session_id: "chat_minted" }), stderr: "" };
      }
    });
    const s = await adapter.spawn({ model: "auto", permissionMode: "auto" });
    await adapter.sendTurn(s, "refactor the parser");
    const r = await adapter.awaitResponse(s);
    expect(seenStdin).toContain("refactor the parser");
    expect(r.text).toBe("done");
    // the chat id is captured so the NEXT turn resumes it via --resume
    expect(s.sessionId).toBe("chat_minted");
    expect(s.usage).toMatchObject({ inputTokens: 12566 });
  });

  it("setEffort is retained but NEVER claimed as applied (effort lives in the model id)", async () => {
    const adapter = new CursorAdapter({ runExec: async () => ({ code: 0, stdout: resultEvent("k"), stderr: "" }) });
    const s = await adapter.spawn({ model: "gpt-5.3-codex", effort: "high" });
    expect(s.effortApplied).toBe(false);
    await adapter.setEffort(s, "max");
    expect(s.effort).toBe("max");
    expect(s.effortApplied).toBe(false);
    // setModel IS the real effort control here
    await adapter.setModel(s, "gpt-5.3-codex-xhigh");
    expect(s.model).toBe("gpt-5.3-codex-xhigh");
  });

  it("resume replays a prior Cursor chat id via --resume", async () => {
    let seenArgv: string[] = [];
    const adapter = new CursorAdapter({
      runExec: async ({ argv }: any) => {
        seenArgv = argv;
        return { code: 0, stdout: resultEvent("k"), stderr: "" };
      }
    });
    const resumed = await adapter.resume({ model: "auto", sessionId: "chat_old", permissionMode: "auto" });
    await adapter.sendTurn(resumed, "continue");
    await adapter.awaitResponse(resumed);
    expect(seenArgv).toContain("--resume");
    expect(seenArgv).toContain("chat_old");
  });

  it("(a) exit 0 with the WORKSPACE TRUST notice (non-JSON) fails loudly, surfacing the raw output", async () => {
    // The real live shape: cursor-agent exits 0 and prints a human notice when the
    // workspace is untrusted. Returning "" here would be a silent no-op turn.
    const notice = "⚠ Workspace Trust Required\n\n  Cursor Agent can execute code and access files in this directory.";
    const adapter = new CursorAdapter({ runExec: async () => ({ code: 0, stdout: notice, stderr: "" }) });
    const s = await adapter.spawn({ model: "auto" });
    await adapter.sendTurn(s, "x");
    await expect(adapter.awaitResponse(s)).rejects.toThrow(/no assistant text[\s\S]*Workspace Trust Required/);
  });

  it("(b) exit 0 with EMPTY stdout fails loudly (never fabricates an ok result)", async () => {
    const adapter = new CursorAdapter({ runExec: async () => ({ code: 0, stdout: "", stderr: "" }) });
    const s = await adapter.spawn({ model: "auto" });
    await adapter.sendTurn(s, "x");
    await expect(adapter.awaitResponse(s)).rejects.toThrow(/no assistant text/);
  });

  it("(c) a result event flagged is_error fails loudly, preserving the text on the thrown error", async () => {
    const adapter = new CursorAdapter({
      runExec: async () => ({ code: 0, stdout: resultEvent("model overloaded", { is_error: true, subtype: "error" }), stderr: "" })
    });
    const s = await adapter.spawn({ model: "auto" });
    await adapter.sendTurn(s, "x");
    await expect(adapter.awaitResponse(s)).rejects.toMatchObject({
      message: expect.stringMatching(/model overloaded/),
      partialText: "model overloaded"
    });
  });

  it("(d) a non-zero exit fails loudly with the stderr", async () => {
    const adapter = new CursorAdapter({ runExec: async () => ({ code: 3, stdout: "", stderr: "boom" }) });
    const s = await adapter.spawn({ model: "auto" });
    await adapter.sendTurn(s, "x");
    await expect(adapter.awaitResponse(s)).rejects.toThrow(/cursor-agent exited 3: boom/);
  });

  it("cancel settles the in-flight turn with a stop reason instead of throwing, and does not poison the next turn", async () => {
    let settleFn: ((r: unknown) => void) | null = null;
    const fakeChild = { exitCode: null, signalCode: null, kill: () => true };
    const adapter = new CursorAdapter({
      runExec: ({ onSpawn }: any) =>
        new Promise((resolve) => {
          settleFn = resolve;
          onSpawn?.({ child: fakeChild, partial: () => "", settle: resolve });
        })
    });
    const s = await adapter.spawn({ model: "auto", permissionMode: "auto" });
    await adapter.sendTurn(s, "long task");
    expect(await adapter.cancel(s)).toBe(true);
    expect(await adapter.cancel(s)).toBe(true); // idempotent — no second escalation
    const r = await adapter.awaitResponse(s);
    expect(r.stoppedReason).toBe("cancelled");
    expect(settleFn).not.toBeNull();
    // the cancel flag is cleared, so the NEXT turn is a normal one
    expect(s.cancelRequested).toBe(false);
    // cancel with nothing in flight is a no-op that does not arm the flag
    expect(await adapter.cancel(s)).toBe(false);
    expect(s.cancelRequested).toBe(false);
  });
});

describe("Cursor runtime-bridge delegation (MRr-bridge / cursor-runtime-ok)", () => {
  function harness(stdout = resultEvent("[cursor] refactored utils.ts; added tests")) {
    const logged: any[] = [];
    const written: any[] = [];
    const adapter = new CursorAdapter({ runExec: async () => ({ code: 0, stdout, stderr: "" }) });
    return {
      logged,
      written,
      run: (spec: any, opts: any = {}) =>
        delegate(
          spec,
          {
            adapter,
            spawnConfig: { compositionDir: "/work", model: spec.model, permissionMode: "auto" },
            writeArtifact: async (ns: string, name: string, content: string) => {
              written.push({ ns, name, content });
              return `artifacts/${ns}/${name}`;
            },
            logDecision: async (rec: any) => logged.push(rec),
            secrets: {},
            now: () => "2026-07-29T00:00:00Z"
          },
          { modelAllowlist: /^[a-z0-9][a-z0-9._-]*(\[[^\]]*\])?$/i, ...opts }
        )
    };
  }

  it("validates the spec, returns schema-valid {summary, artifacts}, writes output, logs", async () => {
    const h = harness();
    const result = await h.run({ task: "refactor utils.ts", paths: ["utils.ts"], model: "gpt-5.3-codex-high" });
    expect(validateDelegationResult(result)).toEqual([]);
    expect(result.summary).toContain("[cursor] refactored");
    expect(result.artifacts[0]).toMatch(/^artifacts\/delegations\//);
    expect(h.written).toHaveLength(1); // full output → Artifact Store
    expect(h.logged[0]).toMatchObject({ kind: "delegation", runtime: "cursor" });
  });

  it("primary integrates the Cursor summary (secondary-delegate-ok)", async () => {
    const h = harness(resultEvent("Implemented the migration in 3 files; all tests pass."));
    const result = await h.run({ task: "migrate the schema", model: "auto" });
    expect(result.summary).toContain("Implemented the migration");
    expect(Array.isArray(result.artifacts)).toBe(true);
  });

  it("accepts the CLI's bracket-override model form, rejects a model outside the allowlist (loud)", async () => {
    const ok = await harness().run({ task: "x", model: "claude-opus-4-8[context=1m,effort=high]" });
    expect(ok.summary.length).toBeGreaterThan(0);
    await expect(harness().run({ task: "x", model: "has spaces/and slashes" })).rejects.toMatchObject({
      code: "invalid-task-spec"
    });
  });

  it("rejects a spec missing the required task (loud)", async () => {
    await expect(harness().run({ model: "auto" })).rejects.toMatchObject({ code: "invalid-task-spec" });
  });
});

describe("cursor-runtime bridge probe", () => {
  const okVersion = { status: 0, stdout: "2026.07.23-e383d2b\n", stderr: "" };

  it("passes when the CLI is present AND the box is authenticated", () => {
    const run = (_bin: string, argv: string[]) =>
      argv[0] === "--version" ? okVersion : { status: 0, stdout: JSON.stringify({ status: "authenticated", isAuthenticated: true }), stderr: "" };
    expect(probeFailure(run, {})).toBeNull();
  });

  it("passes on a CURSOR_API_KEY without consulting the stored login", () => {
    let statusCalls = 0;
    const run = (_bin: string, argv: string[]) => {
      if (argv[0] === "--version") return okVersion;
      statusCalls += 1;
      return { status: 1, stdout: "", stderr: "" };
    };
    expect(probeFailure(run, { CURSOR_API_KEY: "sk-cursor-test" })).toBeNull();
    expect(statusCalls).toBe(0);
  });

  it("fails loudly when the CLI is absent", () => {
    const run = () => ({ status: 127, stdout: "", stderr: "command not found" });
    expect(probeFailure(run, {})).toMatch(/not found on PATH/);
  });

  it("fails loudly when the CLI is present but LOGGED OUT (a version-only probe would have passed)", () => {
    const run = (_bin: string, argv: string[]) =>
      argv[0] === "--version" ? okVersion : { status: 0, stdout: JSON.stringify({ status: "unauthenticated", isAuthenticated: false }), stderr: "" };
    expect(probeFailure(run, {})).toMatch(/not authenticated[\s\S]*cursor-agent login/);
  });
});

// The setup hook exists because EVERY instance profile redirects XDG_CONFIG_HOME
// to $GARRISON_HOME/xdg/config, and that is where Cursor keeps its login — so a
// logged-in box reads as unauthenticated inside an instance without it. Verified
// live: `XDG_CONFIG_HOME=<empty dir> cursor-agent status` → unauthenticated;
// seed cursor/ into that dir → authenticated.
describe("cursor-runtime setup: config-home link", () => {
  const HOME = "/home/tester";
  const REAL = "/home/tester/.config/cursor";
  const XDG = "/home/tester/.garrison-dev/xdg/config";

  const TARGET = `${XDG}/cursor`;

  // A tiny in-memory fs stub covering only what linkConfigHome touches.
  // `target`: null = absent | {link} = symlink | {dir, auth?} = real dir | {file:true}
  function io({
    source = true,
    target = null as null | { link?: string; dir?: boolean; auth?: boolean; file?: boolean },
    parked = false
  } = {}) {
    const calls: string[] = [];
    return {
      calls,
      existsSync: (p: string) => {
        if (p === REAL) return source;
        if (p === `${TARGET}/auth.json`) return Boolean(target?.auth);
        if (p === `${TARGET}.pre-garrison`) return parked;
        return false;
      },
      lstatSync: (p: string) => {
        if (p !== TARGET || !target) throw new Error("ENOENT");
        return {
          isSymbolicLink: () => target.link !== undefined,
          isDirectory: () => target.dir === true
        };
      },
      readlinkSync: () => target?.link ?? "",
      mkdirSync: (p: string) => calls.push(`mkdir ${p}`),
      renameSync: (from: string, to: string) => calls.push(`rename ${from} -> ${to}`),
      symlinkSync: (from: string, to: string) => calls.push(`symlink ${to} -> ${from}`)
    };
  }

  it("links the real ~/.config/cursor into a redirected XDG home", () => {
    const fsStub = io();
    const r = linkConfigHome({ xdgConfigHome: XDG, homeDir: HOME, io: fsStub });
    expect(r.action).toBe("linked");
    expect(fsStub.calls).toEqual([`mkdir ${XDG}`, `symlink ${TARGET} -> ${REAL}`]);
  });

  it("is a no-op when XDG_CONFIG_HOME is unset or already the real ~/.config", () => {
    expect(linkConfigHome({ xdgConfigHome: "", homeDir: HOME, io: io() }).action).toBe("native");
    expect(linkConfigHome({ xdgConfigHome: `${HOME}/.config`, homeDir: HOME, io: io() }).action).toBe("native");
  });

  it("is idempotent — a link already pointing at the real dir is left alone", () => {
    const fsStub = io({ target: { link: REAL } });
    expect(linkConfigHome({ xdgConfigHome: XDG, homeDir: HOME, io: fsStub }).action).toBe("already-linked");
    expect(fsStub.calls).toEqual([]);
  });

  // The real first-run case: the failing probe itself makes cursor-agent write a
  // generated cli-config.json here. Refusing to displace it would leave the box
  // unauthenticated forever, so it is MOVED aside (never deleted) and linked over.
  it("moves aside a GENERATED config dir (no auth.json) and links over it", () => {
    const fsStub = io({ target: { dir: true } });
    const r = linkConfigHome({ xdgConfigHome: XDG, homeDir: HOME, io: fsStub });
    expect(r.action).toBe("linked");
    expect(fsStub.calls).toEqual([
      `rename ${TARGET} -> ${TARGET}.pre-garrison`,
      `symlink ${TARGET} -> ${REAL}`
    ]);
    expect(r.detail).toContain("pre-garrison");
  });

  it("never clobbers real credential state, a foreign link, a plain file, or an occupied backup name", () => {
    // a dir that HOLDS an auth.json is a real credential store
    const creds = io({ target: { dir: true, auth: true } });
    expect(linkConfigHome({ xdgConfigHome: XDG, homeDir: HOME, io: creds }).action).toBe("preserved");
    expect(creds.calls).toEqual([]);

    const file = io({ target: { file: true } }); // exists, not a symlink, not a dir
    expect(linkConfigHome({ xdgConfigHome: XDG, homeDir: HOME, io: file }).action).toBe("preserved");
    expect(file.calls).toEqual([]);

    const foreign = io({ target: { link: "/somewhere/else" } });
    const r = linkConfigHome({ xdgConfigHome: XDG, homeDir: HOME, io: foreign });
    expect(r.action).toBe("preserved");
    expect(r.detail).toContain("/somewhere/else");
    expect(foreign.calls).toEqual([]);

    // the backup name is taken — refuse rather than overwrite a prior rescue
    const taken = io({ target: { dir: true }, parked: true });
    expect(linkConfigHome({ xdgConfigHome: XDG, homeDir: HOME, io: taken }).action).toBe("preserved");
    expect(taken.calls).toEqual([]);
  });

  it("says what to do when the box never logged in, and does NOT fail setup (the probe is the gate)", () => {
    const fsStub = io({ source: false });
    const r = linkConfigHome({ xdgConfigHome: XDG, homeDir: HOME, io: fsStub });
    expect(r.action).toBe("no-source");
    expect(r.detail).toContain("cursor-agent login");
    expect(fsStub.calls).toEqual([]);
  });
});

// The CSG composition's live .garrison/routing.json is gitignored (machine-local
// policy), so the "only Cursor" claim is committed as routing.cursor-only.json and
// pinned here — otherwise a future seed-policy change silently reintroduces a
// Claude/Codex/ollama target and nobody notices until a turn lands off-engine.
describe("CSG composition — cursor-only routing policy", () => {
  const load = async () => {
    const fs = await import("node:fs/promises");
    return {
      policy: JSON.parse(
        await fs.readFile(path.resolve(__dirname, "..", "compositions", "csg", "routing.cursor-only.json"), "utf8")
      ),
      manifest: await readYamlFile<any>(path.resolve(__dirname, "..", "compositions", "csg", "apm.yml"))
    };
  };

  it("names cursor-runtime primary and declares only cursor targets", async () => {
    const { policy } = await load();
    expect(policy.primaryRuntime).toBe("cursor-runtime");
    expect(policy.targets.length).toBeGreaterThan(0);
    expect([...new Set(policy.targets.map((t: any) => t.runtime))]).toEqual(["cursor"]);
    // Secondary targets carry no provider: the validator only knows providers
    // declared in the policy's `providers` section, and Cursor has none there.
    expect(policy.targets.every((t: any) => t.provider === undefined)).toBe(true);
  });

  it("every target reference in the policy resolves to a declared cursor target", async () => {
    const { policy } = await load();
    const declared = new Set<string>(policy.targets.map((t: any) => t.id));
    const dangling: string[] = [];
    const walk = (node: unknown, keyPath: string) => {
      if (typeof node === "string") {
        // Reference sites: `target`/`targetId` keys, matrix column/cell values,
        // and a continuation's {verb: "route", arg: <targetId>}.
        if (/(^|\.)(target|targetId)$/.test(keyPath) || /\.matrix\./.test(keyPath)) {
          if (!declared.has(node)) dangling.push(`${keyPath} -> ${node}`);
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${keyPath}[${i}]`));
        return;
      }
      if (node && typeof node === "object") {
        const rec = node as Record<string, unknown>;
        if (rec.verb === "route" && typeof rec.arg === "string" && !declared.has(rec.arg)) {
          dangling.push(`${keyPath}.arg -> ${rec.arg}`);
        }
        for (const [k, v] of Object.entries(rec)) walk(v, keyPath ? `${keyPath}.${k}` : k);
      }
    };
    walk(policy.profiles, "profiles");
    walk(policy.exceptions, "exceptions");
    walk(policy.continuations, "continuations");
    expect(dangling).toEqual([]);
  });

  it("the composition's duty cells route only to cursor targets, with no effort knob", async () => {
    const { manifest } = await load();
    const comp = manifest["x-garrison"].composition;
    const targetIds = new Set<string>(comp.targets.map((t: any) => t.id));
    expect([...new Set(comp.targets.map((t: any) => t.runtime))]).toEqual(["cursor"]);
    for (const duty of comp.duties) {
      for (const level of duty.levels) {
        expect(targetIds.has(level.cell.target), `${duty.id} -> ${level.cell.target}`).toBe(true);
        // Cursor has no effort control (it lives in the model id), so a cell that
        // pinned one would be a knob with nothing behind it.
        expect(level.cell.effort, `${duty.id} declares an effort Cursor cannot apply`).toBeUndefined();
      }
    }
  });

  it("satisfies every readiness rule, with a clean duty graph", async () => {
    const { readComposition, selectedLibraryEntries } = await import("@/lib/compositions");
    const { resolveModel } = await import("@/lib/resolver");
    const composition = await readComposition("csg");
    const entries = await selectedLibraryEntries(composition.selections);
    const model = resolveModel({
      fittings: entries.map((e) => ({ id: e.id, metadata: e.metadata })),
      compositionDuties: composition.duties,
      selectedDuties: composition.selectedDuties
    });
    expect(model.errors).toEqual([]);
    // Name the unmet rules in the failure, not just a boolean — the three that
    // were missing (channel / memory-store / dispatch duty) are exactly what this
    // pins, and "ready: false" alone would not say which regressed.
    expect(model.rules.filter((r) => !r.met).map((r) => r.rule.id)).toEqual([]);
    expect(model.ready).toBe(true);
  });

  it("stations cursor-runtime and no other runtime fitting", async () => {
    const { manifest } = await load();
    const runtimes = manifest["x-garrison"].composition.selections.runtimes ?? [];
    expect(runtimes.map((r: any) => r.id)).toEqual(["cursor-runtime"]);
    const deps = manifest.dependencies.apm.map((d: any) => d.path);
    expect(deps.filter((p: string) => /-runtime$/.test(p))).toEqual(["../../fittings/seed/cursor-runtime"]);
  });
});

// Both halves of the routing brain reached for a second engine on a non-Claude
// primary, found by running CSG live:
//   - the classifier defaulted to a cheap Claude Code haiku PTY, because
//     "claude-code resolvable" is a PATH probe that says nothing about whether
//     that CLI can spawn. When it could not, the warm pool half-started and EVERY
//     turn logged classify-failed and fell through to the default route, silently.
//   - the Dispatcher called through garrison-call, which speaks HTTP wire shapes
//     only and so cannot reach a CLI engine at all.
// `routing_on_primary` is the single opt-out for both; default-off keeps every
// existing composition byte-identical.
describe("routing_on_primary (single-engine routing brain)", () => {
  const ctx = (opts: any = {}) => ({
    primary: { adapter: { id: "cursor" }, spawnConfig: { compositionDir: "/tmp/x", model: "auto" }, claude: false },
    primaryEngine: "cursor",
    spawnFn: null,
    classifierSpawnConfig: { compositionDir: "/tmp/x", model: "haiku" },
    opts,
    logFn: (_event: any) => {}
  });

  it("pins the classifier to the primary adapter when set, and says so in the log", async () => {
    // @ts-ignore — pure .mjs
    const { resolveClassifierAdapter } = await import("../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs");
    const events: any[] = [];
    const c = ctx({ routingOnPrimary: true });
    c.logFn = (e: any) => void events.push(e);
    const r = resolveClassifierAdapter(c);
    expect(r.adapter).toBe(c.primary.adapter);
    expect(r.spawnConfig).toBe(c.primary.spawnConfig);
    expect(events.map((e) => e.kind)).toContain("classifier-on-primary");
  });

  it("without it, a non-claude primary still takes the claude-code classifier when the CLI resolves (unchanged default)", async () => {
    // @ts-ignore — pure .mjs
    const { resolveClassifierAdapter } = await import("../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs");
    const r = resolveClassifierAdapter(ctx({ claudeCodeResolvable: true }));
    expect(r.adapter?.constructor?.name).toBe("ClaudeCodeAdapter");
    expect(r.spawnConfig.model).toBe("haiku");
  });

  it("CSG turns it on, and the gateway fitting documents it as a default-off boolean", async () => {
    const comp = await readYamlFile<any>(path.resolve(__dirname, "..", "compositions", "csg", "apm.yml"));
    const gw = comp["x-garrison"].composition.selections.gateway.find((g: any) => g.id === "http-gateway");
    expect(gw.config.routing_on_primary).toBe(true);

    const fitting = await readYamlFile<{ "x-garrison"?: unknown }>(
      path.resolve(__dirname, "..", "fittings", "seed", "http-gateway", "apm.yml")
    );
    const field = parseGarrisonMetadata(fitting!["x-garrison"]).config_schema?.find(
      (f) => f.key === "routing_on_primary"
    );
    expect(field).toMatchObject({ type: "boolean", default: false });
  });

  // The Dispatcher half. garrison-call is HTTP-only, so on a CLI-only composition
  // the adapter-backed invoker is the difference between a real dispatch and a
  // permanent low-confidence keyword fallback.
  it("the adapter-backed dispatch invoker runs one throwaway turn and returns its text", async () => {
    // @ts-ignore — pure .mjs
    const { makeAdapterCallInvoker } = await import("../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs");
    const seen: any = { spawned: null, prompt: null, tornDown: false };
    const adapter = {
      spawn: async (cfg: any) => ((seen.spawned = cfg), { id: "s1" }),
      awaitReady: async () => {},
      sendTurn: async (_s: any, text: string) => void (seen.prompt = text),
      awaitResponse: async () => ({ text: '{"duty":"code","level":2,"confidence":"high"}' }),
      teardown: async () => void (seen.tornDown = true)
    };
    const call = makeAdapterCallInvoker(adapter, { compositionDir: "/work", model: "auto" });
    const r = await call({ prompt: "classify this", model: "composer-2.5", shape: "ollama", provider: "ollama-local" });
    expect(r).toEqual({ ok: true, text: '{"duty":"code","level":2,"confidence":"high"}' });
    expect(seen.prompt).toBe("classify this");
    // the cell's model overrides the primary's; HTTP-only fields are ignored
    expect(seen.spawned).toMatchObject({ compositionDir: "/work", model: "composer-2.5" });
    // one-shot: dispatch must never inherit or pollute conversational context
    expect(seen.tornDown).toBe(true);
  });

  it("a failing dispatch turn returns ok:false instead of throwing (so dispatch() takes its fallback), and still tears down", async () => {
    // @ts-ignore — pure .mjs
    const { makeAdapterCallInvoker } = await import("../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs");
    let tornDown = false;
    const call = makeAdapterCallInvoker(
      {
        spawn: async () => ({}),
        awaitReady: async () => {},
        sendTurn: async () => {},
        awaitResponse: async () => {
          throw new Error("cursor-agent produced no assistant text");
        },
        teardown: async () => void (tornDown = true)
      },
      {}
    );
    const r = await call({ prompt: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no assistant text/);
    expect(tornDown).toBe(true);

    // No adapter at all is a loud-but-safe refusal, never a throw.
    expect(await makeAdapterCallInvoker(null)({ prompt: "x" })).toMatchObject({ ok: false });
  });
});

describe("cursor-runtime seed manifest", () => {
  it("parses with faculty runtimes, provides runtime:cursor, env provider mechanism, generic quarters descriptor", async () => {
    const manifest = await readYamlFile<{ "x-garrison"?: unknown }>(
      path.resolve(__dirname, "..", "fittings", "seed", "cursor-runtime", "apm.yml")
    );
    const metadata = parseGarrisonMetadata(manifest!["x-garrison"]);
    expect(metadata.faculty).toBe("runtimes");
    expect(metadata.cardinality_hint).toBe("multi");
    expect(metadata.component_shape).toBe("cli-skill");
    expect(metadata.provides).toContainEqual({ kind: "runtime", name: "cursor" });
    expect(metadata.consumes).toEqual([]);
    expect(metadata.provider_mechanism).toMatchObject({ type: "env", auth_env: "CURSOR_API_KEY", model_arg: "--model" });
    expect(metadata.quarters_descriptor).toMatchObject({ tier: "generic", id: "cursor", context_file: "AGENTS.md" });
    // No `account` key on purpose: there is no Cursor AccountPlatform, and a
    // runtime with an inert account picker is worse than none (see for_consumers).
    expect((metadata.config_schema ?? []).some((f) => f.key === "account")).toBe(false);
    expect((metadata.summary ?? "").trim().length).toBeGreaterThan(0);
  });
});

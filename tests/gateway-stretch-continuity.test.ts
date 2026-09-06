import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — production ESM helpers
import { prepareStretchContinuity } from "../fittings/seed/http-gateway/scripts/lib/stretch-continuity.mjs";
// @ts-ignore — production ESM launcher
import { runStretch } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

let home: string;
let project: string;
let config: string;
let env: NodeJS.ProcessEnv;
const readRows = (file: string) => {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
};
const sessions = () => {
  try { return fs.readdirSync(path.join(home, "state/sessions")).map((name) => JSON.parse(fs.readFileSync(path.join(home, "state/sessions", name), "utf8"))); }
  catch { return []; }
};
async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("continuity fixture did not settle");
}
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stretch-continuity-")));
  project = path.join(home, "project");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "CANONICAL_PROJECT_RULES: verify before editing.\n");
  fs.symlinkSync("CLAUDE.md", path.join(project, "AGENTS.md"));
  const cache = path.join(home, "state/cache/project");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "brief.json"), JSON.stringify({ fetched_at: "fixture", content: "CURATED_STARTUP: verify the shared design." }));
  fs.writeFileSync(path.join(cache, "peers.json"), JSON.stringify({ fetched_at: "fixture", content: "PEER_CONTEXT: another node owns the migration." }));
  const memory = path.join(home, "memory.mjs");
  fs.writeFileSync(memory, `import fs from 'node:fs';
const content=fs.readFileSync(0,'utf8');
fs.appendFileSync(${JSON.stringify(path.join(home, "memory.jsonl"))},JSON.stringify({args:process.argv.slice(2),content,workerPid:process.ppid})+'\\n');
console.log(JSON.stringify({content:'CURATED_STARTUP: shared memory remains available.'}));`);
  // This recorder forwards to the REAL Python bridge. Only the authority leaf
  // is replaced, so private metadata, hashed keys, queueing and caches are real.
  const recorder = path.join(home, "bridge.mjs");
  fs.writeFileSync(recorder, `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const input=fs.readFileSync(0,'utf8');
if(input) fs.appendFileSync(${JSON.stringify(path.join(home, "events.jsonl"))},input+'\\n');
const result=spawnSync('python3',[${JSON.stringify(path.resolve("scripts/agent-continuity.py"))},...process.argv.slice(2)],{input,encoding:'utf8',env:process.env});
process.stdout.write(result.stdout??''); process.exitCode=result.status??1;`);
  config = path.join(home, "config.json");
  fs.writeFileSync(config, JSON.stringify({ version: 1, node: "test-node", state_dir: path.join(home, "state"),
    memory_project: "main", basic_memory_command: [process.execPath, memory], bridge_command: [process.execPath, recorder],
    projects: [{ root: project, name: "Project", key: "project" }], peer_nodes: [], native_import_enabled: false }));
  env = { ...process.env, GARRISON_AGENT_CONTINUITY_CONFIG: config, GARRISON_COMPOSITION_ID: "fixture" };
});
afterEach(async () => {
  // Await the real detached workers that touched this private fixture. Their
  // cache/roster writes may finish after the foreground ended observation.
  await until(() => {
    const queued = ["pending", "roster-pending"].some((directory) => {
      try { return fs.readdirSync(path.join(home, "state", directory)).length > 0; } catch { return false; }
    });
    const running = readRows(path.join(home, "memory.jsonl")).some(({ workerPid }) => {
      try { process.kill(workerPid, 0); return true; } catch { return false; }
    });
    return !queued && !running;
  });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("shared continuity across stretch runtimes", () => {
  it.each(["agent-sdk", "codex"])("%s receives the shared cached context and publishes metadata-only start/end", async (runtime) => {
    let received = "";
    const turn = (_route: any, brief: string, options: any) => {
      received = brief;
      options.onRuntimeAdmission();
      return Promise.resolve({ reply: "PRIVATE_REPLY_MUST_NOT_BE_PUBLISHED", model: _route.target.model });
    };
    const gateway = {
      compositionDir: project,
      runAgentSdkTurn: (route: any, brief: string, _chunk: any, options: any) => turn(route, brief, options),
      runSecondaryTurn: turn, releaseConversationSessions: async () => {},
    };
    const result = await runStretch(gateway, {
      route: { duty: "responder", target: { runtime, model: runtime === "codex" ? "gpt-6-astra" : "claude-haiku-4-5" } },
      brief: "PRIVATE_PROMPT_MUST_NOT_BE_PUBLISHED", conversationId: "private-conversation-id", stretchId: "private-stretch-id", cwd: project, env,
    });
    expect(result.ok).toBe(true);
    expect(received).toContain("CURATED_STARTUP");
    expect(received).toContain("PEER_CONTEXT");
    expect(received.split("CANONICAL_PROJECT_RULES")).toHaveLength(2);
    await until(() => sessions()[0]?.status === "ended");
    await until(() => readRows(path.join(home, "memory.jsonl")).some((row) => row.content.includes("- Status: ended")));
    const record = sessions()[0];
    expect(record).toMatchObject({ source: `Garrison/${runtime}`, runtime, duty: "responder", node: "test-node", status: "ended", project: { key: "project" } });
    const shared = JSON.stringify(readRows(path.join(home, "memory.jsonl")));
    for (const privateValue of ["PRIVATE_PROMPT", "PRIVATE_REPLY", "private-conversation-id", "private-stretch-id", "CANONICAL_PROJECT_RULES"]) expect(shared).not.toContain(privateValue);
    const events = readRows(path.join(home, "events.jsonl"));
    expect(events.map((event) => event.hook_event_name)).toEqual(["SessionStart", "Checkpoint", "SessionEnd"]);
    for (const event of events) expect(Object.keys(event).sort()).toEqual(["cwd", "duty", "hook_event_name", "model", "runtime", "session_id"]);
  });

  it("does not invent a session when Stop lands before runtime admission", async () => {
    const controller = new AbortController();
    const prepared = await prepareStretchContinuity({ cwd: project, conversationId: "c", stretchId: "s", runtime: "codex", env, signal: controller.signal });
    expect(prepared.context).toContain("CURATED_STARTUP");
    controller.abort();
    prepared.admit();
    await prepared.finish();
    expect(sessions()).toEqual([]);
    expect(readRows(path.join(home, "events.jsonl"))).toEqual([]);
  });

  it("ends failed runtime sessions and emits independent structural heartbeats", async () => {
    const prepared = await prepareStretchContinuity({ cwd: project, conversationId: "c", stretchId: "s", model: "test", runtime: "agent-sdk", duty: "implement", env, heartbeatMs: 100 });
    prepared.admit();
    await until(() => readRows(path.join(home, "events.jsonl")).some((event) => event.hook_event_name === "Heartbeat"));
    await prepared.finish();
    expect(sessions()[0]).toMatchObject({ status: "ended", source: "Garrison/agent-sdk" });
    const result = await runStretch({ compositionDir: project, runSecondaryTurn(_route: any, _brief: string, options: any) {
      options.onRuntimeAdmission(); throw new Error("fixture runtime failed");
    } }, { route: { duty: "test", target: { runtime: "codex", model: "test" } }, brief: "private", cwd: project,
      conversationId: "c", stretchId: "failed", env });
    expect(result.ok).toBe(false);
    await until(() => sessions().length === 2 && sessions().every((session) => session.status === "ended"));
  });

  it("bounds an unavailable local bridge and leaves unregistered projects untouched", async () => {
    const cfg = JSON.parse(fs.readFileSync(config, "utf8"));
    cfg.bridge_command = [process.execPath, "-e", "setInterval(()=>{},1000)", "--"];
    fs.writeFileSync(config, JSON.stringify(cfg));
    const started = Date.now();
    const prepared = await prepareStretchContinuity({ cwd: project, stretchId: "timeout", env, timeoutMs: 60 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(prepared.context).toBe("");
    await prepared.finish();
    const unrelated = prepareStretchContinuity({ cwd: home, stretchId: "outside", env });
    expect(unrelated.context).toBe("");
    expect(sessions()).toEqual([]);
  });

  it("deduplicates same-project private overrides, excludes outside symlinks and discloses the instruction cap", async () => {
    fs.symlinkSync("CLAUDE.md", path.join(project, "AGENTS.override.md"));
    const outside = path.join(home, "private-secret");
    fs.writeFileSync(outside, "OUTSIDE_FILE_MUST_NEVER_BE_READ");
    fs.symlinkSync(outside, path.join(project, "PRD.md"));
    fs.writeFileSync(path.join(project, "auth.json"), "INSIDE_SECRET_MUST_NEVER_BE_READ");
    fs.symlinkSync("auth.json", path.join(project, "PLANING.md"));
    fs.writeFileSync(path.join(project, "TASKS.md"), "X".repeat(70000));
    const prepared = await prepareStretchContinuity({ cwd: project, stretchId: "instructions", env });
    expect(prepared.instructions.split("CANONICAL_PROJECT_RULES")).toHaveLength(2);
    expect(prepared.instructions).toContain("AGENTS.override.md (canonical CLAUDE.md)");
    expect(prepared.instructions).not.toContain("OUTSIDE_FILE");
    expect(prepared.instructions).not.toContain("INSIDE_SECRET");
    expect(prepared.instructions).toContain("truncated at 65536 bytes");
    expect(Buffer.byteLength(prepared.instructions)).toBeLessThanOrEqual(65536);
    await prepared.finish();
    expect(sessions()).toEqual([]);
  });

  it("rejects checkout symlink escapes from an enrolled project parent", async () => {
    const parent = path.join(home, "enrolled");
    fs.mkdirSync(parent);
    const linked = path.join(parent, "external-checkout");
    fs.symlinkSync(project, linked);
    const cfg = JSON.parse(fs.readFileSync(config, "utf8"));
    cfg.projects = [];
    cfg.project_parents = [parent];
    fs.writeFileSync(config, JSON.stringify(cfg));
    const prepared = await prepareStretchContinuity({ cwd: linked, stretchId: "escape", env });
    expect(prepared.instructions).toBe("");
    expect(prepared.context).toBe("");
    prepared.admit();
    await prepared.finish();
    expect(readRows(path.join(home, "events.jsonl"))).toEqual([]);
    expect(sessions()).toEqual([]);
  });
});

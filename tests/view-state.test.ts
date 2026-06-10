import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// W2 gate — the generic view-state store + the terminal fitting proof.
// Real on-disk store under a sandbox GARRISON_HOME; "simulated restart" =
// vi.resetModules() + fresh import, so nothing in memory carries over and
// the read can only come from disk. No mocking anywhere on the persistence
// path. Sentinels printed for the goal evaluator: PERSIST_OK <instanceId>,
// NO_SAVE_BUTTON_OK.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freshStore() {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__garrisonViewStateWrites;
  return await import("@/lib/view-state");
}

async function freshTerminalHelper() {
  vi.resetModules();
  return await import("../fittings/seed/terminal-armory-default/scripts/view-state.mjs");
}

describe("generic view-state store (Layer 2)", () => {
  let sandbox: string;
  const priorHome = process.env.GARRISON_HOME;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "garrison-view-state-"));
    process.env.GARRISON_HOME = sandbox;
  });

  afterEach(() => {
    if (priorHome === undefined) {
      delete process.env.GARRISON_HOME;
    } else {
      process.env.GARRISON_HOME = priorHome;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("round-trips known state across a simulated restart (PERSIST_OK)", async () => {
    const instanceId = "roundtrip-1";
    const known = {
      cwd: "/tmp/known-place",
      selection: ["a.ts", "b.ts"],
      nested: { expanded: true, depth: 3 }
    };

    const before = await freshStore();
    await before.writeViewState("test-fitting", instanceId, known);

    // Simulated restart: fresh module instance, no in-memory carryover.
    const after = await freshStore();
    const result = await after.readViewState("test-fitting", instanceId);

    expect(result.exists).toBe(true);
    expect(result.envelope?.state).toEqual(known);
    expect(result.envelope?.fittingId).toBe("test-fitting");
    expect(result.envelope?.instanceId).toBe(instanceId);
    console.log(`PERSIST_OK ${instanceId}`);
  });

  it("state survives with no explicit save call — debounced auto-write only (NO_SAVE_BUTTON_OK)", async () => {
    const before = await freshStore();
    // The view just changes state; persistence is continuous. Nothing below
    // calls write/save/flush — the trailing debounce lands the write alone.
    before.scheduleViewStateWrite("test-fitting", "autosave-1", { draft: "v1" }, 40);
    before.scheduleViewStateWrite("test-fitting", "autosave-1", { draft: "v2" }, 40);
    before.scheduleViewStateWrite("test-fitting", "autosave-1", { draft: "final" }, 40);
    await sleep(300);

    const after = await freshStore();
    const result = await after.readViewState("test-fitting", "autosave-1");
    expect(result.exists).toBe(true);
    // Coalesced: the last state wins, intermediate bursts never hit disk apart.
    expect(result.envelope?.state).toEqual({ draft: "final" });
    console.log("NO_SAVE_BUTTON_OK");
  });

  it("flushViewStateWrites lands pending writes immediately (shutdown path)", async () => {
    const store = await freshStore();
    store.scheduleViewStateWrite("test-fitting", "flush-1", { v: 1 }, 60_000);
    await store.flushViewStateWrites();
    const result = await store.readViewState("test-fitting", "flush-1");
    expect(result.exists).toBe(true);
    expect(result.envelope?.state).toEqual({ v: 1 });
  });

  it("delete removes exactly the one instance and reports absence honestly", async () => {
    const store = await freshStore();
    await store.writeViewState("test-fitting", "keep", { keep: true });
    await store.writeViewState("test-fitting", "drop", { keep: false });
    expect(await store.deleteViewState("test-fitting", "drop")).toBe(true);
    expect(await store.deleteViewState("test-fitting", "drop")).toBe(false);
    expect(await store.listInstanceIds("test-fitting")).toEqual(["keep"]);
  });

  it("an unrecognised on-disk shape reads as absent, never as someone else's state", async () => {
    const store = await freshStore();
    const dir = path.join(sandbox, "view-state", "test-fitting");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "garbage.json"), JSON.stringify({ not: "an envelope" }));
    const result = await store.readViewState("test-fitting", "garbage");
    expect(result.exists).toBe(false);
  });

  it("lists fittings from the store root", async () => {
    const store = await freshStore();
    await store.writeViewState("fitting-a", "x", {});
    await store.writeViewState("fitting-b", "y", {});
    expect(await store.listFittingIds()).toEqual(["fitting-a", "fitting-b"]);
  });
});

describe("terminal fitting proof — cwd + scrollback round-trip (D1)", () => {
  let sandbox: string;
  const priorHome = process.env.GARRISON_HOME;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "garrison-terminal-state-"));
    process.env.GARRISON_HOME = sandbox;
  });

  afterEach(() => {
    if (priorHome === undefined) {
      delete process.env.GARRISON_HOME;
    } else {
      process.env.GARRISON_HOME = priorHome;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("a terminal session's cwd + scrollback persist via debounced auto-write and rehydrate byte-identical", async () => {
    const instanceId = "sess-roundtrip";
    // Raw PTY bytes (ANSI colors included) — base64 round-trip must be exact.
    const scrollback = Buffer.from("ls -la\r\ntotal 42\r\n\x1b[32mgarrison\x1b[0m\r\n$ ", "utf8");

    const before = await freshTerminalHelper();
    // The server persists exactly like this: a debounced write whose factory
    // is evaluated at fire time (fresh cwd + buffer). No explicit save.
    before.scheduleInstanceWrite(
      "terminal-armory-default",
      instanceId,
      async () => ({
        name: "build-terminal",
        cwd: "/Users/ggomes/dev/garrison",
        shell: "/bin/zsh",
        command: null,
        scrollbackB64: scrollback.toString("base64")
      }),
      40
    );
    await sleep(250);

    // Simulated fitting-server restart.
    const after = await freshTerminalHelper();
    const all = await after.readAllInstances("terminal-armory-default");
    expect(all).toHaveLength(1);
    expect(all[0].instanceId).toBe(instanceId);
    const state = all[0].state as {
      name: string;
      cwd: string;
      shell: string;
      scrollbackB64: string;
    };
    expect(state.cwd).toBe("/Users/ggomes/dev/garrison");
    expect(state.name).toBe("build-terminal");
    expect(state.shell).toBe("/bin/zsh");
    expect(Buffer.from(state.scrollbackB64, "base64").equals(scrollback)).toBe(true);
    console.log(`PERSIST_OK ${instanceId}`);
  });

  it("explicit delete clears a session's persisted state; others survive", async () => {
    const helper = await freshTerminalHelper();
    await helper.writeInstanceState("terminal-armory-default", "sess-a", { cwd: "/a" });
    await helper.writeInstanceState("terminal-armory-default", "sess-b", { cwd: "/b" });
    expect(await helper.deleteInstance("terminal-armory-default", "sess-a")).toBe(true);
    const remaining = await helper.readAllInstances("terminal-armory-default");
    expect(remaining.map((r) => r.instanceId)).toEqual(["sess-b"]);
  });

  it("flushInstanceWrites lands a long-debounce write before shutdown kills the pty", async () => {
    const helper = await freshTerminalHelper();
    helper.scheduleInstanceWrite(
      "terminal-armory-default",
      "sess-shutdown",
      () => ({ cwd: "/live", scrollbackB64: Buffer.from("final output").toString("base64") }),
      60_000
    );
    await helper.flushInstanceWrites();
    const all = await helper.readAllInstances("terminal-armory-default");
    expect(all.map((r) => r.instanceId)).toContain("sess-shutdown");
  });
});

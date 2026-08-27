// Conversations B4 / risk R2 — the D14 codex mutex is SHARED, not bridge-only.
//
// Concurrent `codex` processes revoke the shared OAuth token. The delegation
// bridge has taken a machine-wide lock for that since D14; the gateway's
// secondary/primary codex lane never did, so a gateway-routed codex turn racing
// a bridge delegation could kill both credentials. The lock now lives in
// `packages/claude-pty/src/codex-lock.mjs` and BOTH lanes take it.
//
// What this pins: one lock file for both callers (identity, not just an equal
// path), `withCodexLock` really serializes, and the gateway's codex lane holds
// the lock across the whole spawn->teardown section while a non-codex runtime
// never touches it. The semantics themselves (grace window, dead-owner break,
// owner-only release) stay pinned by tests/codex-lock-serialization.test.ts and
// tests/codex-lock-concurrency.test.ts, which run UNCHANGED against the bridge's
// re-exports.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The lock path derives from CODEX_RUNTIME_DATA at module load, so point it at a
// temp dir BEFORE importing anything that pulls in codex-lock.mjs. The live
// ~/.garrison lock must never be touched by the suite.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "codex-lock-shared-"));
process.env.CODEX_RUNTIME_DATA = DATA_DIR;

let lock: any;
let bridge: any;
let gatewayRouting: any;

beforeAll(async () => {
  // @ts-ignore — pure .mjs
  lock = await import("../packages/claude-pty/src/codex-lock.mjs");
  // @ts-ignore — pure .mjs, entry-guarded (import is side-effect-free)
  bridge = await import("../fittings/seed/codex-runtime/scripts/bridge.mjs");
  // @ts-ignore — pure .mjs
  gatewayRouting = await import("../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs");
});

beforeEach(() => {
  rmSync(lock.LOCK_FILE, { force: true });
  process.env.CODEX_LOCK_POLL_MS = "5";
  process.env.CODEX_LOCK_WAIT_MAX_MS = "10000";
  process.env.CODEX_LOCK_CORRUPT_GRACE_MS = "250";
});

afterEach(() => {
  rmSync(lock.LOCK_FILE, { force: true });
  delete process.env.CODEX_LOCK_POLL_MS;
  delete process.env.CODEX_LOCK_WAIT_MAX_MS;
  delete process.env.CODEX_LOCK_CORRUPT_GRACE_MS;
});

describe("codex lock — one mutex, both lanes (R2)", () => {
  it("the bridge and the extracted module are the SAME lock, not two copies of one", () => {
    expect(bridge.LOCK_FILE).toBe(lock.LOCK_FILE);
    expect(bridge.LOCK_FILE).toBe(path.join(DATA_DIR, "codex.lock"));
    // Identity, not equality: two independently-defined acquire functions over
    // the same path would still be one mutex, but a re-export proves there is
    // exactly ONE implementation to keep true.
    expect(bridge.acquireCodexLock).toBe(lock.acquireCodexLock);
    expect(bridge.releaseCodexLock).toBe(lock.releaseCodexLock);
  });

  it("withCodexLock serializes two concurrent callers (never both in the section)", async () => {
    let inSection = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    const body = (name: string) => async () => {
      inSection += 1;
      maxConcurrent = Math.max(maxConcurrent, inSection);
      order.push(`${name}:enter`);
      await new Promise((r) => setTimeout(r, 40));
      order.push(`${name}:exit`);
      inSection -= 1;
    };
    await Promise.all([lock.withCodexLock(body("a")), lock.withCodexLock(body("b"))]);
    expect(maxConcurrent).toBe(1);
    // Whoever went first finished before the other started.
    expect(order[1]).toBe(order[0].replace(":enter", ":exit"));
    expect(existsSync(lock.LOCK_FILE)).toBe(false); // released on the way out
  });

  it("withCodexLock releases the lock when the body THROWS (a failed codex turn strands nothing)", async () => {
    await expect(
      lock.withCodexLock(async () => {
        throw new Error("codex exec exited 1");
      })
    ).rejects.toThrow(/codex exec exited 1/);
    expect(existsSync(lock.LOCK_FILE)).toBe(false);
  });

  it("the gateway's codex lane HOLDS the lock across spawn -> teardown", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "gar-codex-lane-"));
    const seen: Record<string, boolean> = {};
    const fake: any = {
      id: "codex",
      spawn: async () => {
        seen.spawn = existsSync(lock.LOCK_FILE);
        return {};
      },
      awaitReady: async () => {},
      sendTurn: async () => {},
      awaitResponse: async () => {
        seen.awaitResponse = existsSync(lock.LOCK_FILE);
        return { text: "codex replied", usedTokens: 15373 };
      },
      teardown: async () => {
        seen.teardown = existsSync(lock.LOCK_FILE);
      }
    };
    const gw: any = await gatewayRouting.createRoutedGateway({
      compositionDir: tmp,
      primaryEngine: "agent-sdk",
      agentSdkAdapter: { name: "fake-sdk" },
      operativeSpawnConfig: { compositionDir: tmp, model: "sonnet" },
      claudeCodeResolvable: false,
      logFn: () => {}
    });
    // Pre-seed the adapter cache so no fitting is imported from disk.
    gw._secondaryAdapters.set("codex", fake);

    expect(existsSync(lock.LOCK_FILE)).toBe(false);
    const r = await gw.runSecondaryTurn(
      { targetId: "sol", role: "delegate", target: { runtime: "codex", model: "gpt-5.6-sol" } },
      "review the diff",
      { cwd: tmp }
    );
    expect(r.reply).toBe("codex replied");
    expect(r.runtime).toBe("codex");
    // Held for the whole critical section…
    expect(seen).toEqual({ spawn: true, awaitResponse: true, teardown: true });
    // …and released after it.
    expect(existsSync(lock.LOCK_FILE)).toBe(false);
    gw.shutdown?.();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a NON-codex secondary never takes the lock (only codex has a credential concurrency revokes)", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "gar-noncodex-lane-"));
    const seen: boolean[] = [];
    const fake: any = {
      id: "gemini",
      spawn: async () => {
        seen.push(existsSync(lock.LOCK_FILE));
        return {};
      },
      awaitReady: async () => {},
      sendTurn: async () => {},
      awaitResponse: async () => {
        seen.push(existsSync(lock.LOCK_FILE));
        return { text: "gemini replied" };
      },
      teardown: async () => {}
    };
    const gw: any = await gatewayRouting.createRoutedGateway({
      compositionDir: tmp,
      primaryEngine: "agent-sdk",
      agentSdkAdapter: { name: "fake-sdk" },
      operativeSpawnConfig: { compositionDir: tmp, model: "sonnet" },
      claudeCodeResolvable: false,
      logFn: () => {}
    });
    gw._secondaryAdapters.set("gemini", fake);
    const r = await gw.runSecondaryTurn(
      { targetId: "gem", role: "delegate", target: { runtime: "gemini", model: "gemini-2.5-pro" } },
      "do the thing",
      { cwd: tmp }
    );
    expect(r.reply).toBe("gemini replied");
    expect(seen).toEqual([false, false]);
    expect(existsSync(lock.LOCK_FILE)).toBe(false);
    gw.shutdown?.();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a codex turn that THROWS still releases the lock (no wedge for the next turn)", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "gar-codex-throw-"));
    const fake: any = {
      id: "codex",
      spawn: async () => ({}),
      awaitReady: async () => {},
      sendTurn: async () => {},
      awaitResponse: async () => {
        throw new Error("codex exec exited 1: usage limit");
      },
      teardown: async () => {}
    };
    const gw: any = await gatewayRouting.createRoutedGateway({
      compositionDir: tmp,
      primaryEngine: "agent-sdk",
      agentSdkAdapter: { name: "fake-sdk" },
      operativeSpawnConfig: { compositionDir: tmp, model: "sonnet" },
      claudeCodeResolvable: false,
      logFn: () => {}
    });
    gw._secondaryAdapters.set("codex", fake);
    await expect(
      gw.runSecondaryTurn({ targetId: "sol", role: "delegate", target: { runtime: "codex" } }, "x", { cwd: tmp })
    ).rejects.toThrow(/usage limit/);
    expect(existsSync(lock.LOCK_FILE)).toBe(false);
    gw.shutdown?.();
    rmSync(tmp, { recursive: true, force: true });
  });
});

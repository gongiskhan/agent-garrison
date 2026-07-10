// GARRISON-UNIFY-V1 acceptance 7 / D14 regression: the codex-runtime bridge
// owns one-Codex-call-at-a-time serialization. The original acquire loop stole
// the lock from a LIVE owner whenever it read the lock file in the window after
// O_EXCL create but before the owner's JSON content flushed (an empty/partial
// read -> JSON.parse throw -> unconditional rmSync -> steal). Two concurrent
// codex processes revoke the shared OAuth token, so a stolen lock is a real
// serialization failure. The fix: an unparseable lock is broken only after it
// stays unparseable past a grace window (no tiny-JSON write ever takes that
// long); a genuinely orphaned/garbage lock still clears after the grace.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// DATA_DIR / LOCK_FILE derive from CODEX_RUNTIME_DATA at module load, so set it
// BEFORE importing the bridge. The lock tunables are read at acquire time, so a
// single import serves every test (each sets its own deadline; poll is fast).
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "codex-lock-"));
process.env.CODEX_RUNTIME_DATA = DATA_DIR;

let LOCK: string;
let acquireCodexLock: () => Promise<void>;
let releaseCodexLock: () => void;

beforeAll(async () => {
  // @ts-ignore - pure .mjs, entry-guarded (import is side-effect-free)
  const mod = await import("../fittings/seed/codex-runtime/scripts/bridge.mjs");
  acquireCodexLock = mod.acquireCodexLock;
  releaseCodexLock = mod.releaseCodexLock;
  LOCK = mod.LOCK_FILE;
});

beforeEach(() => {
  rmSync(LOCK, { force: true }); // fresh lock per test
  process.env.CODEX_LOCK_POLL_MS = "10";
  process.env.CODEX_LOCK_CORRUPT_GRACE_MS = "250";
});

afterEach(() => {
  rmSync(LOCK, { force: true });
  delete process.env.CODEX_LOCK_POLL_MS;
  delete process.env.CODEX_LOCK_CORRUPT_GRACE_MS;
  delete process.env.CODEX_LOCK_WAIT_MAX_MS;
});

describe("codex serialization lock (D14 / acceptance 7)", () => {
  it("does NOT steal a lock that is unparseable within the grace window (live owner mid-create)", async () => {
    // Model a live owner that has O_EXCL-created the lock but not yet flushed
    // its JSON: an empty file on disk.
    writeFileSync(LOCK, "", { flag: "wx" });
    process.env.CODEX_LOCK_WAIT_MAX_MS = "120"; // deadline < grace (250ms): must give up, not steal
    await expect(acquireCodexLock()).rejects.toThrow(/unreadable|refusing to run concurrently/);
    // The empty lock file the "owner" created is still present, unstolen.
    expect(existsSync(LOCK)).toBe(true);
    expect(readFileSync(LOCK, "utf8")).toBe("");
  });

  it("breaks a genuinely orphaned/garbage lock once it stays unparseable past the grace", async () => {
    writeFileSync(LOCK, "{ this is not json", { flag: "wx" });
    process.env.CODEX_LOCK_WAIT_MAX_MS = "5000"; // deadline > grace: garbage clears, we acquire
    await acquireCodexLock();
    const owner = JSON.parse(readFileSync(LOCK, "utf8"));
    expect(owner.pid).toBe(process.pid);
    releaseCodexLock();
    expect(existsSync(LOCK)).toBe(false);
  });

  it("breaks a parseable lock immediately when its owner pid is dead", async () => {
    // A parseable lock with a pid that cannot be alive (kill(pid,0) -> ESRCH).
    writeFileSync(LOCK, JSON.stringify({ pid: 2147480000, at: "old" }), { flag: "wx" });
    await acquireCodexLock();
    expect(JSON.parse(readFileSync(LOCK, "utf8")).pid).toBe(process.pid);
    releaseCodexLock();
  });

  it("acquire + release round-trips cleanly on a free lock", async () => {
    expect(existsSync(LOCK)).toBe(false);
    await acquireCodexLock();
    expect(JSON.parse(readFileSync(LOCK, "utf8")).pid).toBe(process.pid);
    releaseCodexLock();
    expect(existsSync(LOCK)).toBe(false);
  });

  it("release only removes the lock when THIS process owns it", async () => {
    writeFileSync(LOCK, JSON.stringify({ pid: 2147480001, at: "someone else" }), { flag: "wx" });
    releaseCodexLock(); // not ours — must be a no-op
    expect(existsSync(LOCK)).toBe(true);
    expect(JSON.parse(readFileSync(LOCK, "utf8")).pid).toBe(2147480001);
  });
});

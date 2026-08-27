// Adversarial ownership-generation coverage for the filesystem lock substrate
// used by Kanban lifecycle CAS. A holder's ticket is removed underneath it to
// simulate a stale-owner break; after a successor acquires, the old holder's
// finally must not remove that successor and admit a third critical section.
//
// The coordination intent ledger used to share this substrate and had its own
// two cases here. Its ledger now lives in the state service (one transaction,
// no file, no pid liveness), so the bakery lock it needed is gone with it —
// see tests/coord-mcp-state.test.ts for the coordination guarantees.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore — pure .mjs
import { withFileLock } from "../fittings/seed/kanban-loop/lib/board.mjs";
// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

function ticketFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith("ticket-") && name.endsWith(".json"))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

async function waitForFile(file: string, child?: ChildProcess, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (child && child.exitCode !== null) {
      throw new Error(`lock holder exited before ${file} was written (code ${child.exitCode})`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await pause(10);
  }
}

async function expectCleanExit(child: ChildProcess): Promise<void> {
  const code = child.exitCode === null ? (await once(child, "exit"))[0] : child.exitCode;
  expect(code).toBe(0);
}

describe("generation-safe stale lock breaking", () => {
  it("bridges ticket ownership onto the legacy path in both rollout directions", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanban-lock-legacy-bridge-"));
    const lock = join(root, "card.lock");

    await withFileLock(lock, "new owner visible to old writer", async () => {
      expect(readFileSync(lock, "utf8")).toMatch(new RegExp(`^${process.pid}:`));
      try {
        writeFileSync(lock, "999999", { flag: "wx" });
        throw new Error("legacy writer unexpectedly acquired a new owner's bridge");
      } catch (error: any) {
        expect(error.code).toBe("EEXIST");
      }
    });

    // Conversely, an already-running old owner is visible to a new ticket owner.
    writeFileSync(lock, String(process.pid), { flag: "wx" });
    let entered = false;
    const pending = withFileLock(lock, "old owner visible to new writer", async () => {
      entered = true;
    });
    await pause(100);
    expect(entered).toBe(false);
    rmSync(lock, { force: true });
    await pending;
    expect(entered).toBe(true);
  });

  it("a stale-broken Kanban holder releases only its own ticket generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "kanban-lock-generation-"));
    const lock = join(root, "card.lock");
    const tickets = `${lock}.tickets`;

    let signalOldEntered!: () => void;
    const oldEntered = new Promise<void>((resolveEntered) => { signalOldEntered = resolveEntered; });
    let releaseOld!: () => void;
    const holdOld = new Promise<void>((resolveHold) => { releaseOld = resolveHold; });
    const old = withFileLock(lock, "old generation", async () => {
      signalOldEntered();
      await holdOld;
    });
    await oldEntered;

    const [oldTicket] = ticketFiles(tickets);
    expect(oldTicket).toBeTruthy();
    // Simulate a stale-owner breaker retiring both records from the first
    // generation while its delayed finally is still capable of running.
    rmSync(oldTicket, { force: true });
    rmSync(lock, { force: true });

    let signalSuccessorEntered!: () => void;
    const successorEntered = new Promise<void>((resolveEntered) => { signalSuccessorEntered = resolveEntered; });
    let releaseSuccessor!: () => void;
    const holdSuccessor = new Promise<void>((resolveHold) => { releaseSuccessor = resolveHold; });
    const successor = withFileLock(lock, "successor generation", async () => {
      signalSuccessorEntered();
      await holdSuccessor;
    });
    await successorEntered;
    const [successorTicket] = ticketFiles(tickets);
    expect(successorTicket).toBeTruthy();
    expect(successorTicket).not.toBe(oldTicket);

    releaseOld();
    await old;
    expect(existsSync(successorTicket)).toBe(true);

    let thirdEntered = false;
    const third = withFileLock(lock, "third generation", async () => {
      thirdEntered = true;
    });
    await pause(100);
    expect(thirdEntered).toBe(false);

    releaseSuccessor();
    await successor;
    await third;
    expect(thirdEntered).toBe(true);
  });

});

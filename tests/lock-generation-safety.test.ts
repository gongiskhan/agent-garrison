// Adversarial ownership-generation coverage for the two filesystem lock
// substrates used by Kanban lifecycle CAS and the coordination intent ledger.
// A holder's ticket is removed underneath it to simulate a stale-owner break;
// after a successor acquires, the old holder's finally must not remove that
// successor and admit a third critical section.
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// @ts-ignore — pure .mjs
import { withFileLock } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { withLedgerLock } from "../fittings/seed/coord-mcp/scripts/lib/intent-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INTENT_STORE = resolve(HERE, "..", "fittings", "seed", "coord-mcp", "scripts", "lib", "intent-store.mjs");
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

  it("makes a new coord-mcp ticket visible to a legacy ledger writer", () => {
    const root = mkdtempSync(join(tmpdir(), "intent-lock-legacy-bridge-"));
    const ledger = join(root, "repo.jsonl");

    withLedgerLock(ledger, () => {
      expect(readFileSync(`${ledger}.lock`, "utf8")).toMatch(new RegExp(`^${process.pid}:`));
      try {
        writeFileSync(`${ledger}.lock`, "999999", { flag: "wx" });
        throw new Error("legacy ledger writer unexpectedly acquired the bridge");
      } catch (error: any) {
        expect(error.code).toBe("EEXIST");
      }
    });
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

  it("a stale-broken ledger holder cannot unlink its successor across processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-lock-generation-"));
    const ledger = join(root, "repo.jsonl");
    const ticketDir = `${ledger}.lock.tickets`;
    const worker = join(root, "ledger-holder.mjs");
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(
      worker,
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        "const [moduleUrl, ledger, entered, release] = process.argv.slice(2);",
        "const { withLedgerLock } = await import(moduleUrl);",
        "const wait = new Int32Array(new SharedArrayBuffer(4));",
        "withLedgerLock(ledger, () => {",
        '  writeFileSync(entered, "entered");',
        "  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 10);",
        "});"
      ].join("\n"),
      "utf8"
    );
    const moduleUrl = pathToFileURL(INTENT_STORE).href;
    const children: ChildProcess[] = [];
    const holder = (name: string) => {
      const entered = join(root, `${name}.entered`);
      const release = join(root, `${name}.release`);
      const child = spawn(process.execPath, [worker, moduleUrl, ledger, entered, release], {
        stdio: ["ignore", "ignore", "ignore"]
      });
      children.push(child);
      return { child, entered, release };
    };

    const old = holder("old");
    try {
      await waitForFile(old.entered, old.child);
      const [oldTicket] = ticketFiles(ticketDir);
      expect(oldTicket).toBeTruthy();
      rmSync(oldTicket, { force: true });
      rmSync(`${ledger}.lock`, { force: true });

      const successor = holder("successor");
      await waitForFile(successor.entered, successor.child);
      const [successorTicket] = ticketFiles(ticketDir);
      expect(successorTicket).toBeTruthy();
      expect(successorTicket).not.toBe(oldTicket);

      writeFileSync(old.release, "release");
      await expectCleanExit(old.child);
      expect(existsSync(successorTicket)).toBe(true);

      const third = holder("third");
      await pause(150);
      expect(existsSync(third.entered)).toBe(false);

      writeFileSync(successor.release, "release");
      await expectCleanExit(successor.child);
      await waitForFile(third.entered, third.child);
      writeFileSync(third.release, "release");
      await expectCleanExit(third.child);
    } finally {
      // Never leave a blocking worker behind if an assertion fails midway.
      for (const name of ["old", "successor", "third"]) writeFileSync(join(root, `${name}.release`), "release");
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGTERM");
      }
    }
  }, 15_000);
});

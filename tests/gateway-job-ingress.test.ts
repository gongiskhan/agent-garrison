import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-ignore — pure .mjs gateway seam
import {
  createJobIngressGuard,
  forwardClaimWithRetry,
  isPendingJobClaim,
  jobDescription,
  jobKey,
  prepareClaimForAcknowledgement,
  validateJobPayload
  // @ts-ignore — pure .mjs gateway seam
} from "../fittings/seed/http-gateway/scripts/lib/job-ingress.mjs";

const roots: string[] = [];
const children: ChildProcess[] = [];
const repoRoot = path.resolve(__dirname, "..");
const gatewayScriptsDir = path.join(repoRoot, "fittings", "seed", "http-gateway", "scripts");
const claimFixture = path.join(repoRoot, "tests", "fixtures", "job-ingress-claim.mjs");

const makeCardsDir = () => {
  const root = mkdtempSync(path.join(tmpdir(), "garrison-job-ingress-"));
  roots.push(root);
  const cardsDir = path.join(root, "cards");
  mkdirSync(cardsDir, { recursive: true });
  return cardsDir;
};

function writeCard(
  cardsDir: string,
  id: string,
  body: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  const dir = path.join(cardsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "card.json"),
    JSON.stringify({
      id,
      title: `Heartbeat job: ${body.kind}`,
      description: jobDescription(body),
      origin: "orchestrator",
      list: "plan",
      status: "ok",
      created: "2026-08-03T10:00:00.000Z",
      ...overrides
    })
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
}

async function claimFromChild(cardsDir: string, kind: string, maxPending: number) {
  const modulePath = path.join(gatewayScriptsDir, "lib", "job-ingress.mjs");
  const child = spawn(process.execPath, [claimFixture, modulePath, cardsDir, kind, String(maxPending)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`job-ingress claim child timed out: ${stderr}`));
    }, 15_000);
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (settled || newline < 0) return;
      settled = true;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`job-ingress claim child exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function startGateway(mode: "pty" | "souls") {
  const home = mkdtempSync(path.join(tmpdir(), `garrison-job-${mode}-`));
  roots.push(home);
  // Exercise the supported board-root override. The ingress guard must resolve
  // the same cards directory as Kanban instead of assuming GARRISON_HOME.
  const kanbanRoot = path.join(home, "custom-kanban-root");
  const cardsDir = path.join(kanbanRoot, "cards");
  const compositionDir = path.join(home, "composition");
  mkdirSync(cardsDir, { recursive: true });
  mkdirSync(path.join(compositionDir, ".garrison"), { recursive: true });
  const port = await freePort();
  const script = path.join(gatewayScriptsDir, mode === "souls" ? "gateway.mjs" : "gateway-pty.mjs");
  let logs = "";
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      GARRISON_HOME: home,
      GARRISON_KANBAN_DIR: kanbanRoot,
      GARRISON_COMPOSITION_DIR: compositionDir,
      GARRISON_GATEWAY_HOST: "127.0.0.1",
      GARRISON_GATEWAY_PORT: String(port),
      GARRISON_JOB_DEDUPE_TTL_MS: String(3 * 60 * 60 * 1000),
      GARRISON_ROUTING: "0",
      // Never let this wiring test discover or start a real local runtime.
      GARRISON_CLAUDE_BINARY: "/definitely/missing/garrison-claude",
      GARRISON_SOULS_CONFIG: mode === "souls"
        ? JSON.stringify({ orchestratorFittingId: "orchestrator", orchestrator: null, souls: {} })
        : ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  child.stdout?.on("data", (chunk) => (logs += chunk.toString()));
  child.stderr?.on("data", (chunk) => (logs += chunk.toString()));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`${mode} gateway exited early (${child.exitCode}): ${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { baseUrl: `http://127.0.0.1:${port}`, cardsDir };
    } catch {
      // Listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${mode} gateway did not listen: ${logs}`);
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scheduled job ingress dedupe", () => {
  it("uses a stable key independent of object key order", () => {
    expect(jobKey({ kind: "heartbeat-tick", instructions: "x", nested: { b: 2, a: 1 } })).toBe(
      jobKey({ nested: { a: 1, b: 2 }, instructions: "x", kind: "heartbeat-tick" })
    );
  });

  it("rejects primitive/blank-kind payloads and hashes prototype-shaped keys as inert data", () => {
    expect(validateJobPayload(null)).toMatch(/JSON object/);
    expect(validateJobPayload([])).toMatch(/JSON object/);
    expect(validateJobPayload("tick")).toMatch(/JSON object/);
    expect(validateJobPayload({ kind: "   " })).toMatch(/non-empty/);

    const first = JSON.parse('{"kind":"heartbeat-tick","__proto__":{"polluted":"one"},"constructor":{"x":1}}');
    const second = JSON.parse('{"kind":"heartbeat-tick","__proto__":{"polluted":"two"},"constructor":{"x":1}}');
    expect(jobKey(first)).not.toBe(jobKey(second));
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });

  it("keeps active pre-dispatch duplicates on the retryable side of HTTP acknowledgement", () => {
    expect(isPendingJobClaim({ source: "in-flight" })).toBe(true);
    expect(isPendingJobClaim({ source: "receipt", receiptState: "active" })).toBe(true);
    expect(isPendingJobClaim({ source: "dispatching" })).toBe(true);
    expect(isPendingJobClaim({ source: "receipt", receiptState: "dispatching" })).toBe(true);
    expect(isPendingJobClaim({ source: "retained" })).toBe(false);
  });

  it("suppresses an identical in-flight job, then allows it after release", async () => {
    const cardsDir = makeCardsDir();
    const guard = createJobIngressGuard({ cardsDir, now: () => Date.parse("2026-08-03T10:30:00Z") });
    const body = { kind: "heartbeat-tick", instructions: "suggest" };

    const first = await guard.claim(body);
    expect(first.accepted).toBe(true);
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: false, source: "in-flight" });

    await guard.release(first.key, first.token);
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: true });
  });

  it("atomically admits only one of two concurrent claims", async () => {
    const cardsDir = makeCardsDir();
    const guard = createJobIngressGuard({ cardsDir, now: () => Date.parse("2026-08-03T10:30:00Z") });
    const body = { kind: "heartbeat-tick", instructions: "suggest" };

    const claims = await Promise.all([guard.claim(body), guard.claim(body)]);
    expect(claims.filter((claim: { accepted: boolean }) => claim.accepted)).toHaveLength(1);
    expect(claims.filter((claim: { accepted: boolean }) => !claim.accepted)).toEqual([
      expect.objectContaining({ accepted: false, source: "in-flight" })
    ]);
  });

  it("suppresses a matching active Kanban card but not terminal or parked cards", async () => {
    const cardsDir = makeCardsDir();
    const body = { kind: "heartbeat-tick", instructions: "suggest" };
    writeCard(cardsDir, "01ACTIVE", body);
    const guard = createJobIngressGuard({
      cardsDir,
      ttlMs: 3 * 60 * 60 * 1000,
      now: () => Date.parse("2026-08-03T11:00:00Z")
    });

    await expect(guard.claim(body)).resolves.toMatchObject({
      accepted: false,
      source: "kanban",
      cardId: "01ACTIVE"
    });

    writeCard(cardsDir, "01ACTIVE", body, { list: "needs-attention", status: "needs-attention" });
    const parkedRetry = await guard.claim(body);
    expect(parkedRetry.accepted).toBe(true);
    await guard.release(parkedRetry.key, parkedRetry.token);

    writeCard(cardsDir, "01ACTIVE", body, { list: "done" });
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: true });
  });

  it("allows retry after the bounded TTL and allows a distinct payload immediately", async () => {
    const cardsDir = makeCardsDir();
    const oldBody = { kind: "heartbeat-tick", instructions: "old" };
    writeCard(cardsDir, "01OLD", oldBody, { created: "2026-08-03T08:00:00.000Z" });
    const guard = createJobIngressGuard({
      cardsDir,
      ttlMs: 60 * 60 * 1000,
      now: () => Date.parse("2026-08-03T10:00:00Z")
    });

    const retry = await guard.claim(oldBody);
    expect(retry.accepted).toBe(true);
    await guard.release(retry.key, retry.token);
    await expect(guard.claim({ kind: "heartbeat-tick", instructions: "changed" })).resolves.toMatchObject({
      accepted: true
    });
  });

  it("uses the newest valid created/updated timestamp and fails open when neither is valid", async () => {
    const cardsDir = makeCardsDir();
    const body = { kind: "heartbeat-tick", instructions: "timestamp-check" };
    const guard = createJobIngressGuard({
      cardsDir,
      ttlMs: 60 * 60 * 1000,
      now: () => Date.parse("2026-08-03T10:00:00Z")
    });

    // The creation time is expired, but a valid recent update is positive
    // evidence that the matching job is still inside the dedupe window.
    writeCard(cardsDir, "01TIMED", body, {
      created: "2026-08-03T07:00:00.000Z",
      updated: "2026-08-03T09:30:00.000Z"
    });
    await expect(guard.claim(body)).resolves.toMatchObject({
      accepted: false,
      source: "kanban",
      cardId: "01TIMED"
    });

    // One malformed timestamp does not hide the other valid one.
    writeCard(cardsDir, "01TIMED", body, {
      created: "not-a-date",
      updated: "2026-08-03T09:30:00.000Z"
    });
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: false, source: "kanban" });

    writeCard(cardsDir, "01TIMED", body, {
      created: "2026-08-03T09:30:00.000Z",
      updated: "not-a-date"
    });
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: false, source: "kanban" });

    // With neither field usable, the card is not positive dedupe evidence.
    writeCard(cardsDir, "01TIMED", body, { created: "not-a-date", updated: "also-not-a-date" });
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: true, source: "new" });
  });

  it("does not let a far-future card timestamp suppress retries indefinitely", async () => {
    const cardsDir = makeCardsDir();
    const body = { kind: "heartbeat-tick", instructions: "future-timestamp" };
    writeCard(cardsDir, "01FUTURE", body, {
      created: "2026-08-03T07:00:00.000Z",
      updated: "2099-01-01T00:00:00.000Z"
    });
    const guard = createJobIngressGuard({
      cardsDir,
      ttlMs: 60 * 60 * 1000,
      now: () => Date.parse("2026-08-03T10:00:00Z")
    });

    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: true, source: "new" });
  });

  it("never expires an unsettled claim, but bounds the post-forward retention window", async () => {
    const cardsDir = makeCardsDir();
    let clock = 0;
    const body = { kind: "heartbeat-tick", instructions: "generation-race" };
    const guard = createJobIngressGuard({ cardsDir, ttlMs: 10, now: () => clock });

    const activeClaim = await guard.claim(body);
    clock = 11;
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: false, source: "in-flight" });

    expect(await guard.beginDispatch(activeClaim.key, activeClaim.token)).toBe(true);
    expect(await guard.retain(activeClaim.key, activeClaim.token)).toBe(true);
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: false, source: "retained" });

    clock = 22;
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: true, source: "new" });
  });

  it("treats a dead dispatch owner as uncertain instead of replaying its turn", async () => {
    const cardsDir = makeCardsDir();
    let clock = 0;
    const body = { kind: "morning-briefing", date: "2026-08-03" };
    const guard = createJobIngressGuard({ cardsDir, ttlMs: 100, now: () => clock });
    const claim = await guard.claim(body);
    expect(await guard.beginDispatch(claim.key, claim.token)).toBe(true);

    const receiptDir = path.join(path.dirname(cardsDir), "job-ingress");
    const receiptFile = path.join(
      receiptDir,
      readdirSync(receiptDir).find((name) => name.endsWith(".json"))!
    );
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    writeFileSync(receiptFile, JSON.stringify({
      ...receipt,
      ownerPid: 2147483647,
      ownerStartId: null,
      state: "dispatching",
      dispatchedAt: 0
    }));

    const restarted = createJobIngressGuard({ cardsDir, ttlMs: 100, now: () => clock });
    const uncertain = await restarted.claim(body);
    expect(uncertain).toMatchObject({
      accepted: false,
      source: "receipt",
      receiptState: "dispatching"
    });
    expect(isPendingJobClaim(uncertain)).toBe(true);

    clock = 101;
    await expect(restarted.claim(body)).resolves.toMatchObject({ accepted: true, source: "new" });
  });

  it("fails closed with retryable storage backpressure when the board cannot be scanned", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "garrison-job-store-error-"));
    roots.push(root);
    const notADirectory = path.join(root, "cards");
    writeFileSync(notADirectory, "not a directory", "utf8");
    const guard = createJobIngressGuard({ cardsDir: notADirectory });

    await expect(guard.claim({ kind: "heartbeat-tick" })).resolves.toMatchObject({
      accepted: false,
      source: "storage-error",
      error: expect.stringContaining("unavailable")
    });

    const missingGuard = createJobIngressGuard({ cardsDir: path.join(root, "missing-cards") });
    await expect(missingGuard.claim({ kind: "heartbeat-tick" })).resolves.toMatchObject({
      accepted: false,
      source: "storage-error"
    });
  });

  it("retries forwarding while retaining ownership, then retains the successful generation", async () => {
    const cardsDir = makeCardsDir();
    let clock = 0;
    let attempts = 0;
    const body = { kind: "heartbeat-tick", instructions: "retry" };
    const guard = createJobIngressGuard({ cardsDir, ttlMs: 100, now: () => clock });
    const claim = await guard.claim(body);

    await forwardClaimWithRetry({
      guard,
      claim,
      sleep: async () => {
        clock += 1;
        await expect(guard.claim(body)).resolves.toMatchObject({
          accepted: false,
          source: "dispatching"
        });
      },
      forward: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`temporary ${attempts}`);
        return "ok";
      }
    });

    expect(attempts).toBe(3);
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: false, source: "retained" });
    // A fresh guard (the gateway process' in-memory map is gone) still sees the
    // atomically persisted job key and suppresses the replay.
    const afterRestart = createJobIngressGuard({ cardsDir, ttlMs: 100, now: () => clock });
    await expect(afterRestart.claim(body)).resolves.toMatchObject({
      accepted: false,
      source: "receipt",
      receiptState: "retained"
    });
  });

  it("releases a claim after the bounded forwarding retries are exhausted", async () => {
    const cardsDir = makeCardsDir();
    const body = { kind: "heartbeat-tick", instructions: "retry-exhausted" };
    const guard = createJobIngressGuard({ cardsDir });
    const claim = await guard.claim(body);

    await expect(forwardClaimWithRetry({
      guard,
      claim,
      attempts: 2,
      sleep: async () => {},
      forward: async () => { throw new Error("still down"); }
    })).rejects.toThrow("still down");
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: true, source: "new" });
  });

  it("never replays a turn whose admitted completion later fails", async () => {
    const cardsDir = makeCardsDir();
    const body = { kind: "heartbeat-tick", instructions: "side-effect-boundary" };
    const guard = createJobIngressGuard({ cardsDir });
    const claim = await guard.claim(body);
    let dispatches = 0;

    await expect(forwardClaimWithRetry({
      guard,
      claim,
      attempts: 3,
      forward: async () => {
        dispatches += 1;
        return { completion: Promise.reject(new Error("failed after admission")) };
      }
    })).rejects.toThrow("failed after admission");

    expect(dispatches).toBe(1);
    await expect(guard.claim(body)).resolves.toMatchObject({
      accepted: false,
      source: "retained"
    });
  });

  it("signals queue admission before awaiting the admitted turn's completion", async () => {
    const cardsDir = makeCardsDir();
    const body = { kind: "heartbeat-tick", instructions: "admission-boundary" };
    const guard = createJobIngressGuard({ cardsDir });
    const claim = await guard.claim(body);
    let resolveCompletion!: (value: string) => void;
    const completion = new Promise<string>((resolve) => { resolveCompletion = resolve; });
    let admissions = 0;

    const forwarding = forwardClaimWithRetry({
      guard,
      claim,
      forward: async () => ({ completion }),
      onAdmitted: () => { admissions += 1; }
    });
    const admissionDeadline = Date.now() + 2_000;
    while (admissions === 0 && Date.now() < admissionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(admissions).toBe(1);
    const duplicate = await guard.claim(body);
    expect(duplicate).toMatchObject({ accepted: false, source: "dispatching" });
    expect(isPendingJobClaim(duplicate)).toBe(true);

    resolveCompletion("ok");
    await expect(forwarding).resolves.toBe("ok");
  });

  it("applies bounded backpressure without evicting active claims", async () => {
    const cardsDir = makeCardsDir();
    const guard = createJobIngressGuard({ cardsDir, maxPending: 2 });
    const first = await guard.claim({ kind: "one" });
    const second = await guard.claim({ kind: "two" });

    await expect(guard.claim({ kind: "three" })).resolves.toMatchObject({
      accepted: false,
      source: "backpressure"
    });
    await guard.release(first.key, first.token);
    await expect(guard.claim({ kind: "three" })).resolves.toMatchObject({ accepted: true, source: "new" });
    await guard.release(second.key, second.token);
  });

  it("reserves capacity atomically across concurrent distinct jobs", async () => {
    const cardsDir = makeCardsDir();
    const guard = createJobIngressGuard({ cardsDir, maxPending: 2 });
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) => guard.claim({ kind: `distinct-${index}` }))
    );
    expect(claims.filter((claim: { accepted: boolean }) => claim.accepted)).toHaveLength(2);
    expect(claims.filter((claim: { source?: string }) => claim.source === "backpressure")).toHaveLength(6);
  });

  it("reserves capacity across independent gateway guards sharing receipt storage", async () => {
    const cardsDir = makeCardsDir();
    const guards = Array.from({ length: 8 }, () => createJobIngressGuard({ cardsDir, maxPending: 2 }));
    const claims = await Promise.all(
      guards.map((guard, index) => guard.claim({ kind: `cross-process-${index}` }))
    );
    expect(claims.filter((claim: { accepted: boolean }) => claim.accepted)).toHaveLength(2);
    expect(claims.filter((claim: { source?: string }) => claim.source === "backpressure")).toHaveLength(6);
  });

  it("reserves capacity across overlapping gateway processes", async () => {
    const cardsDir = makeCardsDir();
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        claimFromChild(cardsDir, `multiprocess-${index}`, 2)
      )
    );
    expect(claims.filter((claim) => claim.accepted === true)).toHaveLength(2);
    expect(claims.filter((claim) => claim.source === "backpressure")).toHaveLength(6);
  }, 30_000);

  it("repairs an exact live lock ticket without turning an admitted claim into a storage failure", async () => {
    const cardsDir = makeCardsDir();
    let injected = 0;
    const guard = createJobIngressGuard({
      cardsDir,
      _testHooks: {
        releaseClaimLockTicket: async () => {
          injected += 1;
          throw new Error("injected lock-ticket release failure");
        }
      }
    });
    const first = await guard.claim({ kind: "lock-release-repair" });
    expect(injected).toBe(1);
    expect(first).toMatchObject({ accepted: true, source: "new" });
    await guard.release(first.key, first.token);

    const restarted = createJobIngressGuard({ cardsDir });
    await expect(restarted.claim({ kind: "after-lock-release-repair" })).resolves.toMatchObject({
      accepted: true,
      source: "new"
    });
  });

  it("repairs a transient exact-token release failure and restores same-key and capacity progress", async () => {
    const cardsDir = makeCardsDir();
    let removeAttempts = 0;
    const guard = createJobIngressGuard({
      cardsDir,
      maxPending: 1,
      _testHooks: {
        beforeRemoveReceipt: async () => {
          removeAttempts += 1;
          if (removeAttempts === 1) throw new Error("injected receipt release failure");
        }
      }
    });
    const body = { kind: "transient-release-repair" };
    const first = await guard.claim(body);
    expect(await guard.release(first.key, first.token)).toBe(false);
    await expect(guard.claim(body)).resolves.toMatchObject({ accepted: false, source: "in-flight" });
    // This guard knows the exact token was never admitted and is being
    // released, so it must not charge the stale durable receipt as capacity.
    const distinct = await guard.claim({ kind: "capacity-during-release-repair" });
    expect(distinct).toMatchObject({ accepted: true, source: "new" });
    await guard.release(distinct.key, distinct.token);

    const deadline = Date.now() + 5_000;
    let sameKey;
    while (Date.now() < deadline) {
      sameKey = await guard.claim(body);
      if (sameKey.accepted) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(removeAttempts).toBeGreaterThanOrEqual(2);
    expect(sameKey).toMatchObject({ accepted: true, source: "new" });
    await guard.release(sameKey.key, sameKey.token);
    await expect(guard.claim({ kind: "capacity-after-release-repair" })).resolves.toMatchObject({
      accepted: true,
      source: "new"
    });
  });

  it("does not charge completed retained receipts against active capacity", async () => {
    const cardsDir = makeCardsDir();
    const guard = createJobIngressGuard({ cardsDir, maxPending: 1 });
    const completed = await guard.claim({ kind: "completed" });
    expect(await guard.beginDispatch(completed.key, completed.token)).toBe(true);
    expect(await guard.retain(completed.key, completed.token)).toBe(true);

    await expect(guard.claim({ kind: "next-distinct" })).resolves.toMatchObject({
      accepted: true,
      source: "new"
    });
  });

  it("does not leak capacity when durable retention is temporarily unavailable", async () => {
    const cardsDir = makeCardsDir();
    const guard = createJobIngressGuard({ cardsDir, maxPending: 1 });
    const overlappingGuard = createJobIngressGuard({ cardsDir, maxPending: 1 });
    const completed = await guard.claim({ kind: "retention-write-failure" });
    expect(await guard.beginDispatch(completed.key, completed.token)).toBe(true);

    const receiptDir = path.join(path.dirname(cardsDir), "job-ingress");
    const savedReceiptDir = `${receiptDir}.saved`;
    renameSync(receiptDir, savedReceiptDir);
    writeFileSync(receiptDir, "temporarily unavailable", "utf8");
    await expect(guard.retain(completed.key, completed.token)).rejects.toThrow(/unreadable|ENOTDIR/);
    rmSync(receiptDir, { force: true });
    renameSync(savedReceiptDir, receiptDir);

    let nextClaim: Record<string, unknown> | undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      nextClaim = await overlappingGuard.claim({ kind: "next-after-retention-failure" });
      if (!nextClaim) throw new Error("job ingress returned no claim result");
      if (nextClaim.accepted) break;
      expect(nextClaim.source).toBe("backpressure");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(nextClaim).toMatchObject({ accepted: true, source: "new" });
    await expect(guard.claim({ kind: "retention-write-failure" })).resolves.toMatchObject({
      accepted: false,
      source: "retained"
    });
  });

  it("releases an unacknowledged claim when the dispatch fence cannot be published", async () => {
    let released = false;
    const claim = { key: "heartbeat-tick:key", token: "generation" };
    await expect(prepareClaimForAcknowledgement({
      claim,
      guard: {
        beginDispatch: async () => { throw new Error("receipt fsync failed"); },
        release: async (key: string, token: string) => {
          expect({ key, token }).toEqual(claim);
          released = true;
          return true;
        }
      }
    })).rejects.toThrow("receipt fsync failed");
    expect(released).toBe(true);
  });

  it("keeps fixed-cadence morning briefings independent by payload date", async () => {
    const cardsDir = makeCardsDir();
    writeCard(cardsDir, "01MONDAY", { kind: "morning-briefing", date: "2026-08-03" });
    const guard = createJobIngressGuard({
      cardsDir,
      now: () => Date.parse("2026-08-03T11:00:00Z")
    });

    await expect(guard.claim({ kind: "morning-briefing", date: "2026-08-03" })).resolves.toMatchObject({
      accepted: false,
      source: "kanban"
    });
    await expect(guard.claim({ kind: "morning-briefing", date: "2026-08-04" })).resolves.toMatchObject({
      accepted: true
    });
  });
});

describe.each(["pty", "souls"] as const)("%s gateway scheduled-job HTTP ingress", (mode) => {
  it("persists an accepted job key before acknowledging and keeps replay retryable until retained", async () => {
    const { baseUrl, cardsDir } = await startGateway(mode);
    const body = { kind: "heartbeat-tick", instructions: `durable-${mode}` };
    const post = () => fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    const accepted = await post();
    if (mode === "souls") {
      // This fixture deliberately provides no operative binary. A durable
      // reservation is not enough to acknowledge the producer: queue admission
      // fails, the exact generation is released, and the producer receives a
      // retryable response instead of a false 202.
      expect(accepted.status).toBe(503);
      await expect(accepted.json()).resolves.toMatchObject({ ack: false, retryable: true });
      const receiptDir = path.join(path.dirname(cardsDir), "job-ingress");
      expect(readdirSync(receiptDir).filter((name) => name.endsWith(".json"))).toHaveLength(0);
      return;
    }
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({ ack: true, deduped: false });

    const receiptDir = path.join(path.dirname(cardsDir), "job-ingress");
    expect(existsSync(receiptDir)).toBe(true);
    const receipts = readdirSync(receiptDir).filter((name) => name.endsWith(".json"));
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(path.join(receiptDir, receipts[0]), "utf8"));
    expect(receipt.key).toBe(jobKey(body));
    expect(["dispatching", "retained"]).toContain(receipt.state);

    let replay = await post();
    if (replay.status === 503) {
      await expect(replay.json()).resolves.toMatchObject({ ack: false, retryable: true });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        replay = await post();
        if (replay.status === 202) break;
        expect(replay.status).toBe(503);
        await expect(replay.json()).resolves.toMatchObject({ ack: false, retryable: true });
      }
    }
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({ ack: true, deduped: true });
  }, 30_000);

  it("rejects malformed jobs and returns retryable backpressure when card storage is unreadable", async () => {
    const { baseUrl, cardsDir } = await startGateway(mode);
    for (const body of ["primitive", { kind: "   " }]) {
      const response = await fetch(`${baseUrl}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ack: false, retryable: false });
    }

    rmSync(cardsDir, { recursive: true, force: true });
    writeFileSync(cardsDir, "not a directory", "utf8");
    const unavailable = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "heartbeat-tick", instructions: "storage-failure" })
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({ ack: false, retryable: true });
  }, 30_000);

  it("concurrently suppresses replayed jobs against the same active Kanban card", async () => {
    const { baseUrl, cardsDir } = await startGateway(mode);
    const body = { kind: "heartbeat-tick", instructions: `real-${mode}-handler` };
    writeCard(cardsDir, `01${mode.toUpperCase()}JOB`, body, {
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    });

    const postJob = () => fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const responses = await Promise.all([postJob(), postJob()]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    const payloads = await Promise.all(responses.map((response) => response.json()));
    expect(payloads).toEqual([
      expect.objectContaining({ ack: true, deduped: true, card: `01${mode.toUpperCase()}JOB` }),
      expect.objectContaining({ ack: true, deduped: true, card: `01${mode.toUpperCase()}JOB` })
    ]);
  }, 30_000);
});

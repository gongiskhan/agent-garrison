// Durable ingress dedupe for scheduled /jobs turns.
//
// The gateway durably fences a job as dispatching before acknowledging it, then
// keeps that generation until the standing operative has admitted and completed
// the turn. Active forwarding claims never age out underneath a long turn.
// Successfully forwarded claims are retained for a bounded TTL; the Kanban scan
// remains as backward-compatible dedupe evidence for cards created by older
// gateways, without making cards part of the scheduled-job contract.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_JOB_DEDUPE_TTL_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_JOB_MAX_PENDING = 256;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const CLAIM_LOCK_TIMEOUT_MS = 10_000;
const INVALID_LOCK_TICKET_STALE_MS = 60_000;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    // JSON permits keys such as "__proto__" and "constructor". A normal object
    // would invoke Object.prototype's setter and silently change the value being
    // hashed. A null-prototype object treats every input key as inert data.
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  return value;
}

export function validateJobPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "job body must be a JSON object";
  }
  if (typeof body.kind !== "string" || !body.kind.trim()) {
    return "job kind must be a non-empty string";
  }
  return null;
}

export function isPendingJobClaim(claim) {
  return (
    claim?.source === "in-flight" ||
    claim?.source === "dispatching" ||
    claim?.receiptState === "active" ||
    claim?.receiptState === "dispatching"
  );
}

export function canonicalJobPayload(body) {
  const error = validateJobPayload(body);
  if (error) throw new TypeError(error);
  return JSON.stringify(canonicalValue(body));
}

export function jobKey(body) {
  const error = validateJobPayload(body);
  if (error) throw new TypeError(error);
  const kind = body.kind.trim();
  const digest = createHash("sha256").update(canonicalJobPayload(body)).digest("hex");
  return `${kind}:${digest}`;
}

export function jobDescription(body) {
  const key = jobKey(body);
  const description = `Heartbeat job: ${body.kind.trim()}`;
  return `${description}\nJob-Key: ${key}\n\nPayload:\n${JSON.stringify(body)}`;
}

function bodyFromCard(card) {
  if (!card || typeof card !== "object") return null;
  if (card.jobKey && typeof card.jobKey === "string") return { key: card.jobKey };
  if (
    typeof card.title !== "string" ||
    (!card.title.startsWith("Heartbeat job:") && card.title !== "Heartbeat tick")
  ) {
    return null;
  }
  const description = typeof card.description === "string" ? card.description : "";
  const marker = "\n\nPayload:\n";
  const at = description.indexOf(marker);
  if (at < 0) return null;
  try {
    return { key: jobKey(JSON.parse(description.slice(at + marker.length))) };
  } catch {
    return null;
  }
}

function isActiveJobCard(card, nowMs, ttlMs) {
  if (!card || card.abandoned) return false;
  if (
    card.list === "done" ||
    card.list === "archived" ||
    card.list === "needs-attention" ||
    card.status === "needs-attention"
  ) {
    return false;
  }
  // A card can sit in one lane for a long time while its run is still making
  // progress. Treat the newest *valid* storage timestamp as its activity time:
  // an old `created` must not hide a recent `updated`, and one malformed field
  // must not discard the other. With no trustworthy timestamp there is no
  // positive evidence that the card is inside the dedupe window, so fail open
  // and allow the scheduler to retry.
  const activityTimes = [card.created, card.updated]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value) && value <= nowMs + MAX_CLOCK_SKEW_MS)
    .map((value) => Math.min(value, nowMs));
  if (activityTimes.length === 0) return false;
  const activityMs = Math.max(...activityTimes);
  return nowMs - activityMs < ttlMs;
}

export async function findQueuedJob({ key, cardsDir, nowMs = Date.now(), ttlMs = DEFAULT_JOB_DEDUPE_TTL_MS }) {
  let entries;
  try {
    entries = await fs.readdir(cardsDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Kanban job storage is unavailable: ${error?.message || error}`, { cause: error });
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const card = JSON.parse(await fs.readFile(path.join(cardsDir, entry.name, "card.json"), "utf8"));
      if (!isActiveJobCard(card, nowMs, ttlMs)) continue;
      if (bodyFromCard(card)?.key !== key) continue;
      return { cardId: card.id ?? entry.name, created: card.created ?? null };
    } catch (error) {
      // A transient or corrupt board read is uncertainty, not proof that no
      // duplicate exists. Return retryable backpressure instead of creating a
      // second Personal Assistant turn.
      throw new Error(
        `Kanban card ${entry.name} could not be checked for job dedupe: ${error?.message || error}`,
        { cause: error }
      );
    }
  }
  return null;
}

export function createJobIngressGuard({
  cardsDir = path.join(
    process.env.GARRISON_KANBAN_DIR?.trim() ||
      path.join(process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison"), "kanban-loop"),
    "cards"
  ),
  receiptsDir,
  ttlMs = Number(process.env.GARRISON_JOB_DEDUPE_TTL_MS) || DEFAULT_JOB_DEDUPE_TTL_MS,
  maxPending = Number(process.env.GARRISON_JOB_DEDUPE_MAX_PENDING) || DEFAULT_JOB_MAX_PENDING,
  now = () => Date.now(),
  _testHooks = null
} = {}) {
  const pending = new Map();
  const retentionRepairTimers = new Map();
  const releaseRepairTimers = new Map();
  const lockCleanupRepairTimers = new Map();
  const guardToken = randomBytes(12).toString("hex");
  let claimTail = Promise.resolve();
  const durableReceiptsDir = receiptsDir || path.join(path.dirname(cardsDir), "job-ingress");
  const configuredTtl = Number(ttlMs);
  const effectiveTtlMs = Number.isFinite(configuredTtl) && configuredTtl > 0
    ? configuredTtl
    : DEFAULT_JOB_DEDUPE_TTL_MS;
  const configuredMaxPending = Number(maxPending);
  const effectiveMaxPending = Number.isFinite(configuredMaxPending) && configuredMaxPending > 0
    ? Math.floor(configuredMaxPending)
    : DEFAULT_JOB_MAX_PENDING;

  async function purgeSettled(nowMs) {
    for (const [key, claim] of pending) {
      const settledAt = claim.state === "retained"
        ? claim.retainedAt
        : claim.state === "settled"
          ? claim.settledAt
          : null;
      if (!Number.isFinite(settledAt) || nowMs - settledAt < effectiveTtlMs) continue;
      if (claim.state === "settled") {
        // Durable retention failed after an admitted turn. Keep suppressing the
        // generation, but do not charge it as active work. At the normal TTL,
        // retire only the same token; a storage failure remains fail-closed.
        try {
          if (await removeReceipt(key, claim.token)) {
            pending.delete(key);
            cancelRetentionRepair(key);
          }
        } catch {
          // A later claim will retry this exact generation's cleanup.
        }
      } else {
        pending.delete(key);
        cancelRetentionRepair(key);
      }
    }
  }

  function pendingSource(claim) {
    if (claim?.state === "retained" || claim?.state === "settled") return "retained";
    if (claim?.state === "dispatching") return "dispatching";
    return "in-flight";
  }

  function cancelRetentionRepair(key) {
    const timer = retentionRepairTimers.get(key);
    if (timer) clearTimeout(timer);
    retentionRepairTimers.delete(key);
  }

  function cancelReleaseRepair(key) {
    const timer = releaseRepairTimers.get(key);
    if (timer) clearTimeout(timer);
    releaseRepairTimers.delete(key);
  }

  function scheduleReleaseRepair(key, token, attempt = 0) {
    if (releaseRepairTimers.has(key)) return;
    const claim = pending.get(key);
    if (claim?.token !== token || claim.state !== "releasing") return;
    const delayMs = Math.min(30_000, 250 * (2 ** Math.min(attempt, 7)));
    const timer = setTimeout(async () => {
      releaseRepairTimers.delete(key);
      try {
        await withClaimLock(async () => {
          const current = pending.get(key);
          if (current?.token !== token || current.state !== "releasing") return;
          // true means this generation is gone; false means a successor token
          // already owns the durable key. Either way this local generation must
          // stop suppressing work. Only storage uncertainty keeps it pending.
          await removeReceipt(key, token);
          pending.delete(key);
          cancelReleaseRepair(key);
        });
      } catch {
        // The exact token remains fail-closed while storage is unavailable.
      }
      if (pending.get(key)?.token === token && pending.get(key)?.state === "releasing") {
        scheduleReleaseRepair(key, token, attempt + 1);
      }
    }, delayMs);
    timer.unref?.();
    releaseRepairTimers.set(key, timer);
  }

  function scheduleRetentionRepair(key, token, attempt = 0) {
    if (retentionRepairTimers.has(key)) return;
    const claim = pending.get(key);
    if (claim?.token !== token || claim.state !== "settled") return;
    const delayMs = Math.min(30_000, 250 * (2 ** Math.min(attempt, 7)));
    const timer = setTimeout(async () => {
      retentionRepairTimers.delete(key);
      try {
        await withClaimLock(async () => {
          const current = pending.get(key);
          if (current?.token !== token || current.state !== "settled") return;
          const retained = await replaceReceipt(key, token, {
            state: "retained",
            retainedAt: current.settledAt
          });
          if (!retained) {
            // A different durable generation won. Drop only this guard's stale
            // in-memory evidence; never rewrite or remove the successor.
            pending.delete(key);
            return;
          }
          current.state = "retained";
          current.retainedAt = current.settledAt;
          delete current.settledAt;
        });
      } catch {
        // Storage is still unavailable. Keep the at-most-once generation and
        // retry the state repair without replaying its operative turn.
      }
      if (pending.get(key)?.token === token && pending.get(key)?.state === "settled") {
        scheduleRetentionRepair(key, token, attempt + 1);
      }
    }, delayMs);
    timer.unref?.();
    retentionRepairTimers.set(key, timer);
  }

  async function withClaimLock(operation) {
    const prior = claimTail;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    claimTail = prior.catch(() => undefined).then(() => gate);
    await prior.catch(() => undefined);
    try {
      return await withDurableClaimLock(operation);
    } finally {
      release();
    }
  }

  function activePendingCount() {
    let count = 0;
    for (const claim of pending.values()) {
      if (claim.state === "active" || claim.state === "dispatching") count += 1;
    }
    return count;
  }

  function observedNowMs() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  async function unlinkReceipt(file) {
    return unlinkDurable(file);
  }

  function receiptPath(key) {
    const digest = createHash("sha256").update(key).digest("hex");
    return path.join(durableReceiptsDir, `${digest}.json`);
  }

  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function processStartIdentity(pid) {
    if (process.platform !== "linux") return null;
    try {
      const [stat, bootId] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, "utf8"),
        fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")
      ]);
      const commEnd = stat.lastIndexOf(")");
      if (commEnd < 0) return null;
      const startTicks = stat.slice(commEnd + 1).trim().split(/\s+/)[19];
      return startTicks ? `${bootId.trim()}:${startTicks}` : null;
    } catch {
      return null;
    }
  }

  async function syncDirectory(directory) {
    let handle;
    try {
      handle = await fs.open(directory, "r");
      await handle.sync();
    } catch (error) {
      // Some non-Linux filesystems do not permit fsync on a directory. The
      // authoritative runtime is Linux, where a failure is material and must
      // keep the request on the retryable side of the acknowledgement boundary.
      if (process.platform === "linux" || !["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async function ensureDurableDirectory(directory) {
    const created = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!created) {
      await syncDirectory(directory);
      return;
    }
    const target = path.resolve(directory);
    let cursor = path.resolve(created);
    await syncDirectory(path.dirname(cursor));
    for (;;) {
      await syncDirectory(cursor);
      if (cursor === target) break;
      const nextSegment = path.relative(cursor, target).split(path.sep)[0];
      if (!nextSegment || nextSegment === "..") {
        throw new Error(`Could not durably create job-ingress directory ${directory}`);
      }
      cursor = path.join(cursor, nextSegment);
    }
  }

  async function writeDurableJson(file, value, { newFile = false } = {}) {
    const directory = path.dirname(file);
    await ensureDurableDirectory(directory);
    const tmp = `${file}.write-${process.pid}-${randomBytes(6).toString("hex")}`;
    const handle = await fs.open(tmp, "wx", 0o600);
    let closed = false;
    let renamed = false;
    try {
      await handle.writeFile(JSON.stringify(value), "utf8");
      await handle.sync();
      await handle.close();
      closed = true;
      await fs.rename(tmp, file);
      renamed = true;
      await syncDirectory(directory);
    } catch (error) {
      if (newFile && renamed) await unlinkDurable(file).catch(() => undefined);
      throw error;
    } finally {
      if (!closed) await handle.close().catch(() => undefined);
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  async function unlinkDurable(file) {
    try {
      await fs.unlink(file);
      await syncDirectory(path.dirname(file));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  function scheduleLockTicketCleanup(file, attempt = 0) {
    if (lockCleanupRepairTimers.has(file)) return;
    const delayMs = Math.min(30_000, 250 * (2 ** Math.min(attempt, 7)));
    const timer = setTimeout(async () => {
      lockCleanupRepairTimers.delete(file);
      try {
        // Every lock acquisition owns an unguessable pathname. Retrying this
        // exact unlink can never remove a successor generation.
        await unlinkDurable(file);
        return;
      } catch {
        scheduleLockTicketCleanup(file, attempt + 1);
      }
    }, delayMs);
    timer.unref?.();
    lockCleanupRepairTimers.set(file, timer);
  }

  function validClaimLockTicket(value, token) {
    return Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.version === 1 &&
      value.token === token &&
      Number.isInteger(value.ownerPid) &&
      value.ownerPid > 0 &&
      (value.ownerStartId === null || typeof value.ownerStartId === "string") &&
      typeof value.choosing === "boolean" &&
      Number.isSafeInteger(value.ticket) &&
      value.ticket >= 0 &&
      Number.isFinite(value.createdAt) &&
      (value.released === undefined || typeof value.released === "boolean")
    );
  }

  async function readClaimLockTickets(lockDir) {
    const names = await fs.readdir(lockDir);
    const currentTime = Date.now();
    const tickets = [];
    for (const name of names) {
      const match = name.match(/^[0-9]+-([a-f0-9]{24})\.json$/);
      if (!match) continue;
      const token = match[1];
      const file = path.join(lockDir, name);
      let value;
      try {
        value = JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        const stat = await fs.stat(file).catch(() => null);
        if (stat && currentTime - stat.mtimeMs >= INVALID_LOCK_TICKET_STALE_MS) {
          await unlinkDurable(file);
          continue;
        }
        tickets.push({ id: name, file, ticket: { token, choosing: true, ticket: 0 } });
        continue;
      }
      if (!validClaimLockTicket(value, token)) {
        const stat = await fs.stat(file).catch(() => null);
        if (stat && currentTime - stat.mtimeMs >= INVALID_LOCK_TICKET_STALE_MS) {
          await unlinkDurable(file);
          continue;
        }
        tickets.push({ id: name, file, ticket: { token, choosing: true, ticket: 0 } });
        continue;
      }
      if (value.released) {
        await unlinkDurable(file);
        continue;
      }
      const ownerAlive = pidAlive(value.ownerPid);
      const currentStartId = ownerAlive && value.ownerStartId
        ? await processStartIdentity(value.ownerPid)
        : null;
      if (!ownerAlive || (value.ownerStartId && currentStartId && currentStartId !== value.ownerStartId)) {
        // Every participant owns an unguessable pathname. Retiring this exact
        // dead/PID-reused generation cannot remove a successor's lock.
        await unlinkDurable(file);
        continue;
      }
      tickets.push({ id: name, file, ticket: value });
    }
    return tickets;
  }

  async function withDurableClaimLock(operation) {
    const lockDir = path.join(durableReceiptsDir, ".claim-locks");
    await ensureDurableDirectory(lockDir);
    const token = randomBytes(12).toString("hex");
    const id = `${process.pid}-${token}.json`;
    const file = path.join(lockDir, id);
    const ownerStartId = await processStartIdentity(process.pid);
    if (process.platform === "linux" && !ownerStartId) {
      throw new Error("Could not establish the gateway process identity for the job-ingress lock");
    }
    let ownTicket = {
      version: 1,
      ownerPid: process.pid,
      ownerStartId,
      token,
      choosing: true,
      ticket: 0,
      createdAt: Date.now()
    };

    let result;
    let operationError;
    try {
      // This pathname is unique to this generation. If publication reaches the
      // rename but its directory fsync fails, writeDurableJson removes exactly
      // this new file; the outer release path is a second cleanup fence.
      await writeDurableJson(file, ownTicket, { newFile: true });
      const initial = await readClaimLockTickets(lockDir);
      ownTicket = {
        ...ownTicket,
        choosing: false,
        ticket: initial.reduce((max, contender) => Math.max(max, contender.ticket.ticket || 0), 0) + 1
      };
      await writeDurableJson(file, ownTicket);

      const deadline = Date.now() + CLAIM_LOCK_TIMEOUT_MS;
      for (;;) {
        const contenders = await readClaimLockTickets(lockDir);
        const ownPresent = contenders.some((contender) => contender.id === id);
        if (!ownPresent) throw new Error("Job-ingress claim lock lost its ownership ticket");
        const blocked = contenders.some((contender) => {
          if (contender.id === id) return false;
          if (contender.ticket.choosing) return true;
          if (contender.ticket.ticket !== ownTicket.ticket) {
            return contender.ticket.ticket < ownTicket.ticket;
          }
          return contender.id.localeCompare(id) < 0;
        });
        if (!blocked) break;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for the job-ingress claim lock after ${CLAIM_LOCK_TIMEOUT_MS}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 20)));
      }
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    let releaseError;
    try {
      if (typeof _testHooks?.releaseClaimLockTicket === "function") {
        await _testHooks.releaseClaimLockTicket({ file, ticket: ownTicket });
      } else {
        let releasePublished = false;
        try {
          await writeDurableJson(file, { ...ownTicket, choosing: false, ticket: 0, released: true });
          releasePublished = true;
          // The durable released marker is authoritative; unlink is housekeeping.
          await unlinkDurable(file).catch(() => undefined);
        } catch (error) {
          if (!releasePublished) {
            try {
              await unlinkDurable(file);
            } catch {
              throw error;
            }
          }
        }
      }
    } catch (error) {
      releaseError = error;
    }
    if (releaseError) scheduleLockTicketCleanup(file);
    if (operationError) throw operationError;
    // The protected operation already completed. A still-visible exact ticket
    // blocks later entrants until the repair above removes it; turning success
    // into a retryable claim failure would instead leak its active receipt and
    // invite the producer to submit a second generation.
    return result;
  }

  async function receiptOwnerAlive(receipt) {
    const ownerPid = Number(receipt.ownerPid);
    if (!pidAlive(ownerPid)) return false;
    if (typeof receipt.ownerStartId !== "string") return true;
    const currentStartId = await processStartIdentity(ownerPid);
    return !currentStartId || currentStartId === receipt.ownerStartId;
  }

  function receiptTimestampFresh(receipt, field, nowMs) {
    const timestamp = Number(receipt[field]);
    if (!Number.isFinite(timestamp) || timestamp > nowMs + MAX_CLOCK_SKEW_MS) return false;
    return nowMs - Math.min(timestamp, nowMs) < effectiveTtlMs;
  }

  async function purgeReceipts(nowMs) {
    let names;
    try {
      names = await fs.readdir(durableReceiptsDir);
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
    let activeCount = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(durableReceiptsDir, name);
      let receipt;
      try {
        receipt = JSON.parse(await fs.readFile(file, "utf8"));
      } catch (error) {
        throw new Error(`Job receipt ${name} is unreadable: ${error?.message || error}`, { cause: error });
      }
      if (
        !receipt ||
        typeof receipt.key !== "string" ||
        typeof receipt.token !== "string" ||
        !["active", "dispatching", "retained"].includes(receipt.state)
      ) {
        throw new Error(`Job receipt ${name} is invalid`);
      }
      const ownerAlive = receipt.state === "retained" ? false : await receiptOwnerAlive(receipt);
      const expiredRetained =
        receipt.state === "retained" && !receiptTimestampFresh(receipt, "retainedAt", nowMs);
      const deadActive = receipt.state === "active" && !ownerAlive;
      const expiredDeadDispatch =
        receipt.state === "dispatching" &&
        !ownerAlive &&
        !receiptTimestampFresh(receipt, "dispatchedAt", nowMs);
      if (expiredRetained || deadActive || expiredDeadDispatch) {
        await unlinkReceipt(file);
      } else if (
        (receipt.state === "active" || (receipt.state === "dispatching" && ownerAlive)) &&
        !(
          pending.get(receipt.key)?.token === receipt.token &&
          ["releasing", "settled", "retained"].includes(pending.get(receipt.key)?.state)
        )
      ) {
        activeCount += 1;
      }
    }
    return activeCount;
  }

  async function readReceipt(key, nowMs) {
    const file = receiptPath(key);
    let receipt;
    try {
      receipt = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`Job receipt storage is unreadable: ${error?.message || error}`, { cause: error });
    }
    if (
      !receipt ||
      receipt.key !== key ||
      typeof receipt.token !== "string" ||
      !["active", "dispatching", "retained"].includes(receipt.state)
    ) {
      throw new Error(`Job receipt ${path.basename(file)} is invalid`);
    }
    if (receipt.state === "retained") {
      if (receiptTimestampFresh(receipt, "retainedAt", nowMs)) return receipt;
      await unlinkReceipt(file);
      return null;
    }
    const ownerAlive = await receiptOwnerAlive(receipt);
    if (ownerAlive) return receipt;
    if (
      receipt.state === "dispatching" &&
      receiptTimestampFresh(receipt, "dispatchedAt", nowMs)
    ) {
      // The old process may have handed the turn to the operative before it
      // died. Keep the uncertain generation for one dedupe window; retrying it
      // would be at-least-once and could repeat Slack/Trello side effects.
      return receipt;
    }
    // A process crash leaves a complete, atomically-published active receipt.
    // A later gateway may reclaim it; unlike a live claim, dead ownership never
    // suppresses the schedule indefinitely.
    await unlinkReceipt(file);
    return null;
  }

  async function publishReceipt(receipt) {
    await ensureDurableDirectory(durableReceiptsDir);
    const file = receiptPath(receipt.key);
    const tmp = `${file}.publish-${process.pid}-${randomBytes(6).toString("hex")}`;
    const handle = await fs.open(tmp, "wx", 0o600);
    let closed = false;
    let linked = false;
    try {
      await handle.writeFile(JSON.stringify(receipt), "utf8");
      await handle.sync();
      await handle.close();
      closed = true;
      await fs.link(tmp, file);
      linked = true;
      await syncDirectory(durableReceiptsDir);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      if (linked) await unlinkDurable(file).catch(() => undefined);
      throw error;
    } finally {
      if (!closed) await handle.close().catch(() => undefined);
      await unlinkDurable(tmp).catch(() => undefined);
    }
  }

  async function replaceReceipt(key, token, patch) {
    const file = receiptPath(key);
    const current = await readReceipt(key, observedNowMs());
    if (!current || current.token !== token) return false;
    await writeDurableJson(file, { ...current, ...patch });
    return true;
  }

  async function removeReceipt(key, token) {
    if (typeof _testHooks?.beforeRemoveReceipt === "function") {
      await _testHooks.beforeRemoveReceipt({ key, token });
    }
    const current = await readReceipt(key, observedNowMs());
    if (!current) return true;
    if (current.token !== token) return false;
    return unlinkReceipt(receiptPath(key));
  }

  return {
    async claim(body) {
      const validationError = validateJobPayload(body);
      if (validationError) {
        return { accepted: false, source: "invalid", error: validationError };
      }
      const key = jobKey(body);
      try {
        return await withClaimLock(async () => {
          const nowMs = observedNowMs();
          await purgeSettled(nowMs);
          if (pending.has(key)) {
            return { accepted: false, key, source: pendingSource(pending.get(key)) };
          }
          let receiptCount;
          try {
            receiptCount = await purgeReceipts(nowMs);
          } catch (error) {
            return { accepted: false, key, source: "storage-error", error: error?.message || String(error) };
          }

          try {
            const receipt = await readReceipt(key, nowMs);
            if (receipt) {
              if (
                receipt.state === "active" &&
                receipt.ownerPid === process.pid &&
                receipt.guardToken === guardToken
              ) {
                // This guard has no in-memory owner for the token (checked
                // above), so publication failed before dispatch preparation.
                // Reclaim only its own exact generation and retry normally.
                if (!(await removeReceipt(key, receipt.token))) {
                  return { accepted: false, key, source: "storage-error", error: "orphaned active claim changed owner" };
                }
              } else {
              return {
                accepted: false,
                key,
                source: receipt.state === "active" && receipt.ownerPid === process.pid ? "in-flight" : "receipt",
                receiptState: receipt.state
              };
              }
            }
          } catch (error) {
            return { accepted: false, key, source: "storage-error", error: error?.message || String(error) };
          }

          // Capacity is checked before the board scan so a flood of distinct jobs
          // cannot turn one bounded queue into unbounded disk work. Durable receipts
          // count too, so a second process cannot bypass the in-memory bound.
          if (Math.max(activePendingCount(), receiptCount) >= effectiveMaxPending) {
            return { accepted: false, key, source: "backpressure" };
          }

          let queued;
          try {
            queued = await findQueuedJob({ key, cardsDir, nowMs, ttlMs: effectiveTtlMs });
          } catch (error) {
            return {
              accepted: false,
              key,
              source: "storage-error",
              error: error?.message || String(error)
            };
          }
          if (queued) return { accepted: false, key, source: "kanban", ...queued };

          // Re-check immediately before claiming; another process cannot enter
          // this section until the durable capacity reservation is published.
          const claimedAt = observedNowMs();
          await purgeSettled(claimedAt);
          if (pending.has(key)) {
            return { accepted: false, key, source: pendingSource(pending.get(key)) };
          }
          if (activePendingCount() >= effectiveMaxPending) {
            return { accepted: false, key, source: "backpressure" };
          }
          const token = randomBytes(16).toString("hex");
          let published;
          try {
            published = await publishReceipt({
              version: 1,
              key,
              token,
              state: "active",
              ownerPid: process.pid,
              ownerStartId: await processStartIdentity(process.pid),
              guardToken,
              claimedAt,
              body: canonicalValue(body)
            });
          } catch (error) {
            return { accepted: false, key, source: "storage-error", error: error?.message || String(error) };
          }
          if (!published) {
            try {
              const receipt = await readReceipt(key, claimedAt);
              if (receipt) {
                return {
                  accepted: false,
                  key,
                  source: receipt.state === "active" && receipt.ownerPid === process.pid ? "in-flight" : "receipt",
                  receiptState: receipt.state
                };
              }
            } catch (error) {
              return { accepted: false, key, source: "storage-error", error: error?.message || String(error) };
            }
            return { accepted: false, key, source: "backpressure" };
          }
          pending.set(key, { claimedAt, token, state: "active" });
          return { accepted: true, key, token, source: "new" };
        });
      } catch (error) {
        return { accepted: false, key, source: "storage-error", error: error?.message || String(error) };
      }
    },

    async beginDispatch(key, token) {
      const claim = pending.get(key);
      if (claim?.token !== token || claim.state !== "active") return false;
      const dispatchedAt = observedNowMs();
      const updated = await replaceReceipt(key, token, {
        state: "dispatching",
        dispatchedAt
      });
      if (!updated) return false;
      claim.state = "dispatching";
      claim.dispatchedAt = dispatchedAt;
      return true;
    },

    async retain(key, token) {
      const claim = pending.get(key);
      if (claim?.token !== token || !["dispatching", "settled"].includes(claim.state)) return false;
      const retainedAt = claim.settledAt ?? observedNowMs();
      try {
        const retained = await replaceReceipt(key, token, {
          state: "retained",
          retainedAt
        });
        if (retained) {
          claim.state = "retained";
          claim.retainedAt = retainedAt;
          delete claim.settledAt;
          cancelRetentionRepair(key);
        } else {
          claim.state = "settled";
          claim.settledAt = retainedAt;
          delete claim.retainedAt;
          scheduleRetentionRepair(key, token);
        }
        return retained;
      } catch (error) {
        // The admitted turn is complete/uncertain even when the durable state
        // transition fails. Keep suppressing this token, but no longer charge
        // it as active capacity; later retain/TTL cleanup retries exact-token
        // repair without replaying the turn.
        claim.state = "settled";
        claim.settledAt = retainedAt;
        delete claim.retainedAt;
        scheduleRetentionRepair(key, token);
        throw error;
      }
    },

    async release(key, token) {
      const claim = pending.get(key);
      if (claim?.token !== token) return false;
      try {
        const removed = await removeReceipt(key, token);
        // A false result means a different durable generation won. This guard's
        // stale in-memory token must still be retired; it may never shadow the
        // successor merely because it could not remove it.
        pending.delete(key);
        cancelRetentionRepair(key);
        cancelReleaseRepair(key);
        return removed;
      } catch {
        // Queue admission has not happened on either release call site. Stop
        // charging this generation as active capacity, keep same-key requests
        // retryable, and repair the exact token once storage recovers.
        claim.state = "releasing";
        cancelRetentionRepair(key);
        scheduleReleaseRepair(key, token);
        return false;
      }
    }
  };
}

export async function prepareClaimForAcknowledgement({ guard, claim }) {
  try {
    const dispatchMarked = await guard.beginDispatch(claim.key, claim.token);
    if (!dispatchMarked) throw new Error("job claim lost ownership before dispatch");
  } catch (error) {
    // No queue admission has happened yet, so this exact active generation is
    // safe to release. If storage is itself unavailable, leave the receipt as
    // fail-closed evidence and return a retryable response to the producer.
    await guard.release(claim.key, claim.token).catch(() => undefined);
    throw error;
  }
}

export async function forwardClaimWithRetry({
  guard,
  claim,
  forward,
  dispatchPrepared = false,
  attempts = 3,
  baseDelayMs = 250,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onFailure = () => {},
  onAdmitted = () => {},
  isFailure = () => false
}) {
  const boundedAttempts = Math.max(1, Math.min(5, Math.floor(Number(attempts) || 1)));
  if (!dispatchPrepared) await prepareClaimForAcknowledgement({ guard, claim });
  let lastError;
  let dispatched;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      // `forward` performs only pre-dispatch readiness + queue admission and
      // returns { completion }. Retrying this narrow seam is safe; completion
      // itself is awaited exactly once below because a late turn failure may
      // follow Slack/Trello side effects.
      dispatched = await forward();
      break;
    } catch (error) {
      lastError = error;
      onFailure(error, attempt, boundedAttempts);
      if (attempt < boundedAttempts) await sleep(baseDelayMs * (2 ** (attempt - 1)));
    }
  }
  if (dispatched === undefined) {
    await guard.release(claim.key, claim.token);
    throw lastError;
  }

  // The HTTP producer may be acknowledged once (and only once) the gateway's
  // own queue has accepted the turn. Completion can take minutes and remains
  // background work, but a mere durable reservation is not queue admission.
  // Calling this seam before awaiting completion closes the process-crash gap
  // where a producer received 202 even though no operative turn was enqueued.
  onAdmitted(dispatched);

  try {
    const result = dispatched && typeof dispatched === "object" && "completion" in dispatched
      ? await dispatched.completion
      : dispatched;
    if (isFailure(result)) {
      throw new Error("operative reported a scheduled-job failure");
    }
    const retained = await guard.retain(claim.key, claim.token);
    if (!retained) throw new Error("job claim lost ownership before durable retention");
    return result;
  } catch (error) {
    // Dispatch may already have produced external effects. Retain the uncertain
    // generation rather than replaying the whole turn; the next cadence becomes
    // eligible after the normal dedupe window.
    try {
      await guard.retain(claim.key, claim.token);
    } catch {
      // The durable dispatching receipt already records the uncertainty.
    }
    throw error;
  }
}

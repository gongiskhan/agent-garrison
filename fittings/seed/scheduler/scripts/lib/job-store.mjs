// The scheduler's job store.
//
// The mesh state service is the source of truth. Jobs there are STRUCTURED
// ({target, spec}) rather than baked shell strings, CAS'd on `rev`, and shared
// by every node — so `register` from one node is visible from all of them and a
// shared job can be fired exactly once.
//
// UNENROLLED FALLBACK. When discovery fails (no GARRISON_STATE_URL/_TOKEN and
// no readable $GARRISON_HOME/state.json), the store falls back to the LEGACY
// FILE at $GARRISON_HOME/scheduler-jobs.json, behaving exactly as it did before
// the mesh. This is the one permitted file fallback in the migration and it is
// deliberate: the scheduler predates the mesh, EVERY fitting setup hook shells
// out to its CLI, and a machine outside the mesh must still boot with a working
// scheduler. It is announced once per process, never once per call.
//
// The store deliberately has no cache and no write queue. A node that IS
// enrolled and whose service is down gets a loud StateUnavailableError, not a
// silent slide back onto a stale file — a stale read is worse than a clear stop.

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStateClient, StateApiError } from "./state-client.mjs";

export const FILE_TARGET = "local";

export function legacyJobsFile(env = process.env) {
  const home = env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  return env.GARRISON_SCHEDULER_JOBS ?? path.join(home, "scheduler-jobs.json");
}

// Does a job's target name this node? `any` and `all` are every node's;
// `node:<name>` is exactly one node's. A file-store job is `local` and belongs
// to the machine holding the file.
export function targetMatchesNode(target, self) {
  if (!target || target === FILE_TARGET) return true;
  if (target === "any" || target === "all") return true;
  return self ? target === `node:${self}` : false;
}

export function defaultTargetFor(self) {
  return self ? `node:${self}` : FILE_TARGET;
}

// ── shape translation ───────────────────────────────────────────────────────
// One in-memory job shape, whichever store produced it:
//   {id, cron, type, enabled, target, spec, description, rev,
//    command, integration, poll_interval_ms, last_run, last_run_minute}
// `command` is the legacy projection consumers still read (improver-nightly's
// setup hook matches a job by its command string); it is the shell spec's
// command verbatim, and null for a structured fitting-script job.

export function fromServiceRow(row) {
  const spec = row.spec ?? {};
  return {
    id: row.id,
    cron: row.cron,
    type: row.type ?? "cron",
    enabled: row.enabled !== false,
    target: row.target,
    spec,
    description: row.description ?? undefined,
    rev: row.rev,
    command: spec.kind === "shell" ? (spec.command ?? null) : null,
    integration: spec.integration,
    poll_interval_ms: spec.poll_interval_ms
  };
}

function fromLegacyRecord(record) {
  const spec = { kind: "shell", command: record.command };
  if (record.integration !== undefined) spec.integration = record.integration;
  if (record.poll_interval_ms !== undefined) spec.poll_interval_ms = record.poll_interval_ms;
  return {
    id: record.id,
    cron: record.cron,
    type: record.type ?? "cron",
    enabled: record.enabled !== false,
    target: FILE_TARGET,
    spec,
    description: record.description,
    rev: null,
    command: record.command ?? null,
    integration: record.integration,
    poll_interval_ms: record.poll_interval_ms,
    last_run: record.last_run,
    last_run_minute: record.last_run_minute
  };
}

// Back to the on-disk record, field-for-field as the pre-mesh store wrote it —
// nothing about the legacy file's shape changes.
function toLegacyRecord(job) {
  const record = {
    id: job.id,
    cron: job.cron,
    command: job.spec?.kind === "shell" ? job.spec.command : job.command,
    enabled: job.enabled !== false,
    type: job.type ?? "cron"
  };
  const description = job.description ?? job.spec?.description;
  const integration = job.integration ?? job.spec?.integration;
  const pollMs = job.poll_interval_ms ?? job.spec?.poll_interval_ms;
  if (description !== undefined) record.description = description;
  if (integration !== undefined) record.integration = integration;
  if (pollMs !== undefined) record.poll_interval_ms = pollMs;
  if (job.last_run !== undefined) record.last_run = job.last_run;
  if (job.last_run_minute !== undefined) record.last_run_minute = job.last_run_minute;
  return record;
}

// ── the store ───────────────────────────────────────────────────────────────

let announced = false;

export function createJobStore({
  env = process.env,
  readFileSync = fsSync.readFileSync,
  fetchImpl,
  log = console.error,
  timeoutMs
} = {}) {
  const jobsFile = legacyJobsFile(env);

  let client = null;
  let self = null;
  let fallbackReason = null;
  try {
    client = createStateClient({ env, readFileSync, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
    self = env.GARRISON_NODE_NAME?.trim() || client.node || null;
    if (!self) {
      // Enrolled but nameless: listSchedulerJobs() without a node would return
      // EVERY node's jobs, including other machines' shell commands. Fail
      // closed onto the file rather than fire a Mac path on Linux.
      client = null;
      fallbackReason = "the state service is reachable but this node has no name (GARRISON_NODE_NAME unset and state.json carries no node)";
    }
  } catch (err) {
    fallbackReason = err?.message ?? String(err);
  }

  const mode = client ? "state" : "file";

  if (mode === "file" && !announced) {
    announced = true;
    log(`[scheduler] job store: legacy file ${jobsFile} — ${fallbackReason}`);
  }

  // ── legacy file store ──
  async function readFile() {
    try {
      const parsed = JSON.parse(await fs.readFile(jobsFile, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("jobs file is not an array");
      return parsed;
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  async function writeFile(records) {
    await fs.mkdir(path.dirname(jobsFile), { recursive: true });
    await fs.writeFile(jobsFile, JSON.stringify(records, null, 2) + "\n");
  }

  // ── state store ──
  //
  // PER-NODE ID NAMESPACING. The service keys jobs by bare id, and every
  // node's setup hook registers the same logical ids (vault-git-sync,
  // kanban-tick, ...) pinned to ITSELF — with bare ids the four nodes fought
  // over one row, each register re-targeting it and every OTHER node's verify
  // reading "not registered" (found live on the first three-Mac up()). A
  // node-targeted job therefore lives in the service as `<id>@<node>`; the
  // suffix is invisible to callers, and legacy bare rows targeted at this
  // node keep working until their next save migrates them.
  function nodeOfTarget(target) {
    return typeof target === "string" && target.startsWith("node:") ? target.slice(5) : null;
  }
  function serviceIdFor(id, target) {
    const node = nodeOfTarget(target);
    return node ? `${id}@${node}` : id;
  }
  function displayId(row) {
    const node = nodeOfTarget(row.target);
    if (node && row.id.endsWith(`@${node}`)) return row.id.slice(0, -(node.length + 1));
    return row.id;
  }

  // There is no single-job GET, and `remove` must be able to address a job
  // pinned to ANOTHER node, so the raw lookup is deliberately unfiltered.
  // Matches the LOGICAL id: the suffixed row for any node, or a legacy bare
  // row. Own-node rows win over peers'.
  async function rawJob(id) {
    const rows = await client.listSchedulerJobs();
    const matches = rows.filter((row) => row.id === id || displayId(row) === id);
    if (!matches.length) return null;
    const own = matches.find((row) => nodeOfTarget(row.target) === self);
    return own ?? matches[0];
  }

  async function putWithRev(id, job, rev) {
    return client.putSchedulerJob(
      id,
      {
        cron: job.cron,
        target: job.target,
        spec: job.spec,
        ...(job.description !== undefined ? { description: job.description } : {}),
        ...(job.enabled !== undefined ? { enabled: job.enabled } : {}),
        type: job.type ?? "cron"
      },
      { ifMatchRev: rev }
    );
  }

  return {
    mode,
    self,
    jobsFile,
    client,
    fallbackReason,
    defaultTarget: defaultTargetFor(self),

    /** Every job this node is responsible for: its own, plus every shared one. */
    async loadJobs() {
      if (mode === "file") return (await readFile()).map(fromLegacyRecord);
      const rows = await client.listSchedulerJobs(self);
      return rows.map((row) => ({ ...fromServiceRow(row), id: displayId(row) }));
    },

    /** One job by id, WITHOUT the target filter — `remove` and `enable` address
     *  a job by name whoever it is pinned to. */
    async getJob(id) {
      if (mode === "file") {
        const record = (await readFile()).find((r) => r?.id === id);
        return record ? fromLegacyRecord(record) : null;
      }
      const row = await rawJob(id);
      return row ? { ...fromServiceRow(row), id: displayId(row) } : null;
    },

    /** Write a job through, CAS'd on the rev we read.
     *
     *  `enabled: undefined` means "keep whatever is there" — the register
     *  semantics, resolved by the store rather than by a read-then-write in the
     *  caller. The If-Match precondition is what makes a racing registrar
     *  EXPLICIT instead of a silent last-writer-wins overwrite: the
     *  wouldDowngradeJob class of guard becomes structural, and the one retry
     *  re-reads rather than forcing.
     */
    async saveJob(id, job) {
      if (mode === "file") {
        const records = await readFile();
        const existing = records.find((r) => r?.id === id);
        const enabled = job.enabled === undefined ? existing?.enabled !== false : job.enabled !== false;
        const next = records.filter((r) => r?.id !== id);
        next.push(toLegacyRecord({ ...job, id, enabled }));
        await writeFile(next);
        return { id, rev: null };
      }
      const wireId = serviceIdFor(id, job.target);
      // A legacy bare row TARGETED AT THIS NODE is this job's old home —
      // update it in place (its id migrates on the service side only when
      // the row is re-created; never fight over a peer's bare row).
      const current = await rawJob(id);
      const currentIsOurs = current && nodeOfTarget(current.target) === self;
      const writeId = currentIsOurs ? current.id : wireId;
      try {
        return await putWithRev(writeId, job, currentIsOurs ? current.rev : (current?.id === writeId ? current.rev : 0));
      } catch (err) {
        if (!(err instanceof StateApiError) || err.status !== 409) throw err;
        // Exactly one retry, and it RE-READS. A blind force would be the
        // overwrite the precondition exists to prevent.
        const fresh = await rawJob(id);
        const freshIsOurs = fresh && nodeOfTarget(fresh.target) === self;
        const retryId = freshIsOurs ? fresh.id : wireId;
        return putWithRev(retryId, job, freshIsOurs ? fresh.rev : (fresh?.id === retryId ? fresh.rev : 0));
      }
    },

    async removeJob(id) {
      if (mode === "file") {
        const records = await readFile();
        const next = records.filter((r) => r?.id !== id);
        await writeFile(next);
        return { removed: next.length !== records.length };
      }
      const current = await rawJob(id);
      if (!current) return { removed: false };
      try {
        await client.deleteSchedulerJob(current.id, { ifMatchRev: current.rev });
        return { removed: true };
      } catch (err) {
        if (!(err instanceof StateApiError)) throw err;
        if (err.status === 404) return { removed: false };
        if (err.status !== 409) throw err;
        const fresh = await rawJob(id);
        if (!fresh) return { removed: false };
        await client.deleteSchedulerJob(fresh.id, { ifMatchRev: fresh.rev });
        return { removed: true };
      }
    },

    /** Lease the occurrence of a shared (`any`) job. Not granted → another node
     *  is running it this minute. `node:<self>` and `all` need no lease: nobody
     *  else is a candidate, or every node is meant to run it. */
    async acquireOccurrence(job, occurrence, ttlMs) {
      if (mode === "file" || job.target !== "any") return { granted: true, skipped: true };
      return client.acquireLease({
        key: `job:${job.id}:${occurrence}`,
        holder: `${self}/${process.pid}`,
        ttlMs,
        meta: { jobId: job.id, occurrence }
      });
    },

    /** The occurrence ledger — the belt to the lease's braces, and the first
     *  time a MISSED occurrence is visible at all. */
    async recordRunStart(job, occurrence) {
      if (mode === "file") return { recorded: true, skipped: true };
      return client.recordSchedulerRun({ jobId: job.id, occurrence });
    },

    async recordRunEnd(job, occurrence, exit) {
      if (mode === "file") return { recorded: true, skipped: true };
      return client.recordSchedulerRun({
        jobId: job.id,
        occurrence,
        endedAt: new Date().toISOString(),
        exit: exit ?? null
      });
    }
  };
}

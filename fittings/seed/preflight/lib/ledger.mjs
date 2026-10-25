// What changed since the last run.
//
// NOT a snapshot diff of the report: the report carries generatedAt, live pids
// and counts, so comparing two of them says "changed" every single time. What
// is stable is the IDENTITY of a finding — `check:id` — so the ledger records
// one row per finding and derives new / ongoing / regressed / resolved from
// that. It composes with the demotion bands for free, because both key on the
// same pair.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const RANK = { info: 0, pass: 1, warn: 2, fail: 3 };
const VERSION = 1;

export function dataDir(env = process.env) {
  return env.GARRISON_PREFLIGHT_DATA_DIR
    || env.GARRISON_PREFLIGHT_DATA
    || path.join(env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "preflight");
}

export const ledgerPath = (env = process.env) => path.join(dataDir(env), "findings.json");

export const keyOf = (finding) => `${finding.check}:${finding.id}`;

// A corrupt ledger must NOT read as empty: that would silently report the whole
// board as new and every remembered finding as resolved. Refuse loudly instead
// and let the caller degrade with a visible row.
export async function readLedger({ env = process.env } = {}) {
  let raw;
  try {
    raw = await readFile(ledgerPath(env), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { version: VERSION, findings: {} };
    throw new Error(`preflight ledger unreadable at ${ledgerPath(env)}: ${err.message}`);
  }
  let doc;
  try { doc = JSON.parse(raw); } catch { throw new Error(`preflight ledger at ${ledgerPath(env)} is not valid JSON`); }
  if (!doc || typeof doc !== "object" || !doc.findings || typeof doc.findings !== "object" || Array.isArray(doc.findings)) {
    throw new Error(`preflight ledger at ${ledgerPath(env)} has an unexpected shape`);
  }
  return { version: doc.version ?? VERSION, findings: doc.findings };
}

export async function writeLedger(doc, { env = process.env } = {}) {
  const file = ledgerPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(doc, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

// Pure: given the remembered rows and this run's findings, produce the
// annotated findings, the resolved list, and the ledger to persist.
export function reconcile(previous, findings, now = new Date().toISOString()) {
  const remembered = previous?.findings ?? {};
  const seen = new Set();
  const annotated = findings.map((f) => {
    const key = keyOf(f);
    seen.add(key);
    const before = remembered[key];
    if (!before) return { ...f, age: "new", firstSeenAt: now };
    const regressed = (RANK[f.status] ?? 0) > (RANK[before.lastStatus] ?? 0);
    return { ...f, age: regressed ? "regressed" : "ongoing", firstSeenAt: before.firstSeenAt ?? now, previousStatus: before.lastStatus };
  });
  const resolved = Object.entries(remembered)
    .filter(([key, row]) => !seen.has(key) && row?.lastStatus !== "pass" && row?.lastStatus !== "info")
    .map(([key, row]) => ({ key, lastStatus: row.lastStatus, lastSeenAt: row.lastSeenAt }));
  const next = { version: VERSION, findings: {} };
  for (const f of annotated) {
    next.findings[keyOf(f)] = {
      firstSeenAt: f.firstSeenAt,
      lastSeenAt: now,
      lastStatus: f.status,
      seenCount: (remembered[keyOf(f)]?.seenCount ?? 0) + 1
    };
  }
  return { annotated, resolved, next };
}

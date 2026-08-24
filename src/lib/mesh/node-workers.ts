// Live Outpost worker registry.
//
// Bridge presence and task-runner presence are deliberately separate signals:
// the WebSocket bridge can be online while no process is polling for Kanban work.
// Each worker writes its own atomically-replaced file so pulses from three Macs
// never contend on one read/modify/write document.

import crypto from "node:crypto";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { garrisonDir } from "./claude-home";
import { writeJsonAtomic } from "./atomic-write";
import { REDACTED, redactSecretValues } from "./secret-redaction";

export const DISPATCH_PROTOCOL_VERSION = "1.1";
export const WORKER_STALE_MS = 45_000;

export type WorkerActivity = "idle" | "busy" | "degraded";
export type WorkerState = "ready" | "busy" | "degraded" | "offline";

export interface WorkerPulseInput {
  workerId: string;
  protocolVersion: string;
  workerVersion: string;
  activity: WorkerActivity;
  currentCardId: string | null;
  runtimes: string[];
  ready: boolean;
  detail: string | null;
  error: string | null;
}

export interface WorkerRecord extends WorkerPulseInput {
  machine: string;
  lastSeenAt: string;
}

export interface WorkerView extends WorkerRecord {
  state: WorkerState;
  stale: boolean;
}

export interface WorkerClaimVerdict {
  ok: boolean;
  code: "ready" | "worker-offline" | "worker-replaced" | "protocol-mismatch" | "worker-not-ready" | "worker-busy" | "runtime-unsupported";
  detail: string;
}

function registryDir(): string {
  return path.join(garrisonDir(), "outpost-workers");
}

function recordPath(machine: string): string {
  // Machine names are registry-controlled but still untrusted filesystem input.
  // Hashing also avoids macOS case-folding collisions.
  const key = crypto.createHash("sha256").update(machine).digest("hex");
  return path.join(registryDir(), `${key}.json`);
}

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

// Worker diagnostics cross a machine boundary and are persisted + rendered in
// two UIs. Treat them as hostile log output: redact both values already known to
// this host and common credential wire shapes before bounding the result. Merely
// stripping controls/truncating is not redaction — a short bearer token at the
// beginning of an error would otherwise survive intact forever.
const secretEnvValues = (): string[] => Object.entries(process.env)
  .filter(([key, value]) => value && /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|auth)/i.test(key))
  .map(([, value]) => String(value));

export function redactWorkerDiagnostic(value: unknown, max = 500): string {
  let out = typeof value === "string" ? value : "";
  out = redactSecretValues(out, secretEnvValues())
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`)
    .replace(/\b(password|passwd|secret|token|api[_-]?key|authorization|credential|cookie|set-cookie)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, (_match, key, separator) => `${key}${separator}${REDACTED}`)
    .replace(/\b(?:sk-(?:ant|proj|live)?-?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|omi_(?:dev|mcp)_[A-Za-z0-9_-]{8,})\b/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return out.length > max ? out.slice(0, max) : out;
}

export function normaliseWorkerPulse(raw: unknown): WorkerPulseInput {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const activity: WorkerActivity =
    body.activity === "busy" || body.activity === "degraded" ? body.activity : "idle";
  const runtimes = Array.isArray(body.runtimes)
    ? [...new Set(body.runtimes.map((v) => text(v, 64)).filter(Boolean))].slice(0, 16)
    : [];
  return {
    workerId: text(body.workerId, 160) || "unknown",
    protocolVersion: text(body.protocolVersion, 32) || "unknown",
    workerVersion: text(body.workerVersion, 32) || "unknown",
    activity,
    currentCardId: text(body.currentCardId, 64) || null,
    runtimes,
    ready: body.ready === true,
    detail: redactWorkerDiagnostic(body.detail, 280) || null,
    error: redactWorkerDiagnostic(body.error, 500) || null
  };
}

export async function recordWorkerPulse(machine: string, raw: unknown): Promise<WorkerRecord> {
  const record: WorkerRecord = {
    machine,
    ...normaliseWorkerPulse(raw),
    lastSeenAt: new Date().toISOString()
  };
  await writeJsonAtomic(recordPath(machine), record, { mode: 0o600 });
  return record;
}

function parseRecord(raw: unknown): WorkerRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const machine = text(body.machine, 160);
  const lastSeenAt = text(body.lastSeenAt, 64);
  if (!machine || !Number.isFinite(Date.parse(lastSeenAt))) return null;
  return { machine, ...normaliseWorkerPulse(body), lastSeenAt };
}

export function workerView(record: WorkerRecord, now = Date.now()): WorkerView {
  const stale = now - Date.parse(record.lastSeenAt) > WORKER_STALE_MS;
  const state: WorkerState = stale
    ? "offline"
    : !record.ready || record.activity === "degraded"
      ? "degraded"
      : record.activity === "busy"
        ? "busy"
        : "ready";
  return { ...record, state, stale };
}

export async function listWorkerViews(now = Date.now()): Promise<WorkerView[]> {
  let names: string[];
  try {
    names = await readdir(registryDir());
  } catch {
    return [];
  }
  const records = await Promise.all(names.filter((n) => n.endsWith(".json")).map(async (name) => {
    try {
      return parseRecord(JSON.parse(await readFile(path.join(registryDir(), name), "utf8")));
    } catch {
      return null;
    }
  }));
  return records
    .filter((record): record is WorkerRecord => record !== null)
    .map((record) => workerView(record, now))
    .sort((a, b) => a.machine.localeCompare(b.machine));
}

export async function readWorkerView(machine: string, now = Date.now()): Promise<WorkerView | null> {
  try {
    const record = parseRecord(JSON.parse(await readFile(recordPath(machine), "utf8")));
    if (!record || record.machine !== machine) return null;
    return workerView(record, now);
  } catch {
    return null;
  }
}

// The bearer token proves the MACHINE; the fresh pulse proves the particular
// worker process and what it can actually execute. Both are required. Without
// this second gate, an old process (or a bridge-only Mac) can claim work merely
// because it still possesses the machine token.
export function workerClaimVerdict(
  view: WorkerView | null,
  { machine, workerId, runtimeKey }: { machine: string; workerId: string; runtimeKey?: string | null }
): WorkerClaimVerdict {
  if (!view || view.machine !== machine || view.stale || view.state === "offline") {
    return { ok: false, code: "worker-offline", detail: "the task runner has no fresh readiness pulse (45 second limit)" };
  }
  if (!workerId || view.workerId !== workerId) {
    return { ok: false, code: "worker-replaced", detail: "the polling worker id does not own the latest readiness pulse" };
  }
  if (view.protocolVersion !== DISPATCH_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "protocol-mismatch",
      detail: `worker protocol ${view.protocolVersion} is incompatible with host protocol ${DISPATCH_PROTOCOL_VERSION}`
    };
  }
  if (!view.ready || view.state === "degraded") {
    return { ok: false, code: "worker-not-ready", detail: view.detail || "the task runner did not pass its local readiness checks" };
  }
  if (view.state === "busy" || view.activity === "busy") {
    return { ok: false, code: "worker-busy", detail: `the task runner is already working on ${view.currentCardId || "another card"}` };
  }
  if (runtimeKey && !view.runtimes.includes(runtimeKey)) {
    return {
      ok: false,
      code: "runtime-unsupported",
      detail: `the task runner did not advertise ${runtimeKey}; available: ${view.runtimes.join(", ") || "none"}`
    };
  }
  return { ok: true, code: "ready", detail: "fresh compatible task runner" };
}

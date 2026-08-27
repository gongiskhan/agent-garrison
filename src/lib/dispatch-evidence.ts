// Receiving-side validation for evidence uploaded by a remote node's task runner.
//
// Upload and completion are separate requests. The completion manifest binds
// the files the worker says belong to this run to the bytes already persisted
// on the host, so a terminal transition can never race ahead of its evidence.

import crypto from "node:crypto";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { kanbanBoardDir } from "./dispatch";

export const SAFE_DISPATCH_EVIDENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export interface DispatchEvidenceEntry {
  name: string;
  bytes: number;
  sha256: string;
}

export function dispatchRunKey(runId: string): string {
  if (!runId.trim()) throw new Error("runId is required for dispatch evidence");
  return crypto.createHash("sha256").update(runId).digest("hex").slice(0, 32);
}

// Retries and Stop & reroute produce independent immutable evidence bundles.
// Never point a new claim at the old claim's flat dispatch directory: a stale
// gate with the same phase name could otherwise authorize the retry.
export function dispatchEvidenceDir(cardId: string, runId: string): string {
  return path.resolve(kanbanBoardDir(), "cards", cardId, "dispatch", "runs", dispatchRunKey(runId));
}

export function normaliseEvidenceManifest(raw: unknown): DispatchEvidenceEntry[] {
  if (!Array.isArray(raw) || raw.length > 64) throw new Error("evidenceManifest must be an array of at most 64 files");
  const seen = new Set<string>();
  return raw.map((item) => {
    const body = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const bytes = Number(body.bytes);
    const sha256 = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : "";
    if (!SAFE_DISPATCH_EVIDENCE_NAME.test(name)) throw new Error(`unsafe evidence name: ${name}`);
    if (seen.has(name)) throw new Error(`duplicate evidence entry: ${name}`);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`invalid evidence size for ${name}`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`invalid evidence digest for ${name}`);
    seen.add(name);
    return { name, bytes, sha256 };
  });
}

export async function verifyEvidenceManifest(
  cardId: string,
  runId: string,
  raw: unknown,
  requiredNames: string[]
): Promise<DispatchEvidenceEntry[]> {
  const manifest = normaliseEvidenceManifest(raw);
  const byName = new Map(manifest.map((entry) => [entry.name, entry]));
  for (const name of requiredNames) {
    if (!byName.has(name)) throw new Error(`required evidence is missing: ${name}`);
  }
  const dir = dispatchEvidenceDir(cardId, runId);
  for (const entry of manifest) {
    const target = path.resolve(dir, entry.name);
    if (path.dirname(target) !== dir) throw new Error(`evidence path escapes the card directory: ${entry.name}`);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) throw new Error(`evidence file is not present: ${entry.name}`);
    if (info.size !== entry.bytes) throw new Error(`evidence size does not match for ${entry.name}`);
    const digest = crypto.createHash("sha256").update(await readFile(target)).digest("hex");
    if (digest !== entry.sha256) throw new Error(`evidence digest does not match for ${entry.name}`);
  }
  return manifest;
}

export interface VerifiedDispatchGate {
  status: string;
  nextPhase: string;
}

// A matching hash proves WHICH bytes arrived, not that those bytes prove the
// phase passed. Interpret the gate on the host so a worker cannot upload a
// perfectly hashed failed/mismatched gate and then claim a successful edge.
export async function verifyDispatchGate(
  cardId: string,
  runId: string,
  phase: string,
  requestedTransition: string
): Promise<VerifiedDispatchGate> {
  const dir = dispatchEvidenceDir(cardId, runId);
  const name = `gate-status.${phase}.json`;
  if (!SAFE_DISPATCH_EVIDENCE_NAME.test(name)) throw new Error("phase cannot be used as a gate evidence name");
  let gate: Record<string, unknown>;
  try {
    gate = JSON.parse(await readFile(path.join(dir, name), "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  const status = typeof gate.status === "string" ? gate.status.trim().toLowerCase() : "";
  if (status !== "passed" && status !== "success") {
    throw new Error(`${name} does not declare a passed/success status`);
  }
  const nextPhase = typeof gate.next_phase === "string"
    ? gate.next_phase.trim()
    : typeof gate.nextPhase === "string"
      ? gate.nextPhase.trim()
      : "";
  if (!nextPhase || nextPhase !== requestedTransition) {
    throw new Error(`${name} declares next phase ${nextPhase || "(none)"}, not ${requestedTransition}`);
  }
  return { status, nextPhase };
}

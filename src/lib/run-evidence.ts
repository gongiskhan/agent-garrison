import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { writeJsonAtomic } from "./atomic-write";

// Run evidence (WS4 / D6): every up() records which composition started and a
// content hash of its apm.yml at launch time, so the final gate can prove
// "sessions ran under two different composition ids" straight off disk.
//
// Storage: one file per composition at
//   <compositionDir>/.garrison/run-evidence.json
// holding an APPEND-FRIENDLY ARRAY of records, oldest first, capped to the last
// MAX_RECORDS. Each record is self-contained ({compositionId, apmYmlSha256, at})
// so a reader can attribute any record without cross-referencing the filename.

export interface RunEvidenceRecord {
  compositionId: string;
  apmYmlSha256: string;
  at: string; // ISO-8601 timestamp
}

const MAX_RECORDS = 100;

export function runEvidencePath(compositionDir: string): string {
  return path.join(compositionDir, ".garrison", "run-evidence.json");
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// Read the record array for a composition (empty when the file is absent or
// unparseable). Tolerates a legacy object wrapper ({ records: [...] }) as well
// as the bare-array form this module writes.
export async function readRunEvidence(compositionDir: string): Promise<RunEvidenceRecord[]> {
  try {
    const raw = await fs.readFile(runEvidencePath(compositionDir), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as RunEvidenceRecord[];
    if (parsed && Array.isArray((parsed as { records?: unknown }).records)) {
      return (parsed as { records: RunEvidenceRecord[] }).records;
    }
    return [];
  } catch {
    return [];
  }
}

// Append a run-evidence record for a composition. Hashes the composition's
// apm.yml (read from manifestPath) and appends {compositionId, apmYmlSha256, at}
// to the composition's run-evidence array. The hash is a pure function of the
// manifest bytes and `at` is injectable, so the record is deterministic for a
// given manifest + clock — which the tests rely on.
export async function appendRunEvidence(args: {
  compositionDir: string;
  compositionId: string;
  manifestPath: string;
  at?: string;
}): Promise<RunEvidenceRecord> {
  const manifest = await fs.readFile(args.manifestPath, "utf8");
  const record: RunEvidenceRecord = {
    compositionId: args.compositionId,
    apmYmlSha256: sha256Hex(manifest),
    at: args.at ?? new Date().toISOString()
  };
  const existing = await readRunEvidence(args.compositionDir);
  const next = [...existing, record].slice(-MAX_RECORDS);
  await writeJsonAtomic(runEvidencePath(args.compositionDir), next);
  return record;
}

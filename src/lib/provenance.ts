import fs from "node:fs/promises";
import { provenanceLedgerPath } from "./claude-home";
import { writeJsonAtomic } from "./atomic-write";

// The provenance ledger carries what apm.lock.yaml structurally cannot:
//   - ownership for non-file surfaces (hooks live in settings.json, MCP in
//     mcp.json — neither appears in the lock), and
//   - the per-primitive `lastWrittenHash` that powers HASH-COMPARE echo
//     suppression: after a Garrison-initiated write, we record the resulting
//     hash; a later watcher event whose on-disk hash equals it is our own write
//     echoing back, not a genuine external edit. (Hash-compare, not ignore-next:
//     fs events can land after a timing window closes — content comparison is
//     durable.)
//
// Stored at ~/.garrison/global-composition/garrison-provenance.json. Not a
// re-implementation of the retired S2 lock — it holds only the residue the lock
// can't express.

export interface ProvenanceEntry {
  surface?: string;
  fittingId?: string;
  lastWrittenHash?: string;
}

export type ProvenanceLedger = Record<string, ProvenanceEntry>;

export async function readLedger(): Promise<ProvenanceLedger> {
  try {
    const raw = await fs.readFile(provenanceLedgerPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ProvenanceLedger;
    }
  } catch {
    /* missing/unparseable -> empty ledger */
  }
  return {};
}

export async function writeLedger(ledger: ProvenanceLedger): Promise<void> {
  await writeJsonAtomic(provenanceLedgerPath(), ledger);
}

// Merge one entry, preserving other keys. Used after every Garrison-initiated
// write to pre-suppress the watcher echo.
export async function recordWritten(
  id: string,
  lastWrittenHash: string,
  extra: Omit<ProvenanceEntry, "lastWrittenHash"> = {}
): Promise<void> {
  const ledger = await readLedger();
  ledger[id] = { ...ledger[id], ...extra, lastWrittenHash };
  await writeLedger(ledger);
}

// Batch variant — snapshot many primitives in one atomic write (e.g. after an
// apm install that deployed several files).
export async function recordWrittenBatch(
  entries: Array<{ id: string } & ProvenanceEntry>
): Promise<void> {
  if (entries.length === 0) return;
  const ledger = await readLedger();
  for (const { id, ...entry } of entries) {
    ledger[id] = { ...ledger[id], ...entry };
  }
  await writeLedger(ledger);
}

export async function forgetEntry(id: string): Promise<void> {
  const ledger = await readLedger();
  if (id in ledger) {
    delete ledger[id];
    await writeLedger(ledger);
  }
}

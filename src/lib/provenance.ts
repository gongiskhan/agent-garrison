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
//   - an append-only `history` of ownership events (S3f1, RUN_SPEC assumption 3,
//     constraint 10): a primitive that moves between fittings, or is parked and
//     later unparked, keeps its lineage. The lock only ever knows the CURRENT
//     owner; the ledger is where the trail lives.
//
// Stored at ~/.garrison/global-composition/garrison-provenance.json. Not a
// re-implementation of the retired S2 lock — it holds only the residue the lock
// can't express.

export type ProvenanceEventKind = "written" | "moved" | "parked" | "unparked";

// One append-only lineage record. `fittingId` is the fitting the event is ABOUT:
// the new owner on "written", the PRIOR owner on "moved", the owner at park time
// on "parked" (omitted on "unparked", which is not tied to a specific owner).
export interface ProvenanceHistoryEvent {
  fittingId?: string;
  at: string;
  event: ProvenanceEventKind;
}

export interface ProvenanceEntry {
  surface?: string;
  fittingId?: string;
  lastWrittenHash?: string;
  history?: ProvenanceHistoryEvent[];
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

// Compute the history record to append when an ownership WRITE lands, given the
// prior entry and the incoming owner. First ownership -> "written" (naming the
// new owner). A changed owner -> "moved" (naming the PRIOR owner, so its stint is
// preserved before we overwrite fittingId). Same owner / no owner -> nothing, so
// the frequent echo-suppression re-snapshots don't grow the ledger.
function writeEvent(
  prior: ProvenanceEntry | undefined,
  nextFittingId: string | undefined
): ProvenanceHistoryEvent | null {
  if (nextFittingId === undefined) return null;
  const at = new Date().toISOString();
  if (prior?.fittingId === undefined) {
    return { fittingId: nextFittingId, at, event: "written" };
  }
  if (prior.fittingId !== nextFittingId) {
    return { fittingId: prior.fittingId, at, event: "moved" };
  }
  return null;
}

// Merge one entry, preserving other keys. Used after every Garrison-initiated
// write to pre-suppress the watcher echo. Appends an ownership history record
// when (and only when) the owning fitting changes or is set for the first time.
export async function recordWritten(
  id: string,
  lastWrittenHash: string,
  extra: Omit<ProvenanceEntry, "lastWrittenHash" | "history"> = {}
): Promise<void> {
  const ledger = await readLedger();
  const prior = ledger[id];
  const history = prior?.history ? [...prior.history] : [];
  const event = writeEvent(prior, extra.fittingId);
  if (event) history.push(event);
  ledger[id] = { ...prior, ...extra, lastWrittenHash, history };
  await writeLedger(ledger);
}

// Batch variant — snapshot many primitives in one atomic write (e.g. after an
// apm install that deployed several files). Same append-only history semantics
// as recordWritten, applied per entry.
export async function recordWrittenBatch(
  entries: Array<{ id: string } & ProvenanceEntry>
): Promise<void> {
  if (entries.length === 0) return;
  const ledger = await readLedger();
  for (const { id, history: incomingHistory, ...entry } of entries) {
    const prior = ledger[id];
    const history = prior?.history ? [...prior.history] : incomingHistory ? [...incomingHistory] : [];
    const event = writeEvent(prior, entry.fittingId);
    if (event) history.push(event);
    ledger[id] = { ...prior, ...entry, history };
  }
  await writeLedger(ledger);
}

// Hard-delete an entry, dropping its history too. Retained for callers that want
// a primitive's provenance gone entirely; the state machine parks instead (see
// parkEntry) so lineage survives.
export async function forgetEntry(id: string): Promise<void> {
  const ledger = await readLedger();
  if (id in ledger) {
    delete ledger[id];
    await writeLedger(ledger);
  }
}

// Archive an owned entry on PARK: drop the live ownership fields (fittingId +
// lastWrittenHash) so echo-suppression treats it exactly like a deleted entry
// (line-186 in reconcile.ts requires a present lastWrittenHash), but KEEP the
// history and append a "parked" event. The entry stays keyed by its primitive id
// so a later unpark / re-promote continues the same lineage. No-op if absent.
export async function parkEntry(id: string): Promise<void> {
  const ledger = await readLedger();
  const entry = ledger[id];
  if (!entry) return;
  const history = entry.history ? [...entry.history] : [];
  history.push({ fittingId: entry.fittingId, at: new Date().toISOString(), event: "parked" });
  ledger[id] = { surface: entry.surface, history };
  await writeLedger(ledger);
}

// Append an "unparked" event on UNPARK. Creates a history-only entry if none
// exists (an externally-parked primitive re-entering Garrison's view). Does not
// restore lastWrittenHash — a subsequent recordWritten re-snapshots that.
export async function unparkEntry(id: string): Promise<void> {
  const ledger = await readLedger();
  const entry = ledger[id] ?? {};
  const history = entry.history ? [...entry.history] : [];
  history.push({ at: new Date().toISOString(), event: "unparked" });
  ledger[id] = { ...entry, history };
  await writeLedger(ledger);
}

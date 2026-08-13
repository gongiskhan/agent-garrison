// Discovery + fan-out for the outbound delay buffer (§8.4).
//
// A Fitting that owns an irreversible outbound send parks it for a cancel
// window instead of sending it (fittings/seed/whatsapp-web/lib/outbox.mjs is
// the canonical copy) and serves two endpoints on its own port:
//
//   GET  /outbox              -> {ok, pending: [publicEntry, ...]}
//   POST /outbox/:id/cancel   -> 200 cancelled | 409 already sent | 404 unknown
//
// Nothing registers those fittings anywhere, and nothing should: the buffer is
// a property a Fitting either has or has not, so the shell DISCOVERS it the
// same way it discovers own-port views — by enumerating
// $GARRISON_HOME/ui-fittings/*.json (see src/app/api/fittings/views/route.ts,
// whose tolerant parse and 1.5s probe budget this mirrors) and asking. A
// Fitting without a buffer answers 404 and is skipped in silence; that is a
// not-for-you, not an error.
//
// Which is also why this is honest about coverage rather than complete: the
// `google` Fitting is connector.mjs + setup.sh with no daemon, so there is no
// process there that could hold a 60-second timer, and its sends are genuinely
// unbuffered. It will never appear in this list, and the surface above must not
// imply that everything outbound is cancellable.
//
// Server-side by necessity (HARD RULE in CLAUDE.md): the reader's browser is
// almost never on this box, so a fitting's `http://127.0.0.1:<port>` would be
// the READER's loopback - unreachable, and mixed content over the HTTPS tailnet
// address. The URL never leaves this process; the client only ever sees the
// relative shell routes.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "@/lib/claude-home";

/** How long a fan-out read may take before the fitting is treated as absent. */
export const OUTBOX_LIST_TIMEOUT_MS = 1500;
/** A cancel is a deliberate tap under a 60s window - it gets more room. */
export const OUTBOX_CANCEL_TIMEOUT_MS = 3000;

export interface OutboxFitting {
  fittingId: string;
  /** The fitting's own-port loopback base. NEVER handed to the browser. */
  url: string;
}

/**
 * One parked send, as the dashboard sees it. Deliberately a subset of the
 * fitting's `publicEntry`: enough to decide whether to cancel, never the raw
 * payload (a parked WhatsApp message is a private message).
 */
export interface PendingSend {
  fitting: string;
  id: string;
  to: string | null;
  preview: string;
  context: string;
  queuedAt: string | null;
  executeAt: string;
}

/**
 * Every own-port Fitting currently advertising a status file. Same read as the
 * views API; a malformed or unreadable record is skipped rather than fatal, so
 * one torn file can never take the dashboard down.
 */
export async function listOutboxFittings(): Promise<OutboxFitting[]> {
  const dir = path.join(garrisonDir(), "ui-fittings");
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    // No ui-fittings dir at all is the ordinary nothing-is-running state.
    return [];
  }

  const reads = await Promise.all(
    names.map(async (name) => {
      try {
        const parsed = JSON.parse(await readFile(path.join(dir, name), "utf8")) as {
          fittingId?: unknown;
          url?: unknown;
        };
        if (typeof parsed.fittingId !== "string" || typeof parsed.url !== "string" || !parsed.url) {
          return null;
        }
        return { fittingId: parsed.fittingId, url: parsed.url };
      } catch {
        return null;
      }
    })
  );
  return reads.filter((f): f is OutboxFitting => f !== null);
}

/** Look one Fitting up by id. Unknown -> null, which the caller reports as 404. */
export async function findOutboxFitting(fittingId: string): Promise<OutboxFitting | null> {
  if (!fittingId) return null;
  const fittings = await listOutboxFittings();
  return fittings.find((f) => f.fittingId === fittingId) ?? null;
}

/**
 * Shape one entry from a fitting's answer. Pure, and total: an entry without a
 * string id or executeAt is not a row anything can act on, so it is dropped
 * rather than rendered as a cancel button that could never work.
 */
export function normalizePending(fittingId: string, raw: unknown): PendingSend | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== "string" || !entry.id) return null;
  if (typeof entry.executeAt !== "string" || !entry.executeAt) return null;
  return {
    fitting: fittingId,
    id: entry.id,
    to: typeof entry.to === "string" ? entry.to : null,
    preview: typeof entry.preview === "string" ? entry.preview : "",
    context: typeof entry.context === "string" ? entry.context : "agent",
    queuedAt: typeof entry.queuedAt === "string" ? entry.queuedAt : null,
    executeAt: entry.executeAt
  };
}

/**
 * Ask one Fitting what it is holding. Every failure mode - 404 (no buffer),
 * any other non-2xx, a timeout, a dead port, junk JSON - is the same answer
 * here: nothing. A fitting that cannot be reached must not turn the dashboard
 * into an error page over a strip that is empty most of the time.
 */
export async function readFittingOutbox(fitting: OutboxFitting): Promise<PendingSend[]> {
  try {
    const res = await fetch(new URL("/outbox", fitting.url), {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(OUTBOX_LIST_TIMEOUT_MS)
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { pending?: unknown };
    if (!Array.isArray(body?.pending)) return [];
    return body.pending
      .map((entry) => normalizePending(fitting.fittingId, entry))
      .filter((entry): entry is PendingSend => entry !== null);
  } catch {
    return [];
  }
}

/** Soonest to leave first: that is the one a cancel window is running out on. */
export function bySoonest(a: PendingSend, b: PendingSend): number {
  const at = Date.parse(a.executeAt);
  const bt = Date.parse(b.executeAt);
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
  return a.id.localeCompare(b.id);
}

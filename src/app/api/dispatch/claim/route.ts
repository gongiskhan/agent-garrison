import { NextResponse, type NextRequest } from "next/server";
import { authenticateMachine } from "@/lib/dispatch-machines";
import { readLoadout, renderLoadoutEnv } from "@/lib/loadout";
import type { DispatchJob } from "@/lib/dispatch";
import {
  BoardUnavailableError,
  buildJob,
  claimability,
  patchCard,
  readAllCards,
  selectClaimable,
  DISPATCH_LEASE_SECONDS
} from "@/lib/dispatch";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/dispatch/claim — a worker asks for work.
//
// The bearer token IS the identity. A caller-supplied machine name is never
// trusted: trusting it would let any paired machine claim another's work.
//
// Returns { job: null } when there is nothing to do — the common case, and a
// 200 rather than a 404 so a worker's poll loop does not treat "idle" as an
// error and back off.
export async function POST(request: NextRequest) {
  try {
    const machine = await authenticateMachine(request.headers.get("authorization"));
    if (!machine) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as { workerId?: unknown };
    const workerId = typeof body.workerId === "string" && body.workerId.trim()
      ? body.workerId.trim()
      : "unknown";

    const now = Date.now();
    const cards = await readAllCards();
    const card = selectClaimable(cards, machine, now);
    if (!card) return NextResponse.json({ job: null });

    // Attach the project's Loadout and its vault-rendered .env (D2/D3). The
    // HOST resolves the secrets — with the vault unlocked here — and only the
    // rendered result travels. The vault file and its master key never leave
    // this machine.
    //
    // A missing Loadout is NOT fatal: a stub command needs no project
    // environment. A Loadout that exists but cannot be rendered IS fatal for
    // this claim, because handing a worker a half-environment means it fails
    // deep inside a run instead of before one starts.
    let extra: Partial<DispatchJob> = {};
    if (card.project) {
      const loadout = await readLoadout(card.project).catch(() => null);
      if (loadout) {
        const rendered = await renderLoadoutEnv(loadout);
        if (rendered.missing.length) {
          return NextResponse.json(
            {
              job: null,
              error: "loadout-incomplete",
              cardId: card.id,
              missing: rendered.missing,
              detail: `vault is missing ${rendered.missing.join(", ")} for loadout ${loadout.id}`
            },
            { status: 409 }
          );
        }
        extra = {
          loadout,
          envContent: rendered.content,
          envSources: Object.fromEntries(
            rendered.resolved.filter((r) => r.source).map((r) => [r.name, r.source as string])
          )
        };
      }
    }

    const job = buildJob(card, extra);
    if (!job) {
      // Targeted at this machine but not runnable remotely (no command in v1).
      // Report idle rather than handing over a job the worker cannot execute.
      return NextResponse.json({ job: null, skipped: card.id, reason: "no runnable payload" });
    }

    const nowIso = new Date(now).toISOString();
    const takeover = card.dispatch ? claimability(card, machine, now).reason : "ready";

    // Claim by writing the dispatch record through the board's CAS path. `rev`
    // is the cross-host mutual exclusion: two workers that select the same card
    // both PATCH, and the second is rejected as a conflict.
    const result = await patchCard(card.id, {
      rev: card.rev,
      // Mark the card running so the board shows it as in flight on that
      // machine. The local orphan sweep skips a card with a live dispatch
      // claim, so this cannot be mistaken for a lost local run.
      status: "running",
      runningSince: nowIso,
      dispatch: {
        machine,
        workerId,
        claimedAt: nowIso,
        heartbeatAt: nowIso,
        state: "claimed",
        detail: takeover
      }
    });

    if (!result.ok) {
      // 409 = another worker won the race, or the card moved under us. Idle is
      // the honest answer; the worker polls again.
      if (result.status === 409) return NextResponse.json({ job: null, reason: "claim raced" });
      return NextResponse.json(
        { error: "claim failed", status: result.status, detail: result.body },
        { status: 502 }
      );
    }

    return NextResponse.json({ job, leaseSeconds: DISPATCH_LEASE_SECONDS });
  } catch (error) {
    if (error instanceof BoardUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return jsonError(error, 400);
  }
}

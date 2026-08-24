import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { authenticateMachine } from "@/lib/dispatch-machines";
import { readLoadout, renderLoadoutEnv } from "@/lib/loadout";
import type { ClaimableCard, DispatchJob } from "@/lib/dispatch";
import {
  BoardUnavailableError,
  buildJob,
  claimability,
  patchCard,
  readAllCards,
  selectClaimable,
  reserveDispatchLog,
  readDispatchRuntimeTarget,
  validTransitionsForCard,
  acquireDispatchLease,
  DISPATCH_LEASE_SECONDS
} from "@/lib/dispatch";
import { jsonError } from "@/lib/http";
import { readWorkerView, workerClaimVerdict } from "@/lib/dispatch-workers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function parkPreflightFailure(
  card: ClaimableCard,
  machine: string,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {}
) {
  const at = new Date().toISOString();
  const result = await patchCard(card.id, {
    rev: card.rev,
    list: "needs-attention",
    status: "needs-attention",
    runningSince: null,
    parkedFrom: card.list,
    retryKeepsContext: true,
    attentionKind: "failed",
    attentionReason: `Remote preflight failed for ${machine}: ${detail}`,
    lastDispatchError: { at, reason: code, listId: card.list, message: detail }
  });
  if (!result.ok) {
    return NextResponse.json({
      job: null,
      error: code,
      cardId: card.id,
      detail,
      parked: false,
      parkError: result.body
    }, { status: result.status === 409 ? 409 : 502 });
  }
  return NextResponse.json({ job: null, error: code, cardId: card.id, detail, parked: true, ...extra }, { status: 409 });
}

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
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";

    const now = Date.now();
    const worker = await readWorkerView(machine, now);
    const baselineReadiness = workerClaimVerdict(worker, { machine, workerId });
    if (!baselineReadiness.ok) {
      return NextResponse.json({
        job: null,
        error: baselineReadiness.code,
        detail: baselineReadiness.detail
      }, { status: 409 });
    }
    const cards = await readAllCards();
    const card = selectClaimable(cards, machine, now);
    if (!card) return NextResponse.json({ job: null });

    if (!card.project && card.scope !== "personal" && !card.command) {
      return parkPreflightFailure(
        card,
        machine,
        "remote-project-required",
        "remote agent work needs an explicit project Loadout; only personal-workspace cards and literal smoke commands may run without one"
      );
    }

    // Attach the project's Loadout and its vault-rendered .env (D2/D3). The
    // HOST resolves the secrets — with the vault unlocked here — and only the
    // rendered result travels. The vault file and its master key never leave
    // this machine.
    //
    // Project work is fail-closed: without a Loadout there is no authoritative
    // repo/default-branch/setup/verify contract for another machine. A literal
    // smoke command remains available on a project-less card.
    let extra: Partial<DispatchJob> = {};
    if (card.project) {
      const loadout = await readLoadout(card.project).catch(() => null);
      if (!loadout) {
        return parkPreflightFailure(
          card,
          machine,
          "loadout-missing",
          `project ${card.project} has no Loadout; author and verify one before remote execution`,
          { project: card.project }
        );
      }
      let rendered;
      try {
        rendered = await renderLoadoutEnv(loadout);
      } catch (error) {
        return parkPreflightFailure(
          card,
          machine,
          "loadout-unavailable",
          `Loadout ${loadout.id} could not be rendered: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (rendered.missing.length) {
        return parkPreflightFailure(
          card,
          machine,
          "loadout-incomplete",
          `vault is missing ${rendered.missing.join(", ")} for loadout ${loadout.id}`,
          { missing: rendered.missing }
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

    const validTransitions = await validTransitionsForCard(card);
    if (!validTransitions.length) {
      return parkPreflightFailure(
        card,
        machine,
        "no-valid-transition",
        `the host cannot determine a valid next phase from ${card.list}; the worker will not guess`
      );
    }
    if (!card.command) {
      const runtimeTarget = await readDispatchRuntimeTarget(card);
      if (!runtimeTarget) {
        return parkPreflightFailure(
          card,
          machine,
          "runtime-unresolved",
          `no resolved execution cell exists for ${card.duty || "unrouted"}/${card.level}/${card.list}`
        );
      }
      if (runtimeTarget.runtime !== "agent-sdk" || runtimeTarget.provider !== "anthropic") {
        return parkPreflightFailure(
          card,
          machine,
          "runtime-unsupported",
          `this worker currently advertises only agent-sdk/anthropic; ${runtimeTarget.runtime}/${runtimeTarget.provider || "unknown"} must run on the host or a compatible worker`,
          { runtimeTarget }
        );
      }
      const runtimeKey = `${runtimeTarget.runtime}:${runtimeTarget.provider}`;
      const capability = workerClaimVerdict(worker, { machine, workerId, runtimeKey });
      if (!capability.ok) {
        return parkPreflightFailure(card, machine, capability.code, capability.detail, { runtimeTarget });
      }
      extra = { ...extra, runtimeTarget };
    }
    const runId = randomUUID();
    const routingToken = randomUUID();
    const logIndex = await reserveDispatchLog(card.id);
    const claimRevision = card.rev + 1;
    const job = buildJob(card, { ...extra, runId, routingToken, logIndex, validTransitions, claimRevision });
    if (!job) {
      // Targeted at this machine but not runnable remotely (no command in v1).
      // Report idle rather than handing over a job the worker cannot execute.
      return NextResponse.json({ job: null, skipped: card.id, reason: "no runnable payload" });
    }

    const nowIso = new Date(now).toISOString();
    const takeover = card.dispatch ? claimability(card, machine, now).reason : "ready";

    // Take the card's dispatch lease BEFORE writing the claim. Not granted means
    // a live holder still owns it, and idle is the honest answer. The grant's
    // monotonic fence rides onto the card, so a holder that stalls past its
    // lease and wakes up is refused by the store rather than by a pid probe.
    const lease = await acquireDispatchLease(card.id, `${machine}/${workerId || "worker"}`);
    if (!lease) return NextResponse.json({ job: null, reason: "claim lease held" });

    // Claim by writing the dispatch record through the board's CAS path. `rev`
    // is the cross-host mutual exclusion: two workers that select the same card
    // both PATCH, and the second is rejected as a conflict.
    const result = await patchCard(card.id, {
      rev: card.rev,
      leaseFence: lease.fence,
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
        detail: takeover,
        runId,
        routingToken,
        phase: card.list,
        logIndex,
        claimRevision,
        leaseFence: lease.fence,
        leaseToken: lease.holderToken,
        leaseExpiresAt: lease.expiresAt
      },
      // Persist the read-time compatibility migration. Explicit placement is
      // now the only remote mechanism; the board projection no longer carries
      // contradictory `outpost` affinity.
      placement: card.placement,
      outpost: null
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

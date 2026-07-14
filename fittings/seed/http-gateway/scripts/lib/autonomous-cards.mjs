// autonomous-cards.mjs — D19: "EVERY task-shaped turn is a card."
//
// The ONE gateway↔board card client, shared by BOTH gateway entries:
//   - gateway-pty.mjs (PTY routing mode) via the RoutedGateway wrappers in
//     gateway-routing.mjs, and
//   - gateway.mjs (orchestrator + souls mode) via CardRegistrar.
//
// Every function takes its dependencies explicitly (buildPayload, logFn) and
// resolves them at CALL time, so a RoutedGateway created off the prototype in
// tests (autonomous-card-retry.test.ts) keeps working without a constructor.
//
// Board discovery follows the URL-link contract: the kanban-loop status file
// under ~/.garrison/ui-fittings, never a hardcoded port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// D19: a turn is "task-shaped" (worth a card) when its task type names real
// work — code / research / writing / image / video / ops, plus `implement`:
// the classifier's vocabulary includes the pipeline verbs, and a channel ask
// like "add a helper with tests" lands on code OR implement depending on the
// classifier's mood — both mean "build this". Excluding implement made the
// same message card one time and run inline the next (seen live), and was
// inconsistent with isSignificantAutonomous, which already counts it as
// significant. Plain conversation (`other`) and review verbs stay un-carded
// ("review this diff" is an inline ask — rev-s2 finding). Matches RUN_SPEC A14.
export const TASK_SHAPED = new Set(["code", "implement", "research", "writing", "image", "video", "ops"]);

export function isTaskShaped(classification) {
  return !!classification && TASK_SHAPED.has(classification.taskType);
}

// Channels whose turns are already cards (the engine's own dispatches) or
// system beats — never re-carded by the gateway.
export const CARD_ORIGINATED_CHANNELS = new Set(["kanban", "scheduler", "board", "garrison", "heartbeat"]);

export function isCardOriginatedChannel(channel) {
  return CARD_ORIGINATED_CHANNELS.has(String(channel || "").toLowerCase());
}

// Deterministic fallback classifier for souls mode, which has no warm LLM
// classifier session. Mirrors heuristicClassify in the orchestrator fitting's
// scripts/lib/router-core.mjs (kept in sync by tests/gateway-souls-cards.test.ts).
// The keyword-exception fast-path (classifyByKeywords, gateway-routing.mjs)
// runs FIRST at the call site; this is the everything-else fallback.
export function heuristicClassify(prompt) {
  const text = String(prompt || "");
  const lower = text.toLowerCase();
  let taskType = "other";
  if (/\b(review|diff|pr|pull request)\b/.test(lower)) taskType = "review";
  else if (/\b(research|find|latest|source|cite)\b/.test(lower)) taskType = "research";
  else if (/\b(image|photo|picture|render|illustration)\b/.test(lower)) taskType = "image";
  else if (/\b(video|walkthrough|recording)\b/.test(lower)) taskType = "video";
  else if (/\b(write|draft|copy|email|doc)\b/.test(lower)) taskType = "writing";
  else if (/\b(deploy|ops|cron|incident|server|scheduler)\b/.test(lower)) taskType = "ops";
  else if (/\b(code|implement|fix|test|bug|refactor|typescript|python|api|add|build|create|update|change)\b/.test(lower)) taskType = "code";
  const tier =
    text.length < 120 && !/\b(deep|architecture|migration|end-to-end|e2e|full)\b/.test(lower)
      ? "T0-trivial"
      : /\b(deep|architecture|migration|security|full|e2e|end-to-end|critical)\b/.test(lower) || text.length > 1200
        ? "T2-deep"
        : "T1-standard";
  return { taskType, tier, matchedException: null };
}

// Resolve the board's base URL from the kanban-loop status file. Returns the
// base URL or null (board down / not installed).
export function boardBase(garrisonHome) {
  try {
    const home = garrisonHome || process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const statusFile = path.join(home, "ui-fittings", "kanban-loop.json");
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    return status.url || `http://127.0.0.1:${status.port}`;
  } catch {
    return null;
  }
}

// D19: register a turn as a card on the board (POST + engine-context move,
// exactly as the engine does — x-garrison-engine). The default lands the card
// in Plan so the run engine dispatches it (significant work); a quick card
// (opts.quick) lands in Implement and carries quick:true, and the caller
// auto-advances it to Done at turn completion (completeQuickCard). Returns
// {id, url} or null (board down / not installed → the caller falls back
// inline; never hard-blocks).
export async function createAutonomousCard({ message, classification, opts = {}, buildPayload = null, logFn = () => {} }) {
  const targetList = opts.targetList ?? "plan";
  try {
    const base = boardBase();
    if (!base) throw new Error("kanban-loop status file not found");
    const payload = buildPayload
      ? buildPayload({
          brief: message,
          project: opts.project ?? null,
          workKind: opts.workKind ?? null,
          phases: opts.phases ?? null,
          taskType: classification?.taskType,
          tier: classification?.tier,
          // S4b door-1 persistence (D15 acceptance 9): carry the resolved
          // (duty, level, sequence) from the dispatch result onto the card so a
          // web-channel/skill-entered card FLOWS through the identical resolved
          // sequence a board card would. Additive — absent when no dispatcher.
          duty: opts.duty,
          level: opts.level,
          sequence: opts.sequence,
          originChannel: opts.originChannel ?? null,
          // S3d (D9b): the dispatcher's clarity verdict - a needs-discuss card is
          // carded onto the interactive Discuss list (targetList) and stamped so
          // the engine dispatches the discuss duty session.
          clarity: opts.clarity ?? null
        })
      : { description: message, goalMode: true, originChannel: opts.originChannel ?? null, ...(opts.clarity === "needs-discuss" ? { clarity: "needs-discuss" } : {}) };
    if (opts.quick) payload.quick = true; // D19: mark trivial-plan cards for the Done quick-tasks strip
    if (opts.continues) payload.continues = opts.continues; // S3b: a post-done follow-up is a continuation card
    const created = await fetch(`${base}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!created.ok) throw new Error(`board POST /cards → ${created.status}`);
    const card = await created.json();
    const id = card.id || card.card?.id;
    if (!id) throw new Error("board POST /cards returned no id");
    // Move to the target list (engine-context move). The rev from the create
    // response goes STALE almost immediately for no-project cards (the board
    // fires project inference fire-and-forget, whose first act bumps the rev) —
    // so on ANY failed move, re-GET the card for a fresh rev and retry, up to 3
    // times. A card left in Backlog would be silently stranded (Backlog is a
    // manual list, never auto-dispatched), which is exactly the failure the
    // retry exists to prevent.
    let rev = card.rev ?? card.card?.rev ?? 0;
    let movedOk = false;
    for (let attempt = 0; attempt < 3 && !movedOk; attempt++) {
      const moved = await fetch(`${base}/cards/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
        body: JSON.stringify({ list: targetList, rev })
      });
      if (moved.ok) { movedOk = true; break; }
      logFn({ kind: "autonomous-card-move-retry", id, attempt, status: moved.status });
      // refresh the rev (409 = changed under us; anything else → re-read too)
      try {
        const fresh = await fetch(`${base}/cards/${id}`);
        if (fresh.ok) {
          const doc = await fresh.json();
          rev = doc.card?.rev ?? doc.rev ?? rev;
          const list = doc.card?.list ?? doc.list;
          if (list === targetList) { movedOk = true; break; } // someone already moved it
        }
      } catch { /* retry with the old rev */ }
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
    if (!movedOk) {
      // The run would be invisible on a manual list — surface the failure to
      // the caller instead of claiming success.
      throw new Error(`board move to ${targetList} failed after retries (card ${id} left in backlog)`);
    }
    const url = `${base}/#/cards/${id}`;
    logFn({ kind: "autonomous-card-created", id, url, list: targetList, quick: opts.quick === true, taskType: classification?.taskType, tier: classification?.tier });
    return { id, url };
  } catch (err) {
    logFn({ kind: "autonomous-card-failed", error: err?.message });
    return null;
  }
}

// D19: a quick card runs inline; at turn completion the gateway advances it
// Implement → Done (engine-context move). Re-GET for a fresh rev and retry the
// move — the board bumps the rev under us the same way it does on create.
// Returns true when the card reaches Done. Never throws (a stranded quick card
// is a visible board state, not a turn failure).
export async function completeQuickCard({ id, logFn = () => {} }) {
  try {
    const base = boardBase();
    if (!base || !id) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let rev = 0;
      try {
        const fresh = await fetch(`${base}/cards/${id}`);
        if (fresh.ok) {
          const doc = await fresh.json();
          rev = doc.card?.rev ?? doc.rev ?? 0;
          if ((doc.card?.list ?? doc.list) === "done") return true; // already there
        }
      } catch { /* fall through with rev 0 */ }
      const moved = await fetch(`${base}/cards/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
        body: JSON.stringify({ list: "done", rev })
      });
      if (moved.ok) {
        logFn({ kind: "quick-card-done", id });
        return true;
      }
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
    logFn({ kind: "quick-card-done-failed", id });
    return false;
  } catch (err) {
    logFn({ kind: "quick-card-done-failed", id, error: err?.message });
    return false;
  }
}

// D19 (assumption 2): the reply that finished a quick turn is EMPTY (nothing but
// whitespace) → the inline run produced nothing, which is a FAILURE, not a pass.
export function isEmptyQuickReply(reply) {
  return !(typeof reply === "string" ? reply : String(reply ?? "")).trim();
}

// The quick-path empty-output FAILURE CONTRACT copy — same discipline as the
// engine's: NEVER claims success ("completed"/"done"/"success" are banned), and
// marks the card for a re-run. The quick path runs inline in the gateway (no
// engine iteration log), so the empty reply itself IS the evidence.
export function quickEmptyFailureReason() {
  return (
    "This quick task returned no output — the inline run produced nothing verifiable, " +
    "so there is no result to show. An empty reply is a FAILURE, not a pass: it was routed " +
    "to needs-attention rather than advanced. Move it back to retry — add a description or " +
    "more detail if the task was underspecified."
  );
}

// D19: an empty (or otherwise failed) quick turn must NOT advance to Done — route
// the card to needs-attention (a real list move, engine-context) carrying the
// failure-contract reason. Mirrors completeQuickCard's rev-refresh retry; never
// throws (a stranded quick card is a visible board state, not a turn failure).
// NOTE: the board's PATCH handler must honor `attentionReason`/`parkedFrom` on an
// engine-context move into needs-attention for the reason to persist on the card;
// the move itself (list → needs-attention) works regardless.
export async function parkQuickCard({ id, reason, parkedFrom = "implement", logFn = () => {} }) {
  try {
    const base = boardBase();
    if (!base || !id) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let rev = 0;
      try {
        const fresh = await fetch(`${base}/cards/${id}`);
        if (fresh.ok) {
          const doc = await fresh.json();
          rev = doc.card?.rev ?? doc.rev ?? 0;
          if ((doc.card?.list ?? doc.list) === "needs-attention") return true; // already parked
        }
      } catch { /* fall through with rev 0 */ }
      const moved = await fetch(`${base}/cards/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
        body: JSON.stringify({ list: "needs-attention", parkedFrom, attentionReason: reason, rev })
      });
      if (moved.ok) {
        logFn({ kind: "quick-card-parked", id, reason });
        return true;
      }
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
    logFn({ kind: "quick-card-park-failed", id });
    return false;
  } catch (err) {
    logFn({ kind: "quick-card-park-failed", id, error: err?.message });
    return false;
  }
}

// S3d (D9b, review R3): move a card to `targetList` as an ENGINE-context PATCH
// (x-garrison-engine), rev-refresh retry like completeQuickCard. Used by the gateway's
// explicit-go resume (Move a held-in-Discuss card to plan) and any gateway-driven move.
// Returns true when the card reaches the target list; never throws.
export async function moveCardEngine({ id, targetList, logFn = () => {} }) {
  try {
    const base = boardBase();
    if (!base || !id || !targetList) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let rev = 0;
      try {
        const fresh = await fetch(`${base}/cards/${id}`);
        if (fresh.ok) {
          const doc = await fresh.json();
          rev = doc.card?.rev ?? doc.rev ?? 0;
          if ((doc.card?.list ?? doc.list) === targetList) return true; // already there
        }
      } catch { /* fall through with rev 0 */ }
      const moved = await fetch(`${base}/cards/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
        body: JSON.stringify({ list: targetList, rev })
      });
      if (moved.ok) {
        logFn({ kind: "card-moved", id, targetList });
        return true;
      }
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
    logFn({ kind: "card-move-failed", id, targetList });
    return false;
  } catch (err) {
    logFn({ kind: "card-move-failed", id, targetList, error: err?.message });
    return false;
  }
}

// S3b: the board's cards for one origin (GET /cards?origin_id=…), most recent first.
// A fetch failure / board-down returns [] (caller registers fresh).
export async function cardsByOrigin(origin_id) {
  try {
    const base = boardBase();
    if (!base || !origin_id) return [];
    // 3s bound: this runs inside the serialized turn chain, so a HUNG (not
    // down) board must not stall queued turns behind it.
    const r = await fetch(`${base}/cards?origin_id=${encodeURIComponent(origin_id)}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return [];
    const doc = await r.json();
    return Array.isArray(doc.cards) ? doc.cards : [];
  } catch {
    return [];
  }
}

// True only when the card is STILL an active engine run: it exists and sits on
// a non-terminal, non-parked pipeline list with no abandonment revert prepared.
// A fetch failure counts as NOT live (safe: the caller registers fresh).
export async function cardIsLive(cardId) {
  try {
    const base = boardBase();
    if (!base || !cardId) return false;
    const r = await fetch(`${base}/cards/${cardId}`);
    if (!r.ok) return false; // absent / deleted
    const doc = await r.json();
    const card = doc.card ?? doc;
    const list = card.list;
    if (!list || list === "done" || list === "needs-attention") return false; // terminal / parked
    if (card.preparedRevert) return false; // abandoned (revert prepared)
    return true;
  } catch {
    return false;
  }
}

// Souls-mode card surface: the same D19 semantics gateway-pty implements via
// RoutedGateway, packaged for gateway.mjs. Owns the per-conversation card
// memory (session key → live card) with the same liveness-gated attach.
export class CardRegistrar {
  constructor({ buildPayload = null, logFn = () => {} } = {}) {
    this.buildPayload = buildPayload;
    this.logFn = logFn;
    this._sessionCards = new Map(); // sessionKey -> { cardId, quick, taskType }
  }

  async createAutonomousCard(message, classification, opts = {}) {
    return createAutonomousCard({ message, classification, opts, buildPayload: this.buildPayload, logFn: this.logFn });
  }

  async completeQuickCard(id) {
    return completeQuickCard({ id, logFn: this.logFn });
  }

  // D19: route a failed/empty quick card to needs-attention instead of Done.
  async parkQuickCard(id, reason) {
    return parkQuickCard({ id, reason, logFn: this.logFn });
  }

  // D19 session→card memory, liveness-gated (S7 review F1): a stale card
  // (done / parked / abandoned / absent) is forgotten so a genuinely new
  // same-type turn registers fresh instead of attaching to a corpse.
  async attachedCard(sessionKey, classification) {
    if (!sessionKey) return null; // no conversation identity → never attach (F1c)
    const entry = this._sessionCards.get(sessionKey);
    if (!entry) return null;
    if (classification && entry.taskType && entry.taskType !== classification.taskType) return null;
    if (!(await cardIsLive(entry.cardId))) {
      this.forgetCard(sessionKey);
      return null;
    }
    return entry;
  }

  rememberCard(sessionKey, entry) {
    if (sessionKey) this._sessionCards.set(sessionKey, entry);
  }

  forgetCard(sessionKey) {
    if (sessionKey) this._sessionCards.delete(sessionKey);
  }
}

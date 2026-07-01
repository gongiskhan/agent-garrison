// Kanban Loop engine (V1b) — the transition function.
//
// A manual list is a plain column. An AGENT list has a named skill + execute-prompt
// + router-prompt: on entry the engine sends the combined prompt through the
// orchestrator front door (a runFn injected by the caller = preRoute / gateway
// /chat), then the router output must EXACTLY name one of the card's valid next
// lists (brief §3: no fuzzy matching, no guessing) or the card parks in
// needs-attention. §9 decisions applied: effort/model are the router's job (NOT set
// per list); the router's continuations are suppressed (the list boundary is the
// gate); there is no Infer column (low-confidence inference → needs-attention). §10:
// each agent-list carries an explicit {taskType, tier} fed to preRoute. Goal-mode
// prepends /goal + the card's acceptance (the engine adds the prefix; execute-prompts
// stay clean) — but the convergence GUARD is the per-card iteration cap, not the goal
// hook (FINDING 5 / Decision 7: the goal-stop sentinel never fires on the shared
// board operative). A per-card iteration-cap breach parks the card in needs-attention.
//
// V1b adds: per-card runId minted on the FIRST agent-list entry (FINDING 4) and the
// run directory threaded into EVERY execute-prompt as literal text (FINDING 4/10 — the
// gateway `skill` field is inert, so the run dir must be IN the prompt); the three
// triggers (immediate | manual | scheduler-beat) so tick() only processes immediate
// agent lists; and Test batching (FINDING 7) — one session per project on the test
// list's own scheduler beat.
import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { saveCard, saveCardCAS, appendCardLog, writeCardLog } from "./board.mjs";
import { ulid } from "./ulid.mjs";

// Does this card's run dir actually contain tangible evidence? A list flagged
// `requiresEvidence` (Walkthrough) must not advance on the operative's word alone — the
// "ALWAYS write evidence" instruction is self-attested, so we VERIFY it on disk:
// <cwd>/<runDir>/evidence/ must hold at least one regular file (a screenshot or
// evidence.md). Read-only + best-effort: any error → treated as no evidence.
export function hasEvidence(cwd, runDir) {
  if (!runDir || typeof runDir !== "string") return false;
  try {
    const dir = path.resolve(cwd || process.cwd(), runDir, "evidence");
    if (!existsSync(dir)) return false;
    return readdirSync(dir, { withFileTypes: true }).some((d) => d.isFile());
  } catch {
    return false;
  }
}

// Read the Discuss brief a card links (card.briefPath), so the discussion's RESULT
// becomes context for the downstream phases (plan/implement/…). The brief path is set
// by the server (recordBrief / the Move-out-of-Discuss auto-link) and is project-
// relative; we confine the read to the project root (cwd) defensively, require a
// regular readable file, and cap the size so a huge brief can't blow up the prompt.
// Best-effort: any miss returns null and the prompt simply omits the section.
export function readBriefContext(cwd, briefPath, max = 6000) {
  if (!briefPath || typeof briefPath !== "string") return null;
  try {
    const base = path.resolve(cwd || process.cwd());
    const abs = path.resolve(base, briefPath);
    if (abs !== base && !abs.startsWith(base + path.sep)) return null; // confine to cwd
    if (!existsSync(abs)) return null;
    const text = readFileSync(abs, "utf8").trim();
    if (!text) return null;
    return text.length > max ? text.slice(0, max).trimEnd() + "\n\n…(brief truncated)" : text;
  } catch {
    return null;
  }
}

// Read the CARD-OWNED Discuss brief (<root>/cards/<id>/brief.md) — the deterministic
// location James is told (an absolute path) to write to during Discuss. Best-effort +
// size-capped: a miss returns null and the prompt simply omits the brief section.
export function readCardBrief(root, cardId, max = 6000) {
  if (!root || !cardId || typeof cardId !== "string") return null;
  try {
    const abs = path.join(root, "cards", cardId, "brief.md");
    if (!existsSync(abs)) return null;
    const text = readFileSync(abs, "utf8").trim();
    if (!text) return null;
    return text.length > max ? text.slice(0, max).trimEnd() + "\n\n…(brief truncated)" : text;
  } catch {
    return null;
  }
}

const AGENT_KIND = "agent";

// Project-relative run-directory root the autothing skills already write under.
const RUN_DIR_BASE = "docs/autothing/runs";

export function getList(board, listId) {
  return (board.lists || []).find((l) => l.id === listId) || null;
}

export function validNextFor(board, listId) {
  const list = getList(board, listId);
  return Array.isArray(list?.validNext) ? list.validNext : [];
}

// A list's trigger decides WHO advances a card off it: `immediate` agent lists fire on
// entry via tick(); `scheduler-beat` lists fire only on their own beat (Test); `manual`
// lists (and interactive lists) are advanced by hand. Default to immediate for any
// agent list that omits a trigger (the V1a lists carried none), manual otherwise.
export function triggerFor(list) {
  if (list?.trigger) return list.trigger;
  return list?.kind === AGENT_KIND ? "immediate" : "manual";
}

// An interactive list (e.g. Discuss) is never auto-dispatched: the board opens the
// web chat and the human advances it manually.
export function isInteractive(list) {
  return Boolean(list?.interactive);
}

// Mint a runId + runDir for a card iff it does not have one yet. Called when a card
// first enters an agent list (Start → plan). runDir is project-relative so the same
// pointer is valid from any working dir the skill resolves against (FINDING 4/10).
export function mintRunFields(card, now = Date.now) {
  if (card.runId && card.runDir) return null; // already minted — idempotent
  const runId = ulid(typeof now === "function" ? now() : now);
  return { runId, runDir: `${RUN_DIR_BASE}/${runId}` };
}

// Tier/taskType are NO LONGER pinned per list (the user's call): a kanban card routes
// through the orchestrator, which CLASSIFIES the work itself (picks tier/model/effort)
// from the prompt — the per-list `mode` still biases that routing. So the engine sends
// NO classification hint (see the `classification = null` at the dispatch sites + the
// note in lib/gateway-client.mjs). Retained, unused by dispatch, only so an external
// caller/test that still wants the old {taskType,tier} projection can derive it.
export function classificationFor(list) {
  return { taskType: list?.taskType || "other", tier: list?.tier || "T1-standard" };
}

export const ATTENTION_LIST = "needs-attention";

// ── execution timeline (FINDING: visibility) ─────────────────────────────────
//
// A card carries a capped, append-only `events` array — a human-readable timeline
// of WHAT HAPPENED to it (dispatched, replied, routed, parked, deferred, failed,
// inferred). This is the spine of "what is happening with the executions": every
// transition the engine makes records a timestamped event with a plain-language
// message (and optional `detail`, e.g. the operative's actual reply), so the UI can
// show a real activity feed instead of a silent colored dot + a cryptic park line.
export const MAX_EVENTS = 60;

// Append an event to a card's timeline, returning the NEW capped events array
// (never mutates the input — the card is rewritten CAS-safely by the caller). Keep
// the most recent MAX_EVENTS so a long-lived card's history stays bounded.
export function withEvent(card, event, max = MAX_EVENTS) {
  const events = Array.isArray(card?.events) ? card.events.slice() : [];
  events.push(event);
  return events.length > max ? events.slice(events.length - max) : events;
}

// A short, single-snippet projection of the operative's reply for the card front +
// the park event detail (the full reply lives in the iteration log; this is the
// "what it actually said" the user sees without digging). Collapses whitespace runs
// so a multi-line reply reads on one card line; the detail keeps newlines.
export function replySnippet(reply, max = 280) {
  const text = String(reply ?? "").trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
}

// Park a card in the needs-attention COLUMN (a real list move, not just a status
// flag) so stuck work LEAVES the pipeline and shows up where the user looks for it —
// carrying WHY it parked (attentionReason) and WHERE it came from (parkedFrom) so the
// board can show the reason + send it back. Moving a card OUT of needs-attention
// (board PATCH) clears these + resets the iteration count for a clean retry.
export function parkFields(card, fromList, reason) {
  return {
    list: ATTENTION_LIST,
    status: "needs-attention",
    parkedFrom: fromList ?? card.parkedFrom ?? null,
    attentionReason: reason
  };
}

// Parse the router's chosen next list. Takes the last non-empty line (the
// router-prompt convention is to end with the verdict) and EXACT-matches it against
// the valid next list ids. No match → null (→ needs-attention).
export function parseNextList(routerOutput, validNext) {
  const text =
    typeof routerOutput === "string" ? routerOutput : routerOutput?.reply ?? routerOutput?.text ?? "";
  // The operative's verdict (a bare next-list id at the end of its reply) gets HIDDEN by
  // gateway STATUS BADGES the gateway appends AFTER it — "[route: cc-sonnet-med | … ]",
  // "[orchestrator-active]". Those land on their own line SOMETIMES, but the xterm
  // screen-reader also reflows long replies, so the badges + the verdict frequently end
  // up FLOWED onto one line: "… Gate green. [route: …] [orchestrator-active] implement".
  // Strip every "[…]" badge span first, then look for the verdict — still EXACT-matching
  // against validNext (no fuzzy/substring guessing): (1) a clean whole-line match from the
  // bottom, then (2) the LAST bare token of the cleaned reply (the "end with the token"
  // convention), trailing punctuation trimmed. (2) is what rescues a verdict flowed onto a
  // prose/badge line — the exact case where a CORRECT verdict was being parked.
  const cleaned = String(text).replace(/\[[^\]\n]*\]/g, " ");
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (validNext.includes(lines[i])) return lines[i];
  }
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/^[^A-Za-z0-9-]+|[^A-Za-z0-9-]+$/g, ""))
    .filter(Boolean);
  const last = tokens.length ? tokens[tokens.length - 1] : "";
  return validNext.includes(last) ? last : null;
}

// Combined execute + router prompt. goal-mode prepends /goal + acceptance; the card's
// runDir is threaded in as literal text (the gateway `skill` field is inert, so the
// run dir must be IN the prompt for the autothing skill to write per-run — FINDING
// 4/10); the valid next-list ids are injected so the router output can exact-match.
export function buildCardPrompt({ list, card, validNext, discussionContext = null }) {
  const parts = [];
  // Lead with the list's MODE so the gateway's mode resolver switches the operative's
  // face (Gary/Joe/James) for this turn. The per-list mode is otherwise inert — the
  // kanban channel has no mode default, so it falls back to the global default. The
  // gateway's parseLeadingMode matches a mode name at the VERY START of the message,
  // so this clause must come before /goal and the work item. Harmless if the gateway
  // ignores it (it just reads as an addressing line to the operative).
  const mode = (list?.mode || "").trim();
  if (mode && list.kind === AGENT_KIND) {
    parts.push(`${mode}, take on the following work item.`, "");
  }
  if (card.goalMode && list.kind === AGENT_KIND) {
    const acceptance = card.acceptance || card.description || "(lift acceptance from FLOW_PLAN.md)";
    parts.push(`/goal ${acceptance}`, "");
  }
  // THE work item itself. Without this the operative is told to "plan/implement this
  // card" but is never told WHAT the card is — it has no title, no description, no
  // project, so it produces nothing and the card parks for "no valid next list" (the
  // exact failure the user hit). Always include the title; the project (or an explicit
  // "infer it" note when absent); and the description when present. This is the task.
  parts.push(`# Work item: ${card.title || "(untitled)"}`);
  parts.push(
    card.project
      ? `Project: ${card.project}`
      : `Project: (none assigned — infer the target project/repository from the description below, or work in the current repository)`
  );
  if (card.description && card.description.trim()) {
    parts.push("", card.description.trim());
  }
  // The Discuss step's RESULT (the brief James wrote) — the agreed direction the
  // downstream phases must build from. Injected verbatim so plan/implement/review have
  // the decisions/approach/open-questions/acceptance the discussion settled on.
  if (discussionContext && String(discussionContext).trim()) {
    parts.push(
      "",
      "## Discussion (decided in the Discuss step — this is the agreed direction; build from it)",
      "",
      String(discussionContext).trim()
    );
  }
  parts.push("");
  // Thread the per-run pointers so the autothing skill writes its plan/gate files
  // under this card's run dir and references this card's slice — the skill cannot get
  // these from the inert gateway fields, so they go in the prompt body.
  if (card.runDir) {
    parts.push(`Run directory (write all per-run artifacts here): ${card.runDir}`);
    if (card.sliceId) parts.push(`Slice id: ${card.sliceId}`);
    parts.push("");
  }
  if (list.executePrompt) parts.push(list.executePrompt, "");
  parts.push(
    // Strict exact-match routing is by design (no fuzzy matching), so the operative
    // MUST emit the verdict token — and crucially must still CHOOSE a next list when
    // the work turns out already-done/clean, instead of explaining "nothing to do"
    // (which parks an effectively-finished card). Spell both out.
    `When done, you MUST choose the next list. Even if the work was already complete, ` +
      `clean, or there was nothing left to do, still pick the appropriate FORWARD list — ` +
      `do not explain instead of choosing. Your reply MUST end with the chosen list id on ` +
      `its OWN FINAL LINE, as a bare token (no prose on that line), EXACTLY one of: ${validNext.join(", ")}.`
  );
  if (list.routerPrompt) parts.push("", list.routerPrompt);
  return parts.join("\n");
}

// Run ONE transition for a card on an agent list. runFn dispatches the prompt
// through the orchestrator (preRoute) and returns { reply }. Returns the updated
// card + an outcome ({status: moved|needs-attention|skipped, ...}).
export async function processCard({ root, board, card, runFn, cap = 10, now = () => new Date().toISOString(), cwd = process.cwd() }) {
  const list = getList(board, card.list);
  // An interactive list (Discuss — kind "agent-interactive") is never auto-dispatched:
  // the board opens the web chat and the human advances manually. Checked before the
  // agent-kind guard so it reports `interactive`, not `not-an-agent-list`.
  if (isInteractive(list)) {
    return { card, outcome: { status: "skipped", reason: "interactive" } };
  }
  if (!list || list.kind !== AGENT_KIND) {
    return { card, outcome: { status: "skipped", reason: "not-an-agent-list" } };
  }
  // A human label for the list, used in every event/park message so the timeline reads
  // "Plan", not "plan".
  const listTitle = list.title || card.list;
  // Every write is a compare-and-swap against the rev we read, so a concurrent tick or
  // a manual edit cannot be silently overwritten (lost update).
  const baseRev = card.rev ?? 0;
  if ((card.iterations || 0) >= cap) {
    const capReason = `Hit the iteration cap on ${listTitle} (${cap} runs without choosing a valid next step). Parked so it stops looping — move it back to retry, or open it to see why it kept failing.`;
    const res = await saveCardCAS(
      root,
      {
        ...card,
        ...parkFields(card, card.list, capReason),
        lastDispatchError: null,
        events: withEvent(card, { at: now(), kind: "parked", message: `Parked from ${listTitle}: iteration cap (${cap})`, detail: capReason })
      },
      baseRev,
      now()
    );
    if (!res.ok) return { card: res.card, outcome: { status: "skipped", reason: "conflict" } };
    return { card: res.card, outcome: { status: "needs-attention", reason: "iteration-cap" } };
  }

  const validNext = validNextFor(board, card.list);
  const iteration = (card.iterations || 0) + 1;
  // Mint runId + runDir on the card's FIRST agent-list entry, and fold the mint into
  // the SAME acquire write so it is persisted CAS-safely (no extra write, no race).
  const minted = mintRunFields(card, () => Date.parse(now()) || Date.now());
  // Acquire the card: CAS the running-status write (+ run fields if just minted). A
  // second concurrent tick fails the CAS here and skips, so a card is never processed
  // twice and the runId is never minted twice.
  const dispatchAt = now();
  const dispatchEvent = {
    at: dispatchAt,
    kind: "dispatch",
    message: `Dispatched to the operative on ${listTitle}${list.skill ? ` (${list.skill})` : ""} — run ${iteration}`,
    detail: card.project ? null : "No project assigned — the operative is asked to infer it from the description."
  };
  const acq = await saveCardCAS(
    root,
    {
      ...card,
      ...(minted || {}),
      status: "running",
      iterations: iteration,
      // When this run STARTED, so the UI can show a live "running 1:23" elapsed timer
      // (cleared/replaced on the terminal write below).
      runningSince: dispatchAt,
      events: withEvent(card, dispatchEvent)
    },
    baseRev,
    now()
  );
  if (!acq.ok) return { card: acq.card, outcome: { status: "skipped", reason: "conflict" } };
  const runningCard = acq.card;
  const runRev = runningCard.rev;

  // Fold the Discuss brief (if any) into the prompt so every downstream phase builds
  // from the agreed direction the discussion settled on.
  const discussionContext = readCardBrief(root, runningCard.id);
  const prompt = buildCardPrompt({ list, card: runningCard, validNext, discussionContext });
  // No classification hint: route through the orchestrator and let IT classify the
  // work (tier/model/effort). The per-list mode (led into the prompt above) biases it.
  const classification = null;
  // Live log: write the iteration header immediately (Watch shows the run STARTED,
  // not a blank pane), then overwrite the log with the operative's growing reply as
  // chunks stream in — so Watch shows progress instead of nothing-until-the-result.
  await writeCardLog(root, card.id, iteration, `# iteration ${iteration}\n\n_dispatching to the operative…_\n`);
  const onChunk = (full) => {
    void writeCardLog(root, card.id, iteration, `# iteration ${iteration}\n${full}\n`).catch(() => {});
  };
  let out;
  try {
    out = await runFn({ prompt, card: runningCard, list, classification, suppressContinuations: true, onChunk });
  } catch (err) {
    // A TRANSPORT failure (gateway unreachable / restarting — err.transport from the
    // gateway client) is NOT the card's fault: REVERT the acquire (back to the prior
    // status, iteration un-consumed) so the run retries on the next tick/Start once the
    // gateway is back — never strand the card in needs-attention. Any other failure (a
    // real error from a booted gateway) is a genuine run failure and parks.
    if (err?.transport) {
      await appendCardLog(root, card.id, iteration, `# iteration ${iteration}\ngateway unavailable (deferred, will retry): ${err?.message || err}\n`);
      // Persist a one-line reason on the card so the UI can render "gateway
      // unavailable — retry" instead of looking ok. lastDispatchError is a
      // plain JSON field (file-per-card storage tolerates extra keys); cleared
      // on the next successful run.
      const reverted = {
        ...runningCard,
        status: card.status ?? "ok",
        iterations: card.iterations || 0,
        runningSince: null,
        lastDispatchError: {
          at: now(),
          reason: "gateway-unavailable",
          listId: card.list,
          message: String(err?.message || err)
        },
        events: withEvent(runningCard, {
          at: now(),
          kind: "deferred",
          message: `Gateway unavailable on ${listTitle} — left in place, will retry`,
          detail: String(err?.message || err)
        })
      };
      const res = await saveCardCAS(root, reverted, runRev, now());
      return { card: res.card ?? runningCard, outcome: { status: "deferred", reason: "gateway-unavailable", error: String(err?.message || err) } };
    }
    await appendCardLog(root, card.id, iteration, `# iteration ${iteration}\nrun failed: ${err?.message || err}\n`);
    const failReason = `The ${listTitle} run errored: ${String(err?.message || err)}. Parked so you can see the failure — open the log for details, then move it back to retry.`;
    const res = await saveCardCAS(root, {
      ...runningCard,
      ...parkFields(runningCard, card.list, failReason),
      runningSince: null,
      lastReply: replySnippet(String(err?.message || err)),
      lastDispatchError: {
        at: now(),
        reason: "run-failed",
        listId: card.list,
        message: String(err?.message || err)
      },
      events: withEvent(runningCard, {
        at: now(),
        kind: "failed",
        message: `Run errored on ${listTitle}`,
        detail: String(err?.message || err)
      })
    }, runRev, now());
    return { card: res.card ?? runningCard, outcome: { status: "needs-attention", reason: "run-failed", error: String(err?.message || err) } };
  }

  const reply = out?.reply ?? out?.text ?? String(out ?? "");
  // Final clean log (overwrites any partial live-streamed content with the
  // authoritative reply the operative returned).
  await writeCardLog(root, card.id, iteration, `# iteration ${iteration}\n${reply}\n`);

  const replyText = String(reply ?? "").trim();
  let snippet = replySnippet(replyText);
  let next = parseNextList(reply, validNext);
  // VERDICT NUDGE (robustness backstop). A heavy skill (walkthrough, validate) often ends
  // its turn NARRATING the action ("Writing the durable gate record now.") or returns
  // empty — so the verdict token never lands and a CORRECT run parks. Rather than
  // whack-a-mole the prompt of every gate, give the operative ONE focused follow-up that
  // asks for nothing but the token, in the same session (so it answers from the work it
  // just did). This is bounded (a single retry, not a loop — it doesn't consume an
  // iteration), only fires when the first reply had no valid verdict, and still parks
  // honestly if the nudge also fails to produce one.
  let nudged = false;
  if (!next) {
    try {
      const nudgePrompt =
        `Your previous reply did not end with the required next-step token, so the workflow can't advance. ` +
        `Based ONLY on the work you just completed, reply with NOTHING but EXACTLY one of these list ids — a single bare word, no punctuation, no explanation: ${validNext.join(", ")}.`;
      const nout = await runFn({ prompt: nudgePrompt, card: runningCard, list, classification, suppressContinuations: true });
      const nudgeReply = nout?.reply ?? nout?.text ?? String(nout ?? "");
      const nnext = parseNextList(nudgeReply, validNext);
      if (nnext) {
        next = nnext;
        nudged = true;
        if (!snippet) snippet = replySnippet(nudgeReply);
        await appendCardLog(root, card.id, iteration, `\n_(follow-up verdict: ${nnext})_\n`);
      }
    } catch {
      // Nudge failed (gateway hiccup) — fall through and park with the ORIGINAL reply.
    }
  }
  // EVIDENCE GATE. A list flagged `requiresEvidence` (Walkthrough) must leave tangible
  // proof on disk before it can advance — the operative's "I wrote the evidence" verdict
  // is self-attested, so we VERIFY <runDir>/evidence/ actually has a file. If the run
  // routed forward but produced nothing, we REFUSE the advance and park with a clear
  // reason — converting the prompt's "ALWAYS write evidence" into a real, enforced gate.
  let evidenceMissing = false;
  if (next && list.requiresEvidence && !hasEvidence(cwd, runningCard.runDir)) {
    next = null;
    evidenceMissing = true;
  }
  // Distinguish the outcomes a finished run can have, so the card carries a diagnostic
  // the user can act on instead of one opaque "no valid next list" line:
  //   • moved            — the router named a valid next list (possibly via nudge); advance.
  //   • evidence missing  — a requiresEvidence list routed forward but left NO evidence.
  //   • empty reply       — the operative returned NOTHING (and the nudge didn't rescue it).
  //   • no match          — the operative replied but never named a valid next id.
  const expected = validNext.join(", ");
  let target;
  let outcome;
  if (next) {
    target = {
      ...runningCard,
      list: next,
      status: "ok",
      runningSince: null,
      lastReply: snippet,
      lastDispatchError: null,
      events: withEvent(runningCard, {
        at: now(),
        kind: "routed",
        message: `${listTitle} → ${getList(board, next)?.title || next}${nudged ? " (verdict via follow-up)" : ""}`,
        detail: snippet || null
      })
    };
    outcome = { status: "moved", from: card.list, to: next, nudged };
  } else if (evidenceMissing) {
    const evReason = `${listTitle} reported success but left NO evidence under ${runningCard.runDir}/evidence/ — no screenshot or evidence.md was actually produced, so there is no proof the change works. Parked rather than advancing on the operative's word alone. Move it back to re-run and produce the evidence.`;
    target = {
      ...runningCard,
      ...parkFields(runningCard, card.list, evReason),
      runningSince: null,
      lastReply: snippet,
      lastDispatchError: null,
      events: withEvent(runningCard, {
        at: now(),
        kind: "parked",
        message: `Parked from ${listTitle}: no evidence produced`,
        detail: evReason + (replyText ? `\n\nOperative replied:\n${replyText}` : "")
      })
    };
    outcome = { status: "needs-attention", reason: "no-evidence", validNext };
  } else if (!replyText) {
    const emptyReason = `The ${listTitle} run produced no output — the operative returned nothing, so there was no plan/result and no next step. This usually means the operative was busy or the task needs more detail (try adding a description, or a project). Move it back to retry.`;
    target = {
      ...runningCard,
      ...parkFields(runningCard, card.list, emptyReason),
      runningSince: null,
      lastReply: "",
      lastDispatchError: null,
      events: withEvent(runningCard, {
        at: now(),
        kind: "parked",
        message: `Parked from ${listTitle}: the operative returned no output`,
        detail: emptyReason
      })
    };
    outcome = { status: "needs-attention", reason: "empty-reply", validNext };
  } else {
    const noMatchReason = `${listTitle} ran but didn't choose a next step (it needed to end with one of: ${expected}). The operative said: “${snippet}” — open the log for the full reply, then move it back to retry.`;
    target = {
      ...runningCard,
      ...parkFields(runningCard, card.list, noMatchReason),
      runningSince: null,
      lastReply: snippet,
      lastDispatchError: null,
      events: withEvent(runningCard, {
        at: now(),
        kind: "parked",
        message: `Parked from ${listTitle}: no valid next step chosen`,
        detail: `Expected one of: ${expected}\n\nOperative replied:\n${replyText}`
      })
    };
    outcome = { status: "needs-attention", reason: "no-exact-match", validNext };
  }
  const res = await saveCardCAS(root, target, runRev, now());
  if (!res.ok) return { card: res.card, outcome: { status: "needs-attention", reason: "conflict-during-run" } };
  return { card: res.card, outcome };
}

// Run a card through CONSECUTIVE immediate agent lists in one go — the "automated
// flow". After each successful transition, if the card landed on another immediate
// agent list (not interactive, not scheduler-beat, not manual/terminal) it dispatches
// again, so a card flows Plan → Implement → Review → … automatically without waiting
// for a Start press or the next scheduler tick. Stops when it lands on a manual /
// interactive / scheduler-beat list, parks, or hits a safety guard. onChunk is passed
// through to each turn's live log. The chain is fire-and-forget from the caller.
export async function processChain({ root, board, card, runFn, cap = 10, now = () => new Date().toISOString(), cwd = process.cwd() }) {
  let current = card;
  let lastOutcome = { status: "skipped", reason: "noop" };
  for (let hops = 0; hops < 50; hops++) {
    const { card: c, outcome } = await processCard({ root, board, card: current, runFn, cap, now, cwd });
    current = c;
    lastOutcome = outcome;
    if (outcome.status !== "moved") break; // parked, skipped, deferred, conflict → stop
    const landed = getList(board, current.list);
    if (!landed || landed.kind !== AGENT_KIND) break; // manual / terminal column → stop
    if (isInteractive(landed)) break; // interactive (Discuss) → human takes over
    if (triggerFor(landed) !== "immediate") break; // scheduler-beat (Test) → its own beat
    // else: another immediate agent list → keep running the flow.
  }
  return { card: current, outcome: lastOutcome };
}

// ── Backlog on-entry inference (FINDING 3) ───────────────────────────────────
//
// A card dropped in Backlog infers its title eagerly, but applies the inferred
// project ONLY at ≥70% confidence; below that it parks in needs-attention (no Infer
// column — §9). This is the POLICY half (pure): the caller does the actual inference
// (an LLM call) and hands the result in; the engine decides what lands on the card and
// whether it parks. Default threshold 0.7 (override via the caller).
export const PROJECT_CONFIDENCE_THRESHOLD = 0.7;

export function resolveBacklogInference(card, inference, threshold = PROJECT_CONFIDENCE_THRESHOLD) {
  const title = inference?.title?.trim() || card.title || "(untitled)";
  const confident = typeof inference?.projectConfidence === "number" && inference.projectConfidence >= threshold;
  if (confident && inference?.project) {
    return { card: { ...card, title, project: inference.project }, park: false };
  }
  // Low confidence (or no project): keep the eager title, leave project null, park.
  return { card: { ...card, title, project: null, status: "needs-attention" }, park: true, reason: "low-confidence-project" };
}

// ── Test batching (FINDING 7) ────────────────────────────────────────────────
//
// The Test list runs on its own scheduler beat, not the global heartbeat, and tests
// a whole PROJECT in one session against one test plan. So the unit of work is the
// project, not the card: gather the project's waiting cards on the list, hand the
// batch one prompt, and turn the ONE reply into a per-card verdict.

// Group a list's eligible cards by project. A null/empty project groups under the
// literal "(no-project)" bucket so an unclassified card is still batched (with itself).
export function groupCardsByProject(cards, listId) {
  const byProject = {};
  for (const c of cards) {
    if (c.list !== listId) continue;
    if (c.status === "running" || c.status === "needs-attention") continue;
    const key = c.project || "(no-project)";
    (byProject[key] ??= []).push(c);
  }
  return byProject;
}

// Escape a string for use as a literal inside a RegExp.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The FIRST of `validNext`'s ids to appear (as a whole word) in `text`, or null. Whole
// word = bounded by a non-[A-Za-z0-9-] char or the string edge, so "test" does NOT match
// inside "adversarial-test" (hyphen is part of the token). Used to read a card's verdict
// out of the text right AFTER its id, tolerating prose/badges/separators between.
function firstValidNextIn(text, validNext) {
  let best = null;
  let bestPos = Infinity;
  for (const vn of validNext) {
    const m = text.match(new RegExp(`(?:^|[^A-Za-z0-9-])${escapeRegExp(vn)}(?:[^A-Za-z0-9-]|$)`));
    if (m && m.index < bestPos) { bestPos = m.index; best = vn; }
  }
  return best;
}

// Parse the per-card verdict from a batch reply. The batch session is asked to emit, per
// card, `<cardId> <next-list-id>`. EXACT-match the chosen id against THAT card's validNext
// (a card with no/invalid verdict gets null → the caller loops it to implement / parks it).
// Robust to the SAME reflow problem as parseNextList: the verdict "<cardId> adversarial-test"
// routinely arrives flowed onto a line with prose + gateway badges
// ("… Gate green. [route: …] [orchestrator-active] <cardId> adversarial-test"), so we can't
// require it on its own line. Strip badge spans, then for each card find its id (LAST
// occurrence — the verdict comes after the work) and take the first valid-next token that
// follows it. Still exact-match, no guessing.
export function parseBatchVerdicts(reply, cards, board) {
  const text = typeof reply === "string" ? reply : reply?.reply ?? reply?.text ?? "";
  const cleaned = String(text).replace(/\[[^\]\n]*\]/g, " ");
  const verdicts = {};
  for (const c of cards) {
    const validNext = validNextFor(board, c.list);
    verdicts[c.id] = null;
    const idx = cleaned.lastIndexOf(c.id);
    if (idx === -1) continue;
    // Look only at the text after this card's id, so a verdict token belonging to ANOTHER
    // card (earlier in the reply) can't be mis-attributed to this one.
    verdicts[c.id] = firstValidNextIn(cleaned.slice(idx + c.id.length), validNext);
  }
  return verdicts;
}

// Run ONE batched session per project for a list (Test). batchRunFn is handed the
// project's cards + the combined batch prompt and returns ONE reply naming a verdict
// per card. Each card is then moved per its own verdict (CAS-safe, runId minted if it
// is the card's first agent-list entry): a valid verdict moves it forward; a missing /
// non-matching verdict, or an iteration-cap breach, loops it to `implement` (the fail
// edge) or parks it in needs-attention if implement is not a valid next.
export async function processBatch({ root, board, listId, cards, batchRunFn, cap = 10, now = () => new Date().toISOString() }) {
  const list = getList(board, listId);
  if (!list || list.kind !== AGENT_KIND) {
    return { outcomes: [], reason: "not-an-agent-list" };
  }
  const listTitle = list.title || listId;
  const validNext = validNextFor(board, listId);
  const expected = validNext.join(", ");
  const groups = groupCardsByProject(cards, listId);
  const outcomes = [];
  for (const [project, projectCards] of Object.entries(groups)) {
    if (projectCards.length === 0) continue;
    // Acquire every card in the group (CAS the running write + mint run fields). A card
    // that fails the CAS (concurrent tick / manual edit) drops out of the batch. A card
    // already at the cap parks without running. Each write carries the SAME honest
    // reason + timeline events as the per-card path (processCard), so a card parked by
    // the batch path is just as legible — it MOVES to the needs-attention column with a
    // readable reason, not just a status flag stranded on the Test list.
    const acquired = [];
    for (const card of projectCards) {
      const baseRev = card.rev ?? 0;
      if ((card.iterations || 0) >= cap) {
        const capReason = `Hit the iteration cap on ${listTitle} (${cap} runs without converging). Parked so it stops looping — move it back to retry.`;
        const res = await saveCardCAS(root, {
          ...card,
          ...parkFields(card, listId, capReason),
          events: withEvent(card, { at: now(), kind: "parked", message: `Parked from ${listTitle}: iteration cap (${cap})`, detail: capReason })
        }, baseRev, now());
        outcomes.push({ id: card.id, status: "needs-attention", reason: "iteration-cap", project });
        continue;
      }
      const minted = mintRunFields(card, () => Date.parse(now()) || Date.now());
      const iteration = (card.iterations || 0) + 1;
      const acq = await saveCardCAS(root, {
        ...card,
        ...(minted || {}),
        status: "running",
        iterations: iteration,
        runningSince: now(),
        events: withEvent(card, { at: now(), kind: "dispatch", message: `Dispatched to the operative on ${listTitle} (batched: ${project}) — run ${iteration}` })
      }, baseRev, now());
      if (!acq.ok) { outcomes.push({ id: card.id, status: "skipped", reason: "conflict", project }); continue; }
      acquired.push({ original: card, running: acq.card, iteration });
    }
    if (acquired.length === 0) continue;

    const runningCards = acquired.map((a) => a.running);
    // No classification hint (route through the orchestrator) — same as processCard.
    const classification = null;
    let out;
    try {
      out = await batchRunFn({ project, cards: runningCards, list, classification, suppressContinuations: true });
    } catch (err) {
      // The whole batch session failed — park every acquired card with the reason.
      for (const a of acquired) {
        const failReason = `The ${listTitle} batch run for ${project} errored: ${String(err?.message || err)}. Parked — open the log, then move it back to retry.`;
        const res = await saveCardCAS(root, {
          ...a.running,
          ...parkFields(a.running, listId, failReason),
          runningSince: null,
          lastReply: replySnippet(String(err?.message || err)),
          events: withEvent(a.running, { at: now(), kind: "failed", message: `Batch run errored on ${listTitle}`, detail: String(err?.message || err) })
        }, a.running.rev, now());
        await appendCardLog(root, a.original.id, a.iteration, `# iteration ${a.iteration} (batch:${project})\nbatch run failed: ${err?.message || err}\n`);
        outcomes.push({ id: a.original.id, status: "needs-attention", reason: "run-failed", error: String(err?.message || err), project });
      }
      continue;
    }

    const reply = out?.reply ?? out?.text ?? String(out ?? "");
    const snippet = replySnippet(reply);
    const verdicts = parseBatchVerdicts(reply, runningCards, board);
    for (const a of acquired) {
      const next = verdicts[a.original.id];
      await appendCardLog(root, a.original.id, a.iteration, `# iteration ${a.iteration} (batch:${project})\nverdict: ${next ?? "(none)"}\n${reply}\n`);
      let target;
      if (next) {
        target = {
          ...a.running,
          list: next,
          status: "ok",
          runningSince: null,
          lastReply: snippet,
          lastDispatchError: null,
          events: withEvent(a.running, { at: now(), kind: "routed", message: `${listTitle} → ${getList(board, next)?.title || next}`, detail: snippet || null })
        };
      } else {
        // No verdict line for THIS card in the batch reply — say so plainly (the batch
        // session must emit `<cardId> <next-list>` per card; it didn't for this one).
        const noMatchReason = `${listTitle} ran (batched for ${project}) but returned no valid verdict for this card — it needed a line "${a.original.id} <one of: ${expected}>". The operative said: “${snippet}” — open the log for the full reply, then move it back to retry.`;
        target = {
          ...a.running,
          ...parkFields(a.running, listId, noMatchReason),
          runningSince: null,
          lastReply: snippet,
          events: withEvent(a.running, { at: now(), kind: "parked", message: `Parked from ${listTitle}: no valid verdict in the batch reply`, detail: `Expected: ${a.original.id} <${expected}>\n\nBatch reply:\n${reply}` })
        };
      }
      const res = await saveCardCAS(root, target, a.running.rev, now());
      if (!res.ok) { outcomes.push({ id: a.original.id, status: "needs-attention", reason: "conflict-during-run", project }); continue; }
      if (!next) { outcomes.push({ id: a.original.id, status: "needs-attention", reason: "no-exact-match", project }); continue; }
      outcomes.push({ id: a.original.id, status: "moved", from: listId, to: next, project });
    }
  }
  return { outcomes };
}

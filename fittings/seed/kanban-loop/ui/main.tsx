// Kanban Loop board UI — responsive, phone-first (the v4 wireframe is the spec).
// Lists are columns in a horizontally-scrollable board; each card front shows
// title, project chip, list, iter N/cap, goalMode and the four actions:
// Start/Advance · Move · Watch · Open. Open shows the decision-10 LINKS (plan,
// brief, sessions, gate markers, screenshots, video) + the small decision log;
// the card LINKS its artifacts, never inlines their bodies (FINDING 10). Watch
// streams the card's log over SSE for a live run, opens the web chat for an
// interactive list (Discuss), or shows the linked static logs when nothing is
// live — it never tmux-attaches (the pooled gateway operative is raw node-pty).

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  type BoardView,
  type BoardRuntime,
  type CardSummary,
  type CardDetail,
  type CardEvent,
  type RouteStamp,
  type ListView,
  type ListConfig,
  type ListConfigPatch,
  type ArtifactRef,
  type PolicyView,
  type WaitingOn
} from "./api";
import {
  PlayIcon,
  MoveIcon,
  WatchIcon,
  OpenIcon,
  PlusIcon,
  CloseIcon,
  LinkIcon,
  GearIcon,
  ActivityIcon,
  SparkIcon,
  ChatIcon,
  BoardMark
} from "./icons";
// The Discuss URL contract is shared with the server (pure builder, no node
// imports — see scripts/discuss.mjs). The board hands the generic web channel
// the card as an OPAQUE context blob; James (the operative) reads it.
// @ts-expect-error — plain ESM .mjs sibling, no .d.ts; esbuild bundles it.
import { buildDiscussUrl } from "../scripts/discuss.mjs";

const ITERATION_CAP = 10;

function listClass(list: ListView): string {
  if (list.id === "needs-attention") return "list attn";
  if (list.interactive) return "list interactive";
  if (list.phase && list.phase.includes("adversarial")) return "list codex";
  if (list.kind === "agent") return "list agent";
  return "list manual";
}

function dotClass(card: CardSummary): string {
  if (card.status === "running") return "dot run";
  if (card.status === "needs-attention") return "dot attn";
  return "dot ok";
}

// ── time + event helpers (the visibility surface) ────────────────────────────
// A compact "3m ago" / "just now" relative time for timeline + last-activity lines.
function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// mm:ss (or h:mm:ss) elapsed since an ISO instant — the running timer.
function fmtElapsed(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  let s = Math.max(0, Math.round((Date.now() - t) / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// A self-ticking elapsed label (updates every second) for a running card, so the live
// "running 1:23" timer advances without re-rendering the whole board.
function Elapsed({ since }: { since: string | null | undefined }): React.ReactElement {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{fmtElapsed(since)}</>;
}

// Per-event-kind dot colour on the timeline.
function eventDotClass(kind: string): string {
  return `ev-dot ev-${kind || "generic"}`;
}

// ── per-phase runtime/model attribution helpers ───────────────────────────────
// The "who ran it" identity — the model, falling back to the runtime then provider.
function routeWho(r: RouteStamp): string {
  return r.model || r.runtime || r.provider || "";
}

// The card-front attribution chip text: "<phase> @ <model>" (e.g. "plan @ opus"),
// dropping the phase when unknown. "" when there is nothing worth showing.
function routeChipText(r: RouteStamp): string {
  const who = routeWho(r);
  if (!who) return "";
  const ph = (r.phase || "").trim();
  return ph ? `${ph} @ ${who}` : who;
}

// The full-attribution tooltip for the card-front chip.
function routeTitle(r: RouteStamp): string {
  const parts = [
    r.phase ? `phase: ${r.phase}` : null,
    r.runtime ? `runtime: ${r.runtime}` : null,
    r.provider ? `provider: ${r.provider}` : null,
    r.model ? `model: ${r.model}` : null,
    r.tier ? `tier: ${r.tier}` : null,
    r.effort ? `effort: ${r.effort}` : null,
    r.targetId ? `route: ${r.targetId}` : null
  ].filter(Boolean);
  return parts.length ? `routed to ${parts.join(", ")}` : "routed";
}

// A compact one-liner for a routed event in the Activity timeline:
// "claude-code/opus · T2-deep · high". "" when no attribution fields are present.
function routeLine(r: RouteStamp): string {
  const idPart = [r.runtime || r.provider, r.model].filter(Boolean).join("/");
  return [idPart, r.tier, r.effort].filter(Boolean).join(" · ");
}

// A short, legible label for the card a wait is blocked on: its title plus the
// last 6 chars of its id (the id tail keeps it unambiguous when titles repeat).
function waitingLabel(w: WaitingOn): string {
  const title = (w.cardTitle || "").trim();
  const short = (w.cardId || "").slice(-6);
  return title ? `${title} (${short})` : short || w.cardId;
}

// The reason clause rendered after "Waiting on <label>: " — grade-aware so each S2
// wait reads truthfully. Overlap waits (medium/heavy) name the grade + the release
// point; an exclusive-lease wait and an interference wait have their own phrasing
// (their release point — "it releases" / "its fix fence" — folded into the clause).
function waitingClause(w: WaitingOn): string {
  if (w.grade === "lease") return "exclusive lease held, until it releases";
  if (w.grade === "interference") return "broken by its commits, until its fix fence";
  return `${w.grade} overlap, until ${w.until}`;
}

// ── card front ──────────────────────────────────────────────────────────────
function Card({
  card,
  list,
  onStart,
  onMove,
  onWatch,
  onOpen,
  onInfer,
  onDiscuss,
  onRevert,
  onContinue,
  busy
}: {
  card: CardSummary;
  list: ListView;
  onStart: (c: CardSummary) => void;
  onMove: (c: CardSummary) => void;
  onWatch: (c: CardSummary) => void;
  onOpen: (c: CardSummary) => void;
  onInfer: (c: CardSummary) => void;
  onDiscuss: (c: CardSummary) => void;
  onRevert: (c: CardSummary) => void;
  onContinue: (c: CardSummary) => void;
  busy: boolean;
}) {
  // D16: a card on an autonomous (agent) list is ENGINE-OWNED — the UI offers no
  // manual Move/edit on it (the API rejects them too). needs-attention is the one
  // human touchpoint on the autonomous side; interactive + manual lists stay
  // fully editable.
  const engineOwned = list.kind === "agent" && !list.interactive;
  // Advance shows on MANUAL lists (Backlog, To Do, needs-attention) — that is how a card
  // ENTERS the automated flow (To Do → Plan) or is re-sent after parking. Discuss
  // (interactive) uses the web chat + Move; Done (terminal) has nowhere to go.
  const canAdvance = list.kind !== "agent" && !list.interactive && !list.terminal && list.validNext.length > 0;
  const startLabel = "Advance";
  // A persisted dispatch failure (gateway unreachable / transport defer): a red chip +
  // inline reason, so a failed dispatch shows on the CARD.
  const dispatchErr = card.lastDispatchError;
  const running = card.status === "running";
  // RUN: start a card's activity on demand on ANY agent list (Plan…Validate, incl. the
  // batched/scheduler-beat Test) — no need to wait for a trigger/tick. Shows on a
  // non-running agent-list card that isn't parked (a parked card is recovered via the
  // needs-attention column's Advance/Move, and the batch path skips needs-attention
  // cards, so offering Run there would be a no-op); reads "Retry" after a dispatch error.
  const canRun = list.kind === "agent" && !list.interactive && !running && card.status !== "needs-attention";
  // Why a parked card is in the needs-attention column.
  const parked = card.status === "needs-attention";
  const inferring = card.inferState === "running";
  // Offer "Infer" on a no-project card that isn't mid-inference (the visible attempt
  // the user asked for — also lets them re-try if it came back blank).
  const canInfer = !card.project && !inferring && !running;
  const lastEv = card.lastEvent;
  return (
    <div className={`card${running ? " running" : ""}${parked ? " parked" : ""}`}>
      <div className="ct">
        <span className={dotClass(card)} aria-hidden />
        <span className="title">{card.title}</span>
      </div>
      <div className="cmeta">
        {card.project
          ? <span className="chip" title="project">{card.project}</span>
          : <span className="chip muted" title="no project assigned">no project</span>}
        {inferring && <span className="chip infer" title="inferring the project from the description"><SparkIcon /> inferring project…</span>}
        {parked && <span className="chip attn">needs-attention</span>}
        {card.steeringPending && <span className="chip steering" title="a mid-run revisit directive is pending — the card will re-stage at the next duty boundary">steering</span>}
        {card.waitingOn && <span className="chip waiting" title={card.waitingOn.reason}>waiting</span>}
        {card.blocking && card.blocking.length > 0 && (
          <span className="chip" title={`${card.blocking.length} card(s) are waiting on this one`}>blocks {card.blocking.length}</span>
        )}
        {card.parkedFrom && <span className="chip" title="the list it parked from">from {card.parkedFrom}</span>}
        {list.kind === "agent" && (
          <span className="chip">iter {card.iterations}/{ITERATION_CAP}</span>
        )}
        {card.goalMode && <span className="chip goal">goalMode</span>}
        {card.workKind && <span className="chip" title="work kind (the policy phase plan this run follows)">{card.workKind}</span>}
        {card.lastRoute && routeChipText(card.lastRoute) && (
          <span className="chip route" title={routeTitle(card.lastRoute)}>{routeChipText(card.lastRoute)}</span>
        )}
        {engineOwned && <span className="chip muted" title="This card is on an autonomous list — the run engine owns its progression (D16). It becomes editable if it parks in needs-attention.">engine-owned</span>}
        {card.fences?.sha && (
          <span className="chip fence" title={`last commit fence: ${card.fences.phase ?? "?"} @ ${card.fences.sha}`}>
            fence {card.fences.sha.slice(0, 7)}
          </span>
        )}
        {dispatchErr && (
          <span className="chip attn" title={dispatchErr.message}>{dispatchErr.reason}</span>
        )}
      </div>

      {/* D17 honesty: phases the card's rail turned OFF render as dimmed chips —
          visible, never hidden. Sourced from the card's phases toggle map. */}
      {card.phases && Object.values(card.phases).some((v) => v === false) && (
        <div className="cmeta">
          {Object.entries(card.phases)
            .filter(([, on]) => on === false)
            .map(([ph]) => (
              <span key={ph} className="chip off" title={`the ${ph} phase is OFF for this run — recorded off, never a silent pass`}>
                {ph}: off
              </span>
            ))}
        </div>
      )}

      {/* LIVE run state: a running pill with a ticking elapsed timer + the live log
          tail, so the card shows the operative WORKING (not just a pulsing dot). */}
      {running && (
        <div className="run-live">
          <div className="run-head">
            <span className="run-spin" aria-hidden />
            <span>running on {list.title}</span>
            <span className="run-elapsed"><Elapsed since={card.runningSince} /></span>
          </div>
          {card.liveTail
            ? <pre className="run-tail">{card.liveTail}</pre>
            : <div className="run-wait">waiting for the operative’s first output…</div>}
        </div>
      )}

      {/* WAITING: deferred behind an overlapping same-project run (amber, distinct
          from the parked red). Names the blocker, why, and the release point. */}
      {card.waitingOn && (
        <div className="state-callout waiting">
          Waiting on {waitingLabel(card.waitingOn)}: {waitingClause(card.waitingOn)}
        </div>
      )}

      {/* PARKED: the human reason (no jargon) + what the operative actually said. */}
      {parked && card.attentionReason && (
        <div className="dispatch-err">{card.attentionReason}</div>
      )}
      {/* ABANDONED (S2, Q7): a parked card with a prepared revert — the confirm block.
          Applying is a deliberate, guarded press (never auto-applied); the button is
          disabled once the revert is applied or has conflicted (state !== "prepared"),
          with the terminal state shown as a small tag. */}
      {parked && card.preparedRevert && (
        <div className="revert-block">
          <span className="rb-text">
            Prepared revert of {card.preparedRevert.commits} commit{card.preparedRevert.commits === 1 ? "" : "s"}
          </span>
          {card.preparedRevert.state !== "prepared" && (
            <span className={`chip ${card.preparedRevert.state === "applied" ? "ok" : "attn"}`}>{card.preparedRevert.state}</span>
          )}
          <button
            className="btn danger small"
            disabled={busy || card.preparedRevert.state !== "prepared"}
            title={card.preparedRevert.state === "prepared" ? "apply the prepared revert (asks to confirm first)" : `revert ${card.preparedRevert.state}`}
            onClick={() => onRevert(card)}
          >
            Confirm revert
          </button>
        </div>
      )}
      {parked && card.lastReply && !card.attentionReason?.includes(card.lastReply.slice(0, 24)) && (
        <div className="card-reply" title="the operative's reply">“{card.lastReply}”</div>
      )}
      {dispatchErr && !parked && (
        <div className="dispatch-err">{dispatchErr.message}</div>
      )}

      {/* LAST ACTIVITY: the most recent timeline event + when — always visible (when
          not running/parked, which have their own richer block), so you can always see
          what last happened to the card. */}
      {!running && !parked && lastEv && (
        <div className="card-last" title={lastEv.detail || lastEv.message}>
          <span className={eventDotClass(lastEv.kind)} aria-hidden />
          <span className="cl-msg">{lastEv.message}</span>
          <span className="cl-when">{fmtRelative(lastEv.at)}</span>
        </div>
      )}

      <div className="btns">
        {canAdvance && (
          <button className="btn primary small" disabled={busy} onClick={() => onStart(card)}>
            <PlayIcon /> {startLabel}
          </button>
        )}
        {canRun && (
          <button
            className="btn primary small"
            disabled={busy}
            title={dispatchErr ? "re-run this card on this list" : `run ${list.title} on this card now`}
            onClick={() => onStart(card)}
          >
            <PlayIcon /> {dispatchErr ? "Retry" : "Run"}
          </button>
        )}
        {canInfer && !engineOwned && (
          <button className="btn small" disabled={busy} title="infer the project from the description" onClick={() => onInfer(card)}>
            <SparkIcon /> Infer
          </button>
        )}
        {!engineOwned && (
          <button className="btn small" disabled={busy} onClick={() => onMove(card)}>
            <MoveIcon /> Move
          </button>
        )}
        {/* Discuss list (interactive) gets a dedicated Discuss button that opens a
            James-mode session seeded with this card; everything else gets Watch (logs). */}
        {list.interactive ? (
          <button className="btn small primary" title="open a James-mode discussion seeded with this card" onClick={() => onDiscuss(card)}>
            <ChatIcon /> Discuss
          </button>
        ) : (
          <button className="btn small" onClick={() => onWatch(card)}>
            <WatchIcon /> Watch
          </button>
        )}
        {/* WS2 (D7): a DONE card can spawn a continuation whose starting context is
            seeded from this card's handoff packet. */}
        {list.terminal && (
          <button className="btn small primary" disabled={busy} title="create a new card that continues this one's work" onClick={() => onContinue(card)}>
            <PlayIcon /> Continue
          </button>
        )}
        <button className="btn small" onClick={() => onOpen(card)}>
          <OpenIcon /> Open
        </button>
      </div>
    </div>
  );
}

// ── new-card sheet ──────────────────────────────────────────────────────────
// Sentinel select value for the "type a custom project path" option (kept distinct
// from any real project name).
const PROJECT_CUSTOM = "__custom__";

function NewCardSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  // Project picker: "auto" = leave blank (the server infers it from the description);
  // "pick" = a repo chosen from the dev-root list; "custom" = a free-typed name/path.
  const [projectMode, setProjectMode] = useState<"auto" | "pick" | "custom">("auto");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [description, setDescription] = useState("");
  const [goalMode, setGoalMode] = useState(false);
  // D17: the work kind (policy phase plan) + per-card phase toggles. Loaded
  // from the board's GET /policy passthrough; absent policy → plain creation.
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [workKind, setWorkKind] = useState<string>("");
  const [phasesOff, setPhasesOff] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The repos under the dev-root (dev-env parity). Best-effort — on failure the picker
  // still offers "(auto-infer)" + "Custom path…".
  useEffect(() => {
    let alive = true;
    api.projects().then((v) => { if (alive) setProjects(v.projects); }).catch(() => { /* leave empty */ });
    api.policy().then((v) => { if (alive) { setPolicy(v); setWorkKind(v.defaultWorkKind ?? ""); } }).catch(() => { /* no policy — plain create */ });
    return () => { alive = false; };
  }, []);

  // The phases of the selected work kind's plan, in pipeline order — the
  // toggleable rail preview. Unknown kind → empty (no toggles offered).
  const railPhases: string[] = (() => {
    if (!policy || !workKind) return [];
    const kind = policy.workKinds[workKind];
    const plan = kind ? policy.phasePlans[kind.phasePlan] : null;
    if (!plan) return [];
    return plan.phases.map((ph) => (typeof ph === "string" ? ph : ph.id));
  })();

  async function submit() {
    // Title is optional — it's inferred from the description when blank. Only block when
    // there's nothing at all to name the card by.
    if (!title.trim() && !description.trim()) {
      setErr("Add a title or a description — the title is inferred from the description when left blank.");
      return;
    }
    setSaving(true);
    setErr(null);
    const proj = projectMode === "auto" ? undefined : (project.trim() || undefined);
    const offMap = Object.fromEntries(Object.entries(phasesOff).filter(([, off]) => off).map(([ph]) => [ph, false]));
    try {
      await api.create({
        title: title.trim() || undefined,
        project: proj,
        description,
        goalMode,
        workKind: workKind || undefined,
        phases: Object.keys(offMap).length ? offMap : undefined
      });
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const selectValue = projectMode === "custom" ? PROJECT_CUSTOM : projectMode === "auto" ? "" : project;

  return (
    <Sheet title="New card → Backlog" onClose={onClose}>
      <div className="field">
        <label htmlFor="nc-title">Title <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
        <input id="nc-title" type="text" value={title} autoFocus
          placeholder="optional — inferred from the description if left blank"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
      </div>
      <div className="field">
        <label htmlFor="nc-project">Project <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
        <select
          id="nc-project"
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") { setProjectMode("auto"); setProject(""); }
            else if (v === PROJECT_CUSTOM) { setProjectMode("custom"); setProject(""); }
            else { setProjectMode("pick"); setProject(v); }
          }}
        >
          <option value="">(auto-infer from the description)</option>
          {projects.map((p) => <option key={p.path} value={p.name}>{p.name}</option>)}
          <option value={PROJECT_CUSTOM}>Custom path…</option>
        </select>
        {projectMode === "custom" && (
          <input
            id="nc-project-custom"
            type="text"
            value={project}
            placeholder="project name or absolute path"
            style={{ marginTop: 8 }}
            autoFocus
            onChange={(e) => setProject(e.target.value)}
          />
        )}
        {projectMode === "auto" && (
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            Left blank — Garrison infers the project from the description (you can change it later).
          </div>
        )}
      </div>
      <div className="field">
        <label htmlFor="nc-desc">Description</label>
        <textarea id="nc-desc" value={description} placeholder="what needs doing (also used to infer the title/project)"
          onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="field">
        <label className="row" htmlFor="nc-goal">
          <input id="nc-goal" type="checkbox" checked={goalMode}
            onChange={(e) => setGoalMode(e.target.checked)} />
          goalMode (prepend /goal + acceptance)
        </label>
      </div>
      {policy && (
        <div className="field">
          <label htmlFor="nc-kind">Work kind <span className="muted" style={{ fontWeight: 400 }}>(the policy phase plan this run follows)</span></label>
          <select id="nc-kind" value={workKind} onChange={(e) => { setWorkKind(e.target.value); setPhasesOff({}); }}>
            {Object.entries(policy.workKinds).map(([k, v]) => (
              <option key={k} value={k}>{k}{k === policy.defaultWorkKind ? " (default)" : ""}{v.description ? ` — ${v.description}` : ""}</option>
            ))}
          </select>
          {railPhases.length > 0 && (
            <div className="rail-toggles">
              {railPhases.map((ph) => (
                <label key={ph} className={`chip toggle${phasesOff[ph] ? " off" : ""}`} title={phasesOff[ph] ? `${ph} will be recorded OFF for this run (never a silent pass)` : `${ph} runs; tap to turn it off for this run`}>
                  <input
                    type="checkbox"
                    checked={!phasesOff[ph]}
                    onChange={(e) => setPhasesOff((m) => ({ ...m, [ph]: !e.target.checked }))}
                  />
                  {ph}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      {err && <div className="banner">{err}</div>}
      <button className="btn primary" disabled={saving} onClick={() => void submit()}>
        {saving ? "Creating…" : "Create card"}
      </button>
    </Sheet>
  );
}

// ── inline Backlog quick-add (touch-first per-column affordance) ─────────────
// A per-column "Add card" at the head of the Backlog list: tap the trigger to
// reveal a compact inline form (title required, description + project optional)
// that POSTs straight to /cards — which always lands the card in Backlog — and
// refreshes the board in place, no reload. Distinct from the top-bar "New card"
// sheet, which carries the full run-policy options (goalMode / work kind / phase
// toggles): this is the fast capture path, sized for touch (≥44px controls,
// usable at 390px). Reuses PROJECT_CUSTOM + the project-picker semantics of the
// New Card sheet so the two entry points behave the same.
function BacklogAddCard({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectMode, setProjectMode] = useState<"auto" | "pick" | "custom">("auto");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<{ name: string; path: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // Load the dev-root repos for the project picker only once the form is opened
  // (parity with the New Card sheet). Best-effort — on failure the picker still
  // offers "(auto-infer)" + "Custom path…".
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.projects().then((v) => { if (alive) setProjects(v.projects); }).catch(() => { /* leave empty */ });
    return () => { alive = false; };
  }, [open]);

  // Autofocus the title the moment the form opens.
  useEffect(() => { if (open) titleRef.current?.focus(); }, [open]);

  function reset() {
    setTitle(""); setDescription(""); setProjectMode("auto"); setProject(""); setErr(null); setSaving(false);
  }

  async function submit() {
    // Reentrancy guard: Enter can fire again while the POST is in flight —
    // without this, two keydowns create two cards.
    if (saving) return;
    // Title is REQUIRED on the quick-add path (the top-bar sheet is the "infer from
    // description" path). Block + refocus when it's blank rather than round-tripping.
    const t = title.trim();
    if (!t) { setErr("Give the card a title."); titleRef.current?.focus(); return; }
    setSaving(true);
    setErr(null);
    const proj = projectMode === "auto" ? undefined : (project.trim() || undefined);
    try {
      await api.create({ title: t, description: description.trim() || undefined, project: proj });
      reset();
      setOpen(false);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const selectValue = projectMode === "custom" ? PROJECT_CUSTOM : projectMode === "auto" ? "" : project;

  if (!open) {
    return (
      <button type="button" className="backlog-add-trigger" onClick={() => setOpen(true)}>
        <PlusIcon /> Add card
      </button>
    );
  }

  return (
    <div className="backlog-add" role="group" aria-label="Add a card to Backlog">
      <input
        ref={titleRef}
        className="ba-input"
        type="text"
        value={title}
        placeholder="Card title (required)"
        aria-label="Card title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void submit(); }
          if (e.key === "Escape") { setOpen(false); reset(); }
        }}
      />
      <textarea
        className="ba-textarea"
        value={description}
        placeholder="Description (optional)"
        aria-label="Card description"
        onChange={(e) => setDescription(e.target.value)}
      />
      <select
        className="ba-select"
        aria-label="Project"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") { setProjectMode("auto"); setProject(""); }
          else if (v === PROJECT_CUSTOM) { setProjectMode("custom"); setProject(""); }
          else { setProjectMode("pick"); setProject(v); }
        }}
      >
        <option value="">Project: auto-infer</option>
        {projects.map((p) => <option key={p.path} value={p.name}>{p.name}</option>)}
        <option value={PROJECT_CUSTOM}>Custom path…</option>
      </select>
      {projectMode === "custom" && (
        <input
          className="ba-input"
          type="text"
          value={project}
          placeholder="project name or absolute path"
          aria-label="Custom project path"
          onChange={(e) => setProject(e.target.value)}
        />
      )}
      {err && <div className="ba-err" role="alert">{err}</div>}
      <div className="ba-actions">
        <button type="button" className="ba-btn primary" disabled={saving || !title.trim()} onClick={() => void submit()}>
          {saving ? "Adding…" : "Add card"}
        </button>
        <button type="button" className="ba-btn" disabled={saving} onClick={() => { setOpen(false); reset(); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── move sheet (the manual gate) ────────────────────────────────────────────
function MoveSheet({
  card,
  board,
  onClose,
  onMoved
}: {
  card: CardSummary;
  board: BoardView;
  onClose: () => void;
  onMoved: () => void;
}) {
  const current = board.lists.find((l) => l.id === card.list);
  const targets = current?.validNext ?? [];
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function moveTo(listId: string) {
    setBusy(true);
    setErr(null);
    try {
      await api.patch(card.id, { list: listId, rev: card.rev });
      onMoved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title={`Move: ${card.title}`} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Pick the next list yourself — this is the manual gate.
      </p>
      {targets.length === 0 ? (
        <div className="banner info">No valid next list from {card.list}.</div>
      ) : (
        <div className="move-list">
          {targets.map((t) => {
            const target = board.lists.find((l) => l.id === t);
            return (
              <button key={t} className="btn move-opt" disabled={busy} onClick={() => void moveTo(t)}>
                <MoveIcon /> {target?.title ?? t}
              </button>
            );
          })}
        </div>
      )}
      {err && <div className="banner" style={{ marginTop: 12 }}>{err}</div>}
    </Sheet>
  );
}

// ── detail sheet (Open) — the decision-10 links + decision log ──────────────
// LinkRow opens each produced artifact in the in-board viewer/editor (ArtifactModal)
// rather than a raw new tab, so brief/plan/logs are viewable AND editable in place. The
// external walkthrough video (kind "href") still opens out.
function LinkRow({ label, refs, onOpen }: { label: string; refs: ArtifactRef | ArtifactRef[] | null; onOpen: (ref: ArtifactRef) => void }) {
  const items = Array.isArray(refs) ? refs : refs ? [refs] : [];
  return (
    <div className="lrow">
      <div className="k">{label}</div>
      <div className="v">
        {items.length === 0 && <span className="missing">—</span>}
        {items.map((ref, i) => {
          const href = api.artifactUrl(ref);
          if (ref.kind === "missing" || !href) {
            return <span key={i} className="missing">{ref.path ?? "not produced"}</span>;
          }
          const label2 = ref.sessionId
            ? ref.sessionId.slice(0, 8)
            : ref.kind === "href"
              ? "open video"
              : ref.path
                ? ref.path.split("/").pop()
                : "open";
          const dim = ref.exists === false && ref.kind !== "href";
          return (
            <span key={i}>
              {i > 0 && " · "}
              {ref.kind === "href" ? (
                <a href={href} target="_blank" rel="noreferrer">{label2}</a>
              ) : (
                <button type="button" className="artlink" style={dim ? { opacity: 0.55 } : undefined} onClick={() => onOpen(ref)}>
                  {label2}{dim ? " (pending)" : ""}
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// The in-board artifact viewer/editor. Fetches the served content, renders it (image /
// read-only text / an editable .md·.txt), and saves edits back via PUT for the editable
// refs (brief · plan · logs). Machine-generated JSON + transcripts + evidence are view-only.
const ART_IMG_EXT = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
function artRefToken(ref: ArtifactRef): string | null {
  if (ref.ref) return ref.ref;
  try { return new URL(ref.url ?? "", "http://x").searchParams.get("ref"); } catch { return null; }
}
function ArtifactModal({ cardId, art, onClose }: { cardId: string; art: ArtifactRef; onClose: () => void }) {
  const url = api.artifactUrl(art);
  const token = artRefToken(art);
  const base = (art.path ? art.path.split("/").pop() : "") || art.name || token || "artifact";
  const ext = base.toLowerCase().split(".").pop() ?? "";
  const isImage = ART_IMG_EXT.includes(ext) || Boolean(art.image);
  const editable = Boolean(token && (token === "brief" || token === "plan" || /^log:\d+$/.test(token)) && (ext === "md" || ext === "txt"));
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(isImage);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (isImage || !url) { setLoaded(true); return; }
    let alive = true;
    fetch(url, { cache: "no-store" }).then((r) => r.text()).then((t) => { if (alive) { setContent(t); setLoaded(true); } })
      .catch((e) => { if (alive) { setErr(String(e)); setLoaded(true); } });
    return () => { alive = false; };
  }, [url]);
  const save = useCallback(async () => {
    if (!token) return;
    setSaving(true); setErr(null);
    try {
      const r = await fetch(`/cards/${encodeURIComponent(cardId)}/artifact?ref=${encodeURIComponent(token)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
      });
      const d = await r.json();
      if (d?.error) setErr(String(d.error));
      else { setSaved(true); setDirty(false); window.setTimeout(() => setSaved(false), 1500); }
    } catch (e) { setErr(String(e)); }
    setSaving(false);
  }, [cardId, token, content]);
  return (
    <div className="art-scrim" onClick={onClose}>
      <div className="art-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={base}>
        <div className="art-head">
          <span className="art-title">{base}</span>
          {editable && <span className="art-tag">editable</span>}
          <span className="art-spacer" />
          {url && <a className="art-raw" href={url} target="_blank" rel="noreferrer">raw</a>}
          <button type="button" className="art-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="art-body">
          {!loaded ? <div className="art-loading">Loading…</div>
            : isImage ? <img className="art-img" src={url ?? ""} alt={base} />
            : editable ? <textarea className="art-editor" value={content} spellCheck={false} onChange={(e) => { setContent(e.target.value); setDirty(true); }} />
            : <pre className="art-view">{content || "(empty)"}</pre>}
        </div>
        {editable ? (
          <div className="art-foot">
            {err ? <span className="art-err">{err}</span> : saved ? <span className="art-ok">Saved</span> : dirty ? <span className="art-dirty">Unsaved changes</span> : <span className="art-dim">Up to date</span>}
            <span className="art-spacer" />
            <button type="button" className="art-save" onClick={() => void save()} disabled={saving || !dirty}>{saving ? "Saving…" : "Save"}</button>
          </div>
        ) : err ? <div className="art-foot"><span className="art-err">{err}</span></div> : null}
      </div>
    </div>
  );
}

// One row on the Activity timeline: a coloured kind-dot, the message + when, and an
// expandable detail (the operative's full reply / error / inference output) when present.
function TimelineEvent({ ev }: { ev: CardEvent }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(ev.detail && ev.detail.trim());
  return (
    <div className="tl-ev">
      <span className={eventDotClass(ev.kind)} aria-hidden />
      <div className="tl-body">
        <div className="tl-line">
          <span className="tl-msg">{ev.message}</span>
          <span className="tl-when" title={ev.at}>{fmtRelative(ev.at)}</span>
        </div>
        {ev.route && routeLine(ev.route) && (
          <div className="tl-route" title={routeTitle(ev.route)}>{routeLine(ev.route)}</div>
        )}
        {hasDetail && (
          <>
            <button className="tl-toggle" onClick={() => setOpen((o) => !o)}>
              {open ? "hide detail" : "show detail"}
            </button>
            {open && <pre className="tl-detail">{ev.detail}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function DetailSheet({ cardId, onClose, onChanged }: { cardId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openArt, setOpenArt] = useState<ArtifactRef | null>(null);
  // S2 (Q7): abandonment + revert action state — separate from the delete flow.
  const [abandoning, setAbandoning] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Poll the detail while open so the Activity feed updates live as a run progresses
  // (the engine appends events through the run). 3s is responsive without being chatty.
  useEffect(() => {
    let alive = true;
    const pull = () => api.card(cardId).then((d) => { if (alive) { setDetail(d); setErr(null); } }).catch((e) => {
      if (alive && !detail) setErr(e instanceof Error ? e.message : String(e));
    });
    void pull();
    const t = setInterval(pull, 3000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  async function doDelete() {
    setDeleting(true);
    try {
      await api.del(cardId);
      onChanged();   // refresh the board (the card is gone)
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  // Abandon (S2, Q7): prepare a revert of the card's committed work and park it. The
  // revert is NOT applied here — a separate confirm applies it. Re-pull the detail so
  // the prepared-revert section appears at once (the 3s poll would also catch it).
  async function doAbandon() {
    if (!window.confirm("Abandon this card and prepare a revert of its committed work? It parks in needs-attention; the revert is NOT applied until you confirm it.")) return;
    setAbandoning(true);
    setActionErr(null);
    try {
      await api.abandon(cardId);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      await api.card(cardId).then((d) => setDetail(d)).catch(() => { /* poll will refresh */ });
      onChanged();
      setAbandoning(false);
    }
  }

  // Confirm-apply the prepared revert (S2, Q7). A guarded press; the server also
  // requires an explicit confirm. On a conflict the server aborts cleanly and the
  // descriptor flips to "conflict" — surfaced here after the re-pull.
  async function doRevert() {
    const n = detail?.card.preparedRevert?.commits ?? 0;
    if (!window.confirm(`Apply the prepared revert of ${n} commit${n === 1 ? "" : "s"}? This adds revert commits to the shared branch.`)) return;
    setReverting(true);
    setActionErr(null);
    try {
      await api.revert(cardId);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      await api.card(cardId).then((d) => setDetail(d)).catch(() => { /* poll will refresh */ });
      onChanged();
      setReverting(false);
    }
  }

  if (err) return <Sheet title="Card" onClose={onClose}><div className="banner">{err}</div></Sheet>;
  if (!detail) return <Sheet title="Card" onClose={onClose}><p className="muted">Loading…</p></Sheet>;

  const { card, links, decisionLog } = detail;
  const events = detail.events ?? [];
  const running = card.status === "running";
  const parked = card.status === "needs-attention";
  // Evidence is expected from Walkthrough onward — so at those stages we show the
  // Evidence section even when empty, surfacing the GAP (the user looks here for proof).
  const evidence = links.evidence ?? [];
  const showEvidence = evidence.length > 0 || ["walkthrough", "validate", "done"].includes(card.list);
  return (
    <Sheet title={card.title} onClose={onClose}>
      <div className="detail-meta">
        {card.project
          ? <span className="chip">proj: {card.project}</span>
          : <span className="chip muted">no project</span>}
        <span className="chip">list: {card.list}</span>
        <span className="chip">iter {card.iterations}/{ITERATION_CAP}</span>
        {card.goalMode && <span className="chip goal">goalMode</span>}
        {card.runId && <span className="chip">run: {card.runId.slice(0, 8)}</span>}
        {card.sliceId && <span className="chip">slice: {card.sliceId}</span>}
      </div>

      {/* Current-state callout — the single most important "what's going on" line. */}
      {running && (
        <div className="state-callout running">
          <span className="run-spin" aria-hidden />
          <span>Running on <b>{card.list}</b> · <Elapsed since={card.runningSince} /> — open Watch for the live stream.</span>
        </div>
      )}
      {parked && card.attentionReason && (
        <div className="state-callout parked">{card.attentionReason}</div>
      )}
      {card.waitingOn && (
        <div className="state-callout waiting">
          Waiting on <b>{waitingLabel(card.waitingOn)}</b>: {waitingClause(card.waitingOn)}
        </div>
      )}

      {/* ABANDONED (S2, Q7): the prepared revert — the exact commits to be reverted
          (short shas), the conflict-risk count, the state tag, and the guarded
          Confirm-revert button (disabled once applied / conflicted). */}
      {card.preparedRevert && (
        <div className="prepared-revert">
          <div className="dd-title">Prepared revert</div>
          <div className="pr-head">
            <span className="pr-count">
              {card.preparedRevert.commits} commit{card.preparedRevert.commits === 1 ? "" : "s"} to revert
            </span>
            {card.preparedRevert.conflictRisk > 0 && (
              <span className="chip attn" title="these commits were later touched by another card — the revert may conflict">
                {card.preparedRevert.conflictRisk} at conflict risk
              </span>
            )}
            <span className={`chip ${card.preparedRevert.state === "applied" ? "ok" : card.preparedRevert.state === "conflict" ? "attn" : "muted"}`}>
              {card.preparedRevert.state}
            </span>
          </div>
          {card.preparedRevert.commitShas.length > 0 && (
            <ul className="pr-commits">
              {card.preparedRevert.commitShas.map((s) => <li key={s}><code>{s}</code></li>)}
              {card.preparedRevert.commits > card.preparedRevert.commitShas.length && (
                <li className="muted">…and {card.preparedRevert.commits - card.preparedRevert.commitShas.length} more</li>
              )}
            </ul>
          )}
          <button
            className="btn danger small"
            disabled={reverting || card.preparedRevert.state !== "prepared"}
            onClick={() => void doRevert()}
          >
            {reverting ? "Reverting…" : "Confirm revert"}
          </button>
          {actionErr && <div className="dispatch-err" style={{ marginTop: 8 }}>{actionErr}</div>}
        </div>
      )}

      {card.description && card.description.trim() && (
        <div className="detail-desc">
          <div className="dd-title">Description</div>
          <p>{card.description}</p>
        </div>
      )}

      {card.lastReply && (
        <div className="detail-desc">
          <div className="dd-title">Last operative reply</div>
          <p className="reply-quote">“{card.lastReply}”</p>
        </div>
      )}

      {/* EVIDENCE — the tangible proof the pipeline leaves at the late stages: a
          screenshot for anything visual, an evidence.md log for backend/static changes.
          Always shown from Walkthrough onward (even empty, so a missing-evidence GAP is
          visible right where the user looks). Images render inline; the log links out. */}
      {showEvidence && (
        <div className="evidence">
          <div className="dd-title">Evidence</div>
          {evidence.length > 0 ? (
            <div className="ev-grid">
              {evidence.map((e, i) => {
                const url = api.artifactUrl(e);
                if (!url) return null;
                return e.image ? (
                  <button key={i} type="button" className="ev-shot" onClick={() => setOpenArt(e)} title={e.name}>
                    <img src={url} alt={e.name ?? "evidence"} loading="lazy" />
                    <span className="ev-name">{e.name}</span>
                  </button>
                ) : (
                  <button key={i} type="button" className="ev-file" onClick={() => setOpenArt(e)} title={e.name}>
                    <LinkIcon /> {e.name}
                  </button>
                );
              })}
            </div>
          ) : running ? (
            <p className="muted ev-none">Evidence will appear here once the {card.list} step produces it…</p>
          ) : (
            <p className="muted ev-none">No evidence was captured for this run — a screenshot or a log should be produced at the Walkthrough step.</p>
          )}
        </div>
      )}

      {/* The Activity timeline — the full "what happened to this card" history. */}
      <div className="timeline">
        <div className="tl-title"><ActivityIcon /> activity</div>
        {events.length === 0 ? (
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>No activity yet.</p>
        ) : (
          events.map((ev, i) => <TimelineEvent key={i} ev={ev} />)
        )}
      </div>

      {/* Pointer table for the rest of the artifacts (evidence itself renders in the
          Evidence section above; the evidence-index json stays here as a raw pointer). */}
      <div className="links">
        <LinkRow label="plan" refs={links.plan} onOpen={setOpenArt} />
        <LinkRow label="brief" refs={links.brief} onOpen={setOpenArt} />
        <LinkRow label="sessions" refs={links.sessions} onOpen={setOpenArt} />
        <LinkRow label="gate markers" refs={links.gateMarkers} onOpen={setOpenArt} />
        <LinkRow label="evidence index" refs={links.evidenceIndex} onOpen={setOpenArt} />
        <LinkRow label="video" refs={links.video} onOpen={setOpenArt} />
        <LinkRow label="logs" refs={links.logs} onOpen={setOpenArt} />
      </div>
      {openArt && <ArtifactModal cardId={card.id} art={openArt} onClose={() => setOpenArt(null)} />}

      <div className="declog">
        <div className="dl-title"><LinkIcon /> decision log</div>
        {decisionLog.length === 0 ? (
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>No runs recorded yet.</p>
        ) : (
          decisionLog.map((run, i) => (
            <div key={i} className="dl-run">
              {run.mode && <span className="chip">mode: {run.mode}</span>}
              {run.model && <span className="chip">model: {run.model}</span>}
              {run.effort && <span className="chip">effort: {run.effort}</span>}
              {run.provider && <span className="chip">provider: {run.provider}</span>}
              {run.tier && <span className="chip">tier: {run.tier}</span>}
              {run.role && <span className="chip">role: {run.role}</span>}
            </div>
          ))
        )}
      </div>

      <div className="danger-zone">
        {/* Abandon (S2, Q7): prepare a revert of the card's committed work + park it.
            Offered on a non-running card that hasn't already been abandoned; the
            confirm() guard and the separate revert step keep it deliberate. */}
        {!running && !card.preparedRevert && (
          <button className="btn danger" disabled={abandoning} onClick={() => void doAbandon()}>
            {abandoning ? "Preparing…" : "Abandon & prepare revert"}
          </button>
        )}
        {!confirmDel ? (
          <button className="btn danger" onClick={() => setConfirmDel(true)}>Delete card</button>
        ) : (
          <div className="confirm-del">
            <span className="muted">Delete this card, its logs, its run directory, and its brief? This can’t be undone.</span>
            <div className="row">
              <button className="btn danger" disabled={deleting} onClick={() => void doDelete()}>
                {deleting ? "Deleting…" : "Delete"}
              </button>
              <button className="btn" disabled={deleting} onClick={() => setConfirmDel(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ── watch sheet — SSE log / static logs (never tmux) ────────────────────────
// Tails a running card's log over SSE, or replays the linked static logs when
// nothing is live. The interactive Discuss list does NOT use this — it has its own
// Discuss button that opens a James-mode session (see App.onDiscuss).
function WatchSheet({
  card,
  onClose
}: {
  card: CardSummary;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string>("");
  const [live, setLive] = useState<boolean | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const scrRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const es = new EventSource(api.watchUrl(card.id));
    es.addEventListener("mode", (e) => {
      try { setLive(JSON.parse((e as MessageEvent).data).live); } catch { /* ignore */ }
    });
    es.addEventListener("log", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        // A live run sends replace:true (the full current log each poll) — show it as
        // the whole pane. Static logs (idle card) append:false → concatenate; growth
        // events append:true → append.
        setLines((prev) => (d.replace ? d.text : d.append ? prev + d.text : prev + (prev ? "\n" : "") + d.text));
      } catch { /* ignore */ }
    });
    es.addEventListener("end", (e) => {
      try { setDone(JSON.parse((e as MessageEvent).data).reason ?? "ended"); } catch { setDone("ended"); }
      es.close();
    });
    es.onerror = () => { es.close(); setDone((d) => d ?? "disconnected"); };
    return () => es.close();
  }, [card.id]);

  useEffect(() => {
    if (scrRef.current) scrRef.current.scrollTop = scrRef.current.scrollHeight;
  }, [lines]);

  // Highlight the Adv-Review "CODEX CALL" line (FINDING 6).
  const rendered = lines.split("\n").map((l, i) => (
    <div key={i} className={/CODEX CALL/i.test(l) ? "codexline" : undefined}>{l || " "}</div>
  ));

  return (
    <Sheet title={`Watch: ${card.title}`} onClose={onClose}>
      {card.status === "needs-attention" && card.attentionReason && (
        <div className="state-callout parked" style={{ marginTop: 0 }}>{card.attentionReason}</div>
      )}
      <div className="watch">
        <div className="wbar">
          card {card.id.slice(0, 6)} · {card.list}
          <span className={`live${live ? "" : " off"}`}>
            {live === null ? "connecting…" : live ? "live" : "static logs"}
          </span>
        </div>
        <div className="wscr" ref={scrRef}>
          {lines ? rendered : <span className="muted">{done ? "no log output" : "waiting for output…"}</span>}
        </div>
      </div>
      {done && (
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          stream ended: {done}
        </p>
      )}
    </Sheet>
  );
}

// ── list-config sheet (FINDING 5: configure a list's skill/prompts/routing) ──
// Opens for the list the gear was clicked on. Reads the FULL config from
// GET /lists (the board view omits the prompt bodies), lets the user edit the
// editable fields, and PATCHes the changes. A MANUAL list shows only title +
// validNext (the agent-only fields are not configurable — the server rejects
// them too); an AGENT/interactive list shows the full set. validNext is a
// multi-select of the REAL list ids (you can only route to lists that exist).
const TRIGGERS = ["immediate", "manual", "scheduler-beat"];
// ── schedule builder (scheduler-beat trigger) ────────────────────────────────
// The backend honors a 5-field POSIX cron. Rather than make the user hand-write cron,
// offer the common cadences (every N hours / daily at a time / weekly on a day) plus a
// raw "custom cron" escape hatch, and always show the resulting cron.
type SchedForm = { cadence: string; everyN: number; hour: number; minute: number; dow: string; custom: string };
const DOW_OPTS = [
  { v: "1", label: "Mon" }, { v: "2", label: "Tue" }, { v: "3", label: "Wed" },
  { v: "4", label: "Thu" }, { v: "5", label: "Fri" }, { v: "6", label: "Sat" }, { v: "0", label: "Sun" }
];

// Best-effort parse of a cron back into the friendly form (so opening an existing beat
// shows the right cadence); anything unrecognised falls to "custom" with the raw cron.
function parseCronToForm(cron: string | null | undefined): SchedForm {
  const def: SchedForm = { cadence: "everyHours", everyN: 5, hour: 9, minute: 0, dow: "1", custom: cron ?? "" };
  if (!cron || !cron.trim()) return def;
  const f = cron.trim().split(/\s+/);
  if (f.length === 5) {
    const [mi, hh, dom, mon, dw] = f;
    const everyH = hh.match(/^\*\/(\d+)$/);
    if (mi === "0" && everyH && dom === "*" && mon === "*" && dw === "*") {
      return { ...def, cadence: "everyHours", everyN: Math.max(1, Number(everyH[1])), custom: cron };
    }
    if (/^\d+$/.test(mi) && /^\d+$/.test(hh) && dom === "*" && mon === "*") {
      if (dw === "*") return { ...def, cadence: "daily", hour: Number(hh), minute: Number(mi), custom: cron };
      if (/^[0-6]$/.test(dw)) return { ...def, cadence: "weekly", hour: Number(hh), minute: Number(mi), dow: dw, custom: cron };
    }
  }
  return { ...def, cadence: "custom", custom: cron };
}

function formToCron(s: SchedForm): string {
  const mm = Math.max(0, Math.min(59, Math.trunc(s.minute) || 0));
  const hh = Math.max(0, Math.min(23, Math.trunc(s.hour) || 0));
  if (s.cadence === "everyHours") return `0 */${Math.max(1, Math.trunc(s.everyN) || 1)} * * *`;
  if (s.cadence === "daily") return `${mm} ${hh} * * *`;
  if (s.cadence === "weekly") return `${mm} ${hh} * * ${s.dow}`;
  return (s.custom || "").trim();
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

function ScheduleField({ value, onChange }: { value: string | null; onChange: (cron: string) => void }) {
  const [form, setForm] = useState<SchedForm>(() => parseCronToForm(value));
  // Seed a sensible default cron when this opens with no schedule yet (e.g. the user
  // just switched the trigger to scheduler-beat), so saving registers a real beat.
  useEffect(() => {
    if (!value || !value.trim()) onChange(formToCron(form));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const update = (partial: Partial<SchedForm>) => {
    const next = { ...form, ...partial };
    setForm(next);
    onChange(formToCron(next));
  };
  const cron = formToCron(form);
  const time = `${pad2(form.hour)}:${pad2(form.minute)}`;
  const onTime = (v: string) => {
    const [h, m] = v.split(":").map((x) => Number(x));
    update({ hour: Number.isFinite(h) ? h : 0, minute: Number.isFinite(m) ? m : 0 });
  };
  return (
    <div className="sched">
      <select className="sched-cadence" value={form.cadence} onChange={(e) => update({ cadence: e.target.value })}>
        <option value="everyHours">Every N hours</option>
        <option value="daily">Daily at a time</option>
        <option value="weekly">Weekly on a day</option>
        <option value="custom">Custom cron</option>
      </select>
      {form.cadence === "everyHours" && (
        <label className="sched-row">
          every
          <input type="number" min={1} max={23} value={form.everyN}
            onChange={(e) => update({ everyN: Number(e.target.value) })} />
          hours
        </label>
      )}
      {form.cadence === "daily" && (
        <label className="sched-row">
          at <input type="time" value={time} onChange={(e) => onTime(e.target.value)} />
        </label>
      )}
      {form.cadence === "weekly" && (
        <label className="sched-row">
          on
          <select value={form.dow} onChange={(e) => update({ dow: e.target.value })}>
            {DOW_OPTS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
          </select>
          at <input type="time" value={time} onChange={(e) => onTime(e.target.value)} />
        </label>
      )}
      {form.cadence === "custom" && (
        <input className="sched-custom" type="text" value={form.custom} placeholder="min hour day-of-month month day-of-week"
          onChange={(e) => update({ custom: e.target.value })} />
      )}
      <div className="cron-preview" title="the cron the scheduler fires this list on">cron: <code>{cron || "—"}</code></div>
    </div>
  );
}

function ListConfigSheet({
  listId,
  board,
  onClose,
  onSaved
}: {
  listId: string;
  board: BoardView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [cfg, setCfg] = useState<ListConfig | null>(null);
  const [rev, setRev] = useState<number | null>(null); // board-level CAS token from GET /lists
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load the full list config (prompt bodies included). The board only carries
  // the lists' metadata, not the execute/router prompt text. Capture the board
  // rev so the save can CAS against it (reject if another edit landed first).
  const reload = useCallback(() => {
    let alive = true;
    api.lists()
      .then((v) => {
        if (!alive) return;
        setRev(v.rev);
        const found = v.lists.find((l) => l.id === listId);
        if (found) setCfg(found);
        else setErr(`list not found: ${listId}`);
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [listId]);
  useEffect(() => reload(), [reload]);

  if (err && !cfg) return <Sheet title="Configure list" onClose={onClose}><div className="banner">{err}</div></Sheet>;
  if (!cfg) return <Sheet title="Configure list" onClose={onClose}><p className="muted">Loading…</p></Sheet>;

  const isManual = cfg.kind === "manual";
  // The list ids you can route to (every list on the board). A list may route to
  // itself in principle, but the seed never does; we still list it so the user is
  // not blocked.
  const allListIds = board.lists.map((l) => ({ id: l.id, title: l.title }));
  // The lists not yet in validNext — the "+ add a next list" dropdown's options.
  const addableNext = allListIds.filter((l) => !cfg.validNext.includes(l.id));

  function set<K extends keyof ListConfig>(key: K, value: ListConfig[K]) {
    setCfg((c) => (c ? { ...c, [key]: value } : c));
  }

  function toggleNext(id: string) {
    setCfg((c) => {
      if (!c) return c;
      const has = c.validNext.includes(id);
      return { ...c, validNext: has ? c.validNext.filter((x) => x !== id) : [...c.validNext, id] };
    });
  }

  async function save() {
    if (!cfg) return;
    if (!cfg.title.trim()) { setErr("Title is required"); return; }
    setSaving(true);
    setErr(null);
    // Send only the editable fields. A manual list sends just title + validNext
    // (the server rejects agent-only fields on a manual list). D15: skill/
    // taskType/tier/mode are GONE — resolution lives in the compiled
    // Orchestrator policy (the composer view), and the server rejects them.
    const base: ListConfigPatch = isManual
      ? { title: cfg.title.trim(), validNext: cfg.validNext }
      : {
          title: cfg.title.trim(),
          executePrompt: cfg.executePrompt,
          routerPrompt: cfg.routerPrompt,
          validNext: cfg.validNext,
          trigger: cfg.trigger,
          beatCron: cfg.trigger === "scheduler-beat" ? (cfg.beatCron && cfg.beatCron.trim() ? cfg.beatCron.trim() : null) : null
        };
    // Carry the rev we loaded so the server can reject a stale write (409).
    const patch: ListConfigPatch = rev != null ? { ...base, rev } : base;
    try {
      await api.patchList(cfg.id, patch);
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg);
      setSaving(false);
      // On a stale-board 409 (another edit landed first), pull the latest server
      // state + rev so the editor shows reality and the user can re-apply onto it.
      if (/changed under you/i.test(msg)) reload();
    }
  }

  return (
    <Sheet title={`Configure: ${cfg.title}`} onClose={onClose}>
      <div className="detail-meta">
        <span className="chip">id: {cfg.id}</span>
        <span className="chip">kind: {cfg.kind}</span>
        {cfg.interactive && <span className="chip">interactive</span>}
        {cfg.terminal && <span className="chip">terminal</span>}
      </div>

      {isManual && (
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          This is a manual column — only its title and where it can route are configurable.
        </p>
      )}

      <div className="field">
        <label htmlFor="lc-title">Title</label>
        <input id="lc-title" type="text" value={cfg.title}
          onChange={(e) => set("title", e.target.value)} />
      </div>

      {!isManual && (
        <>
          <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
            This list runs the <strong>{cfg.phase ?? cfg.id}</strong> phase. Its skill, model,
            effort and runtime come from the compiled Orchestrator policy — configure them in
            the Orchestrator composer view, not here (D15).
          </p>
          <div className="field">
            <label htmlFor="lc-trigger">Trigger</label>
            <select id="lc-trigger" value={cfg.trigger} onChange={(e) => set("trigger", e.target.value)}>
              {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {cfg.trigger === "scheduler-beat" && (
            <div className="field">
              <label>Schedule</label>
              <ScheduleField value={cfg.beatCron} onChange={(cron) => set("beatCron", cron)} />
            </div>
          )}
          <div className="field">
            <label htmlFor="lc-exec">Execute prompt</label>
            <textarea id="lc-exec" value={cfg.executePrompt} placeholder="What the operative is told to do on this list"
              onChange={(e) => set("executePrompt", e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="lc-router">Router prompt</label>
            <textarea id="lc-router" value={cfg.routerPrompt} placeholder="How to pick the next list (end with one validNext id)"
              onChange={(e) => set("routerPrompt", e.target.value)} />
          </div>
        </>
      )}

      <div className="field">
        <label>Next action (where a card can go from here)</label>
        <div className="tag-list">
          {cfg.validNext.length === 0 && (
            <span className="muted" style={{ fontSize: 12.5 }}>none yet - a card here can&apos;t advance until you add one</span>
          )}
          {cfg.validNext.map((id) => {
            const l = allListIds.find((x) => x.id === id);
            return (
              <span key={id} className="tag">
                <span className="tag-label">{l?.title ?? id}</span>
                <button type="button" className="tag-x" aria-label={`remove ${l?.title ?? id}`} title="remove"
                  onClick={() => toggleNext(id)}>×</button>
              </span>
            );
          })}
        </div>
        {addableNext.length > 0 && (
          <select className="tag-add" value="" onChange={(e) => { if (e.target.value) toggleNext(e.target.value); }}>
            <option value="">+ add a next list…</option>
            {addableNext.map((l) => <option key={l.id} value={l.id}>{l.title} ({l.id})</option>)}
          </select>
        )}
      </div>

      {err && <div className="banner" style={{ marginTop: 12 }}>{err}</div>}
      <button className="btn primary" disabled={saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save list config"}
      </button>
    </Sheet>
  );
}

// ── generic modal sheet ─────────────────────────────────────────────────────
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sh-head">
          <h3>{title}</h3>
          <button className="btn small" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </div>
        <div className="sh-body">{children}</div>
      </div>
    </div>
  );
}

// ── app ─────────────────────────────────────────────────────────────────────
type Overlay =
  | { kind: "new" }
  | { kind: "move"; card: CardSummary }
  | { kind: "detail"; cardId: string }
  | { kind: "watch"; card: CardSummary }
  | { kind: "config"; listId: string }
  | null;

function App() {
  const [board, setBoard] = useState<BoardView | null>(null);
  const [runtime, setRuntime] = useState<BoardRuntime | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const b = await api.board();
      setBoard(b);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // /board/runtime carries the live channel id (for Discuss) and the noGateway
  // flag. Refreshed alongside the board so a gateway start/stop or a channel
  // install/remove flips the relevant UI within one tick.
  const loadRuntime = useCallback(async () => {
    try {
      const r = await api.runtime();
      setRuntime(r);
    } catch {
      // /board/runtime missing (older server build) → leave runtime null; the UI
      // falls back to "no web channel" copy. Not fatal.
      // Deliberate no-op functional update: documents "keep prior state" so the catch doesn't read as missing error handling.
      setRuntime((prev) => prev);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadRuntime();
    const t = setInterval(() => { void load(); void loadRuntime(); }, 5000);
    return () => clearInterval(t);
  }, [load, loadRuntime]);

  async function onStart(card: CardSummary) {
    setBusyCard(card.id);
    setNotice(null);
    try {
      const res = await api.start(card.id);
      await load();
      setNotice(res.advanced ? `Moved to ${res.advanced}` : "Dispatched");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCard(null);
    }
  }

  // WS2 (D7): continue a DONE card's work in one click — create a successor card
  // (continues=<id>, its prompt seeded from the predecessor's handoff packet) and
  // move it to plan so the run dispatches. A fresh backlog card is not engine-owned,
  // so the human move to plan is allowed and auto-dispatches.
  async function onContinue(card: CardSummary) {
    setBusyCard(card.id);
    setNotice(null);
    try {
      const created = await api.create({
        continues: card.id,
        title: `Continue: ${card.title || "(untitled)"}`,
        project: card.project ?? undefined
      });
      const newId = created.card.id;
      try {
        await api.patch(newId, { list: "plan", rev: created.card.rev });
      } catch {
        /* the move raced (project inference bumped the rev) — the card stays in
           Backlog; the user can move it to To Do. Never fail the whole action. */
      }
      await load();
      setNotice(`Continuation created${newId ? ` (${newId.slice(-6)})` : ""}`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCard(null);
    }
  }

  // Open a James-mode Discuss session seeded with this card. buildDiscussUrl carries
  // the card context + an auto-sent kickoff (analyse the description, ask questions,
  // write the brief). Crossing fittings: the board runs embedded (/embed/kanban-loop),
  // so when embedded we ask the Garrison shell to swap the embedded view (its
  // postMessage listener); standalone we navigate directly. The channel id is
  // discovered at runtime (not hardcoded) so a non-default web channel works too.
  function onDiscuss(card: CardSummary) {
    const channelId = runtime?.webChannelEmbedId ?? null;
    if (!channelId) {
      setNotice("No web channel is installed/running — install/start a web channel fitting to use Discuss.");
      return;
    }
    const chatHref = buildDiscussUrl(card, { webChannelBase: `/embed/${channelId}`, cardsAbsDir: runtime?.cardsAbsDir ?? null });
    const u = new URL(chatHref, window.location.origin);
    const fittingId = u.pathname.split("/").filter(Boolean).pop() || channelId;
    const params: Record<string, string> = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    if (window.top && window.top !== window.self) {
      window.top.postMessage({ type: "garrison:navigate-fitting", fittingId, params }, "*");
    } else {
      window.location.href = chatHref;
    }
  }

  // Apply a card's prepared revert (S2, Q7). A guarded, deliberate press: a native
  // confirm() first (the server ALSO requires an explicit confirm), then the board
  // reloads so the descriptor's new state (applied / conflict) shows either way.
  async function onRevert(card: CardSummary) {
    const n = card.preparedRevert?.commits ?? 0;
    if (!window.confirm(`Apply the prepared revert of ${n} commit${n === 1 ? "" : "s"}? This adds revert commits to the shared branch.`)) return;
    setBusyCard(card.id);
    setNotice(null);
    try {
      const res = await api.revert(card.id);
      setNotice(res.preparedRevert?.state === "applied" ? "Revert applied" : `Revert ${res.preparedRevert?.state ?? "done"}`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      await load();
      setBusyCard(null);
    }
  }

  // Infer the project for a no-project card — fire-and-forget on the server; the
  // "inferring…" pill + the result event show on the next poll.
  async function onInfer(card: CardSummary) {
    setBusyCard(card.id);
    setNotice(null);
    try {
      await api.inferProject(card.id);
      await load();
      setNotice("Inferring the project…");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyCard(null);
    }
  }

  if (err && !board) {
    return (
      <>
        <TopBar onNew={() => setOverlay({ kind: "new" })} status="error" />
        <div className="banner">Could not load the board: {err}</div>
      </>
    );
  }

  return (
    <>
      <TopBar onNew={() => setOverlay({ kind: "new" })} status={board ? `${board.cards.length} cards` : "loading…"} />
      {runtime?.noGateway && (
        <div className="banner" role="status">
          No gateway running - agent lists won&apos;t dispatch. Bring the composition up (Run / `npm start`).
        </div>
      )}
      {notice && <div className="banner info" onClick={() => setNotice(null)}>{notice}</div>}
      <div className="board-scroll">
        <div className="board">
          {board?.lists.map((list) => (
            <section key={list.id} className={listClass(list)}>
              <div className="lh">
                <div className="lname">
                  <span className="lname-text">{list.title}</span>
                  <span className="count">{list.cards.length}</span>
                  <button
                    className="gear"
                    title={`Configure ${list.title}`}
                    aria-label={`Configure ${list.title}`}
                    onClick={() => setOverlay({ kind: "config", listId: list.id })}
                  >
                    <GearIcon />
                  </button>
                </div>
                <div className="lkind">
                  {list.kind === "agent" && !list.interactive ? (
                    <span className={list.phase?.includes("adversarial") ? "cdx" : "sk"} title="the pipeline phase this list runs; skill/model/effort come from the Orchestrator policy">
                      phase: {list.phase ?? list.id}
                    </span>
                  ) : list.interactive ? (
                    "interactive · web chat"
                  ) : (
                    `${list.kind} · ${list.trigger}`
                  )}
                </div>
              </div>
              <div className="lbody">
                {/* Backlog leads with the inline quick-add affordance (its own empty
                    state), so it never shows the bare "empty" label. */}
                {list.id === "backlog" && <BacklogAddCard onCreated={() => void load()} />}
                {list.cards.length === 0 && list.id !== "backlog" && <div className="lempty">empty</div>}
                {(() => {
                  const renderCard = (card: CardSummary) => (
                    <Card
                      key={card.id}
                      card={card}
                      list={list}
                      busy={busyCard === card.id}
                      onStart={onStart}
                      onInfer={onInfer}
                      onDiscuss={onDiscuss}
                      onRevert={onRevert}
                      onMove={(c) => {
                        // One valid next list → just move (the server auto-dispatches if
                        // it's an immediate agent list); only ASK when there's a choice.
                        const tgts = list.validNext;
                        if (tgts.length === 1) {
                          void api.patch(c.id, { list: tgts[0], rev: c.rev }).then(() => load()).catch(() => load());
                        } else {
                          setOverlay({ kind: "move", card: c });
                        }
                      }}
                      onWatch={(c) => setOverlay({ kind: "watch", card: c })}
                      onOpen={(c) => setOverlay({ kind: "detail", cardId: c.id })}
                      onContinue={onContinue}
                    />
                  );
                  // D19: the Done column groups quick cards (trivial-plan inline tasks)
                  // under a collapsed "quick tasks" strip so the real runs stay legible.
                  if (list.id !== "done") return list.cards.map(renderCard);
                  const quickCards = list.cards.filter((c) => c.quick);
                  const mainCards = list.cards.filter((c) => !c.quick);
                  return (
                    <>
                      {mainCards.map(renderCard)}
                      {quickCards.length > 0 && (
                        <details className="quick-strip">
                          <summary className="quick-strip-head">
                            <span className="quick-strip-title">quick tasks</span>
                            <span className="count">{quickCards.length}</span>
                          </summary>
                          <div className="quick-strip-body">{quickCards.map(renderCard)}</div>
                        </details>
                      )}
                    </>
                  );
                })()}
              </div>
            </section>
          ))}
        </div>
      </div>

      {overlay?.kind === "new" && (
        <NewCardSheet onClose={() => setOverlay(null)} onCreated={() => void load()} />
      )}
      {overlay?.kind === "move" && board && (
        <MoveSheet card={overlay.card} board={board} onClose={() => setOverlay(null)} onMoved={() => void load()} />
      )}
      {overlay?.kind === "detail" && (
        <DetailSheet cardId={overlay.cardId} onClose={() => setOverlay(null)} onChanged={() => void load()} />
      )}
      {overlay?.kind === "watch" && (
        <WatchSheet
          card={overlay.card}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay?.kind === "config" && board && (
        <ListConfigSheet listId={overlay.listId} board={board} onClose={() => setOverlay(null)} onSaved={() => void load()} />
      )}
    </>
  );
}

function TopBar({ onNew, status }: { onNew: () => void; status: string }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark"><BoardMark /></span>
        <span className="brand-text">
          <span className="name">Kanban Loop</span>
          <span className="sub">Workflow Board</span>
        </span>
      </div>
      <span className="status">{status}</span>
      <div className="spacer" />
      <button className="btn primary" onClick={onNew}><PlusIcon /> New card</button>
    </header>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);

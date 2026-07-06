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
  type ListView,
  type ListConfig,
  type ListConfigPatch,
  type ArtifactRef
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
  ChatIcon
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
  if (list.skill && list.skill.includes("adversarial")) return "list codex";
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
  busy: boolean;
}) {
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
        {card.parkedFrom && <span className="chip" title="the list it parked from">from {card.parkedFrom}</span>}
        {list.kind === "agent" && (
          <span className="chip">iter {card.iterations}/{ITERATION_CAP}</span>
        )}
        {card.goalMode && <span className="chip goal">goalMode</span>}
        {dispatchErr && (
          <span className="chip attn" title={dispatchErr.message}>{dispatchErr.reason}</span>
        )}
      </div>

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

      {/* PARKED: the human reason (no jargon) + what the operative actually said. */}
      {parked && card.attentionReason && (
        <div className="dispatch-err">{card.attentionReason}</div>
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
        {canInfer && (
          <button className="btn small" disabled={busy} title="infer the project from the description" onClick={() => onInfer(card)}>
            <SparkIcon /> Infer
          </button>
        )}
        <button className="btn small" disabled={busy} onClick={() => onMove(card)}>
          <MoveIcon /> Move
        </button>
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
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The repos under the dev-root (dev-env parity). Best-effort — on failure the picker
  // still offers "(auto-infer)" + "Custom path…".
  useEffect(() => {
    let alive = true;
    api.projects().then((v) => { if (alive) setProjects(v.projects); }).catch(() => { /* leave empty */ });
    return () => { alive = false; };
  }, []);

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
    try {
      await api.create({ title: title.trim() || undefined, project: proj, description, goalMode });
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
      {err && <div className="banner">{err}</div>}
      <button className="btn primary" disabled={saving} onClick={() => void submit()}>
        {saving ? "Creating…" : "Create card"}
      </button>
    </Sheet>
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
function LinkRow({ label, refs }: { label: string; refs: ArtifactRef | ArtifactRef[] | null }) {
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
              <a href={href} target="_blank" rel="noreferrer" style={dim ? { opacity: 0.55 } : undefined}>
                {label2}{dim ? " (pending)" : ""}
              </a>
            </span>
          );
        })}
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
                  <a key={i} className="ev-shot" href={url} target="_blank" rel="noreferrer" title={e.name}>
                    <img src={url} alt={e.name ?? "evidence"} loading="lazy" />
                    <span className="ev-name">{e.name}</span>
                  </a>
                ) : (
                  <a key={i} className="ev-file" href={url} target="_blank" rel="noreferrer" title={e.name}>
                    <LinkIcon /> {e.name}
                  </a>
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
          events.map((ev, i) => <TimelineEvent key={`${ev.at}:${ev.kind}:${i}`} ev={ev} />)
        )}
      </div>

      {/* Pointer table for the rest of the artifacts (evidence itself renders in the
          Evidence section above; the evidence-index json stays here as a raw pointer). */}
      <div className="links">
        <LinkRow label="plan" refs={links.plan} />
        <LinkRow label="brief" refs={links.brief} />
        <LinkRow label="sessions" refs={links.sessions} />
        <LinkRow label="gate markers" refs={links.gateMarkers} />
        <LinkRow label="evidence index" refs={links.evidenceIndex} />
        <LinkRow label="video" refs={links.video} />
        <LinkRow label="logs" refs={links.logs} />
      </div>

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
// The three operative faces. Mode is a dropdown (not free text): a card is routed to
// one of these. "(none)" leaves it to the orchestrator's default.
const MODES = ["gary", "joe", "james"];

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
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);

  // The installed skills, for the Skill field's searchable list. Best-effort.
  useEffect(() => {
    let alive = true;
    api.skills().then((v) => { if (alive) setSkills(v.skills); }).catch(() => { /* leave empty */ });
    return () => { alive = false; };
  }, []);

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
  // The mode dropdown offers the three faces; if a list carries a legacy/custom mode
  // not in that set, keep it as an extra option so a save doesn't silently drop it.
  const modeOptions = cfg.mode && !MODES.includes(cfg.mode) ? [...MODES, cfg.mode] : MODES;
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
    // (the server rejects agent-only fields on a manual list).
    // taskType/tier are intentionally NOT sent — the orchestrator classifies the tier.
    // beatCron is only meaningful for a scheduler-beat list (cleared otherwise).
    const base: ListConfigPatch = isManual
      ? { title: cfg.title.trim(), validNext: cfg.validNext }
      : {
          title: cfg.title.trim(),
          skill: cfg.skill && cfg.skill.trim() ? cfg.skill.trim() : null,
          executePrompt: cfg.executePrompt,
          routerPrompt: cfg.routerPrompt,
          validNext: cfg.validNext,
          trigger: cfg.trigger,
          beatCron: cfg.trigger === "scheduler-beat" ? (cfg.beatCron && cfg.beatCron.trim() ? cfg.beatCron.trim() : null) : null,
          mode: cfg.mode && cfg.mode.trim() ? cfg.mode.trim() : null
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
          <div className="field">
            <label htmlFor="lc-skill">Skill</label>
            <input id="lc-skill" type="text" list="lc-skill-options" value={cfg.skill ?? ""}
              placeholder="search installed skills (blank = none)"
              onChange={(e) => set("skill", e.target.value)} />
            <datalist id="lc-skill-options">
              {skills.map((s) => <option key={s.name} value={s.name}>{s.description}</option>)}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor="lc-mode">Mode</label>
            <select id="lc-mode" value={cfg.mode ?? ""} onChange={(e) => set("mode", e.target.value || null)}>
              <option value="">(none — orchestrator default)</option>
              {modeOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
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
          <p className="muted" style={{ marginTop: -2, marginBottom: 12, fontSize: 12 }}>
            Tier is chosen by the orchestrator per task — there's no per-list tier to set.
          </p>
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
            <span className="muted" style={{ fontSize: 12.5 }}>none yet — a card here can't advance until you add one</span>
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

  // Deep-link support: `?card=<id>` opens that card's detail overlay on load —
  // used by the Jarvis Tasks panel ("jump straight to a card") and by the embed
  // route, which forwards its query string (incl. garrison:navigate-fitting
  // params) onto the board iframe. `popstate` handles following another card link
  // in-tab without a full reload. The id must look like a ULID or it's ignored
  // (a bad id would only 404 in DetailSheet).
  useEffect(() => {
    const openFromUrl = () => {
      const id = new URLSearchParams(window.location.search).get("card");
      if (id && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) setOverlay({ kind: "detail", cardId: id });
    };
    openFromUrl();
    window.addEventListener("popstate", openFromUrl);
    return () => window.removeEventListener("popstate", openFromUrl);
  }, []);

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
    const chatHref = buildDiscussUrl(card, { webChannelBase: `/embed/${channelId}` });
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
          No gateway running — agent lists won't dispatch. Bring the composition up (Run / `npm start`).
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
                  {list.skill ? (
                    <span className={list.skill.includes("adversarial") ? "cdx" : "sk"}>{list.skill}</span>
                  ) : list.interactive ? (
                    "interactive · web chat"
                  ) : (
                    `${list.kind} · ${list.trigger}`
                  )}
                </div>
              </div>
              <div className="lbody">
                {list.cards.length === 0 && <div className="lempty">empty</div>}
                {list.cards.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    list={list}
                    busy={busyCard === card.id}
                    onStart={onStart}
                    onInfer={onInfer}
                    onDiscuss={onDiscuss}
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
                  />
                ))}
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
    <div className="topbar">
      <div className="brand">Kanban Loop<span className="sub">workflow board</span></div>
      <span className="status">{status}</span>
      <div className="spacer" />
      <button className="btn primary" onClick={onNew}><PlusIcon /> New card</button>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);

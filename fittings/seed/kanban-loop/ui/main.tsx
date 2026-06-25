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
  type CardSummary,
  type CardDetail,
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
  GearIcon
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

// ── card front ──────────────────────────────────────────────────────────────
function Card({
  card,
  list,
  onStart,
  onMove,
  onWatch,
  onOpen,
  busy
}: {
  card: CardSummary;
  list: ListView;
  onStart: (c: CardSummary) => void;
  onMove: (c: CardSummary) => void;
  onWatch: (c: CardSummary) => void;
  onOpen: (c: CardSummary) => void;
  busy: boolean;
}) {
  // An interactive list (Discuss) advances ONLY by manual Move (the operative
  // writes a brief in James-mode web chat first) — so no Start/Advance button for
  // it; Watch opens the chat and Move is the gate.
  const canAdvance = list.validNext.length > 0 && !list.terminal && !list.interactive;
  const startLabel = list.kind === "agent" ? "Start" : "Advance";
  return (
    <div className="card">
      <div className="ct">
        <span className={dotClass(card)} aria-hidden />
        <span className="title">{card.title}</span>
      </div>
      <div className="cmeta">
        {card.project ? <span className="chip">{card.project}</span> : <span className="chip muted">no project</span>}
        {card.status === "needs-attention" && <span className="chip attn">needs-attention</span>}
        {list.kind === "agent" && (
          <span className="chip">iter {card.iterations}/{ITERATION_CAP}</span>
        )}
        {card.goalMode && <span className="chip goal">goalMode</span>}
      </div>
      <div className="btns">
        {canAdvance && (
          <button className="btn primary small" disabled={busy} onClick={() => onStart(card)}>
            <PlayIcon /> {startLabel}
          </button>
        )}
        <button className="btn small" disabled={busy} onClick={() => onMove(card)}>
          <MoveIcon /> Move
        </button>
        <button className="btn small" onClick={() => onWatch(card)}>
          <WatchIcon /> Watch
        </button>
        <button className="btn small" onClick={() => onOpen(card)}>
          <OpenIcon /> Open
        </button>
      </div>
    </div>
  );
}

// ── new-card sheet ──────────────────────────────────────────────────────────
function NewCardSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [description, setDescription] = useState("");
  const [goalMode, setGoalMode] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!title.trim()) { setErr("Title is required"); return; }
    setSaving(true);
    setErr(null);
    try {
      await api.create({ title: title.trim(), project: project.trim() || undefined, description, goalMode });
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Sheet title="New card → Backlog" onClose={onClose}>
      <div className="field">
        <label htmlFor="nc-title">Title</label>
        <input id="nc-title" type="text" value={title} autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
      </div>
      <div className="field">
        <label htmlFor="nc-project">Project</label>
        <input id="nc-project" type="text" value={project} placeholder="optional"
          onChange={(e) => setProject(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="nc-desc">Description</label>
        <textarea id="nc-desc" value={description} placeholder="optional"
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

function DetailSheet({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.card(cardId).then((d) => { if (alive) setDetail(d); }).catch((e) => {
      if (alive) setErr(e instanceof Error ? e.message : String(e));
    });
    return () => { alive = false; };
  }, [cardId]);

  if (err) return <Sheet title="Card" onClose={onClose}><div className="banner">{err}</div></Sheet>;
  if (!detail) return <Sheet title="Card" onClose={onClose}><p className="muted">Loading…</p></Sheet>;

  const { card, links, decisionLog } = detail;
  return (
    <Sheet title={card.title} onClose={onClose}>
      <div className="detail-meta">
        {card.project && <span className="chip">proj: {card.project}</span>}
        <span className="chip">list: {card.list}</span>
        <span className="chip">iter {card.iterations}/{ITERATION_CAP}</span>
        {card.goalMode && <span className="chip goal">goalMode</span>}
        {card.runId && <span className="chip">run: {card.runId.slice(0, 8)}</span>}
        {card.sliceId && <span className="chip">slice: {card.sliceId}</span>}
      </div>

      <div className="links">
        <LinkRow label="plan" refs={links.plan} />
        <LinkRow label="brief" refs={links.brief} />
        <LinkRow label="sessions" refs={links.sessions} />
        <LinkRow label="gate markers" refs={links.gateMarkers} />
        <LinkRow label="evidence" refs={links.evidenceIndex} />
        <LinkRow label="screenshots" refs={links.evidenceIndex /* screenshots live under the run dir; evidence-index points to them */} />
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
    </Sheet>
  );
}

// ── watch sheet — SSE log / web-chat / static logs (never tmux) ─────────────
function WatchSheet({
  card,
  list,
  onClose
}: {
  card: CardSummary;
  list: ListView | undefined;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string>("");
  const [live, setLive] = useState<boolean | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const scrRef = useRef<HTMLDivElement | null>(null);

  // Interactive list (Discuss): Watch means CONVERSE, not tail a log. Open the
  // shared web channel in James mode (the one context-driven chat surface),
  // carrying the card context. We never open a raw terminal.
  const interactive = Boolean(list?.interactive);

  useEffect(() => {
    if (interactive) return;
    const es = new EventSource(api.watchUrl(card.id));
    es.addEventListener("mode", (e) => {
      try { setLive(JSON.parse((e as MessageEvent).data).live); } catch { /* ignore */ }
    });
    es.addEventListener("log", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        setLines((prev) => (d.append ? prev + d.text : prev + (prev ? "\n" : "") + d.text));
      } catch { /* ignore */ }
    });
    es.addEventListener("end", (e) => {
      try { setDone(JSON.parse((e as MessageEvent).data).reason ?? "ended"); } catch { setDone("ended"); }
      es.close();
    });
    es.onerror = () => { es.close(); setDone((d) => d ?? "disconnected"); };
    return () => es.close();
  }, [card.id, interactive]);

  useEffect(() => {
    if (scrRef.current) scrRef.current.scrollTop = scrRef.current.scrollHeight;
  }, [lines]);

  if (interactive) {
    // buildDiscussUrl carries the card as an OPAQUE base64 context blob the
    // generic web channel forwards verbatim to James (the operative), who
    // decodes it and writes the brief to disk under briefsPath.
    const chatHref = buildDiscussUrl(card);
    return (
      <Sheet title={`Discuss: ${card.title}`} onClose={onClose}>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          This is an interactive list — Watch opens the conversation, not a log. The operative in James
          mode talks it through with you and writes a brief to disk.
        </p>
        <a className="btn primary" href={chatHref} target="_top">Open web chat (James mode)</a>
      </Sheet>
    );
  }

  // Highlight the Adv-Review "CODEX CALL" line (FINDING 6).
  const rendered = lines.split("\n").map((l, i) => (
    <div key={i} className={/CODEX CALL/i.test(l) ? "codexline" : undefined}>{l || " "}</div>
  ));

  return (
    <Sheet title={`Watch: ${card.title}`} onClose={onClose}>
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
    const base: ListConfigPatch = isManual
      ? { title: cfg.title.trim(), validNext: cfg.validNext }
      : {
          title: cfg.title.trim(),
          skill: cfg.skill && cfg.skill.trim() ? cfg.skill.trim() : null,
          executePrompt: cfg.executePrompt,
          routerPrompt: cfg.routerPrompt,
          validNext: cfg.validNext,
          trigger: cfg.trigger,
          mode: cfg.mode && cfg.mode.trim() ? cfg.mode.trim() : null,
          taskType: cfg.taskType && cfg.taskType.trim() ? cfg.taskType.trim() : null,
          tier: cfg.tier && cfg.tier.trim() ? cfg.tier.trim() : null
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
            <input id="lc-skill" type="text" value={cfg.skill ?? ""} placeholder="e.g. autothing-plan (blank = none)"
              onChange={(e) => set("skill", e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="lc-trigger">Trigger</label>
            <select id="lc-trigger" value={cfg.trigger} onChange={(e) => set("trigger", e.target.value)}>
              {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field grid2">
            <div>
              <label htmlFor="lc-tasktype">Task type</label>
              <input id="lc-tasktype" type="text" value={cfg.taskType ?? ""} placeholder="e.g. code"
                onChange={(e) => set("taskType", e.target.value)} />
            </div>
            <div>
              <label htmlFor="lc-tier">Tier</label>
              <input id="lc-tier" type="text" value={cfg.tier ?? ""} placeholder="e.g. T1-standard"
                onChange={(e) => set("tier", e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="lc-mode">Mode</label>
            <input id="lc-mode" type="text" value={cfg.mode ?? ""} placeholder="e.g. joe / james (blank = none)"
              onChange={(e) => set("mode", e.target.value)} />
          </div>
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
        <label>Next action (valid next lists)</label>
        <div className="next-grid">
          {allListIds.length === 0 && <span className="muted">no lists</span>}
          {allListIds.map((l) => (
            <label key={l.id} className="next-opt">
              <input type="checkbox" checked={cfg.validNext.includes(l.id)} onChange={() => toggleNext(l.id)} />
              <span>{l.title}</span>
              <span className="muted" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{l.id}</span>
            </label>
          ))}
        </div>
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

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000); // keep the board fresh as ticks move cards
    return () => clearInterval(t);
  }, [load]);

  const listFor = (id: string) => board?.lists.find((l) => l.id === id);

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
                    onMove={(c) => setOverlay({ kind: "move", card: c })}
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
        <DetailSheet cardId={overlay.cardId} onClose={() => setOverlay(null)} />
      )}
      {overlay?.kind === "watch" && (
        <WatchSheet card={overlay.card} list={listFor(overlay.card.list)} onClose={() => setOverlay(null)} />
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

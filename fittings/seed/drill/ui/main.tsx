import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, Crosshair, Plus, X, Eye, FileCode2, Monitor, Tablet, Smartphone, Camera, NotebookPen, ArrowLeft, ArrowRight, RotateCw, RefreshCcw, ExternalLink, Terminal, Ruler } from "lucide-react";

// ─── API ─────────────────────────────────────────────────────────────────
// Drill's own server serves this UI, so relative paths hit the same origin.

async function apiGet(path: string) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
}
async function apiPatch(path: string, body: unknown) {
  const r = await fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH ${path}: ${r.status}`);
  return r.json();
}
async function apiPost(path: string, body: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `POST ${path}: ${r.status}`);
  return j;
}

interface DrillBook {
  app: { name: string; url: string };
  fullDrill: boolean;
  autonomy: "gated" | "auto";
  viewports: string[];
  globalRules: string;
  dispatch: "manual" | "heartbeat" | "immediate";
  pages: Array<{ id: string; title: string; path: string; mode: "steps" | "whole"; selected: boolean }>;
}

interface Anchors {
  testId: string | null;
  role: string | null;
  ariaLabel: string | null;
  text: string | null;
  tag: string;
  css: string | null;
  cssMethod: string | null;
  xpath: string | null;
}
interface Pct { leftPct: number; topPct: number; widthPct: number; heightPct: number }
interface Area { n: number; id: string; label: string; anchors: Anchors; pct: Pct | null }
interface Step {
  id: string;
  area: number; // 0 = page-level
  mode: "vision" | "e2e";
  enabled: boolean;
  viewports: string[];
  state: string;
  description: string;
  ref?: string;
  spec?: string;
  tags: string[];
  judgment?: boolean; // B9/Q3: needs ongoing model judgment (drillJudge()) - never a one-time deterministic find
  assertion?: unknown; // set once graduated (B8)
}
interface DrillState { id: string; label: string; matcher?: unknown; reachPath?: unknown[]; screenshotPath?: string | null }
interface DrillPage {
  id: string;
  title: string;
  path: string;
  mode: "steps" | "whole";
  areas: Area[];
  steps: Step[];
  states: DrillState[];
}

const VIEWPORTS: Array<{ id: string; label: string; icon: typeof Monitor }> = [
  { id: "desktop", label: "desktop", icon: Monitor },
  { id: "tablet", label: "tablet", icon: Tablet },
  { id: "mobile", label: "mobile", icon: Smartphone }
];

let stepSeq = 0;
function newStepId() { stepSeq += 1; return `s${Date.now()}-${stepSeq}`; }

// Inline explainer used at the top of every surface and section - the UI
// must say what each area is FOR and how to read it, not assume the mock's
// vocabulary is self-evident.
function Help({ children }: { children: React.ReactNode }) {
  return <p className="dr-help">{children}</p>;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Keyboard/AT affordances for the clickable chip spans - they are styled
// spans, not buttons, so without these they are mouse-only and invisible to
// assistive tech.
function chipAction(onClick: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
    }
  };
}

// ─── project selection + app-under-test lifecycle ────────────────────────

interface Project { name: string; path: string; runSkill: string | null; hasDrillBook: boolean; active: boolean }
interface ProjectsInfo { projects: Project[]; active: { root: string; name: string } | null; selected: boolean; devRoot: string }
interface AppStartJob { status: string; skill: string | null; error: string | null; url: string | null; logFile: string | null }
interface AppStatus { root: string; url: string | null; configured: boolean; reachable: boolean; runSkill: string | null; selected?: boolean; job: AppStartJob | null }
interface PlanJob { status: string; mode: string; brief: string | null; error: string | null; logFile: string | null; pages: number | null }
interface PlanStatus { root: string; pages: number; selected: boolean; job: PlanJob | null }

// Make sure the app under test is serving before a run: reachable -> done;
// down -> start it through the project's run-<project> skill (a headless
// agent session server-side) and poll until ready or the job fails.
async function ensureAppUp(onPhase: (msg: string | null) => void): Promise<AppStatus> {
  let st = (await apiGet("/api/app/status")) as AppStatus;
  if (st.reachable) return st;
  // Pin the root this start is FOR: the server resolves the live selection
  // per request, and a project switch in another tab mid-start would
  // otherwise swing the poll onto the other project's app.
  const root = st.root;
  onPhase(st.runSkill ? `Starting app via ${st.runSkill}…` : "App not running - starting…");
  const kick = await apiPost("/api/app/start", { root });
  if (kick.reachable) return { ...st, reachable: true };
  // Client-side deadline slightly above the server job's own (240s default):
  // every other exit depends on the job object reporting sanely.
  const deadline = Date.now() + 270000;
  let readyMisses = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    st = (await apiGet(`/api/app/status?root=${encodeURIComponent(root)}`)) as AppStatus;
    if (st.reachable) { onPhase(null); return st; }
    if (st.job && st.job.status === "failed") throw new Error(st.job.error || "app start failed");
    // The job lives in the drill server's memory - it reporting NO job after
    // we kicked one means the server restarted mid-start; bail rather than
    // poll forever.
    if (!st.job) throw new Error("app start job lost (drill server restarted?) - retry Run");
    // A terminal "ready" job with an unreachable URL never flips to "failed"
    // server-side (the app crashed post-probe, or the Book URL stayed empty)
    // - it would spin here forever. One transient miss is tolerated.
    if (st.job.status === "ready" && ++readyMisses >= 2) {
      throw new Error(`app start reported ready but ${st.url || st.job.url || "the app URL"} is not reachable - check the app or the Drill Book URL`);
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the app to come up - see the app-start log");
    onPhase(st.job.skill ? `Starting app via ${st.job.skill}…` : "Waiting for the app to come up…");
  }
}

// Agent-driven Book planning (the duty's stage 1, card-free): kick the
// headless planning session and poll until it finishes - the direct-run path
// never dead-ends at "author pages manually"; Authoring is the override
// surface. With join=true this never kicks anything: it attaches to an
// in-flight plan if one exists (a reload mid-plan) and otherwise returns the
// current status untouched - the mount path must not spawn agent sessions
// the user never asked for.
async function ensurePlanned(
  { brief = null, join = false }: { brief?: string | null; join?: boolean },
  onPhase: (msg: string | null) => void
): Promise<PlanStatus> {
  let st = (await apiGet("/api/plan/status")) as PlanStatus;
  const inFlight = !!st.job && st.job.status === "planning";
  if (join && !inFlight) return st;
  // Pin the root this plan is FOR (the server resolves the live selection per
  // request; a project switch in another tab must not swing this poll onto
  // the other project's job).
  const root = st.root;
  if (!inFlight) {
    onPhase("Planning the Drill Book…");
    await apiPost("/api/plan/start", brief ? { brief, root } : { root });
  } else if (brief) {
    // Joining an in-flight plan would silently swallow the brief - refuse.
    throw new Error("a plan is already running for this project - wait for it to finish before planning an update");
  }
  // Client-side deadline slightly above the server job's own (30min default):
  // every other exit depends on the job object reporting sanely.
  const deadline = Date.now() + 1860000;
  for (;;) {
    st = (await apiGet(`/api/plan/status?root=${encodeURIComponent(root)}`)) as PlanStatus;
    if (st.job && st.job.status === "done") { onPhase(null); return st; }
    if (st.job && st.job.status === "failed") throw new Error(st.job.error || "planning failed");
    // The job lives in the drill server's memory - no job after we kicked one
    // means the server restarted mid-plan; bail rather than poll forever.
    if (!st.job) throw new Error("plan job lost (drill server restarted?) - retry");
    if (Date.now() > deadline) throw new Error("timed out waiting for planning to finish - see the plan log");
    onPhase(st.job.mode === "update"
      ? "Planning the Book update - an agent session is authoring the pages and steps this change touches…"
      : "Planning the Drill Book - an agent session is exploring the app and authoring pages, steps, and states…");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Topbar quick-switcher. "custom path…" hands off to the full picker dialog
// (dev-env's StartSessionDialog pattern) for paths outside the dev root.
function ProjectBar({ info, onOpenPicker }: { info: ProjectsInfo | null; onOpenPicker: () => void }) {
  const [switching, setSwitching] = useState(false);
  if (!info) return null;
  const onChange = async (p: string) => {
    if (p === "__custom") { onOpenPicker(); return; }
    if (!p || p === info.active?.root) return;
    setSwitching(true);
    try {
      await apiPost("/api/projects/select", { path: p });
      // Everything on screen (book, pages, runs) is scoped to the previous
      // project - a full reload is the honest reset.
      location.reload();
    } catch {
      setSwitching(false);
    }
  };
  return (
    <div className="dr-project">
      <span className="dr-lbl" style={{ margin: 0 }}>Project</span>
      <select value={info.selected && info.active ? info.active.root : ""} disabled={switching} onChange={(e) => onChange(e.target.value)}>
        {(!info.selected || !info.active) && <option value="" disabled>select project…</option>}
        {info.projects.map((p) => (
          <option key={p.path} value={p.path}>{p.name}{p.runSkill ? "" : " (no run skill)"}</option>
        ))}
        <option value="__custom">custom path…</option>
      </select>
    </div>
  );
}

// The full project picker, modeled on the Dev Env "New session" dialog: pick
// one of the dev-root git repos, or type any absolute path. Opens
// automatically when Drill has no selected target (fresh install - the cwd
// fallback is never silently QA'd).
function ProjectPickerDialog({ info, onClose }: { info: ProjectsInfo; onClose: () => void }) {
  const [path, setPath] = useState<string>(info.active?.root ?? info.projects[0]?.path ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPost("/api/projects/select", { path: path.trim() });
      location.reload();
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="dr-modal-overlay" onClick={onClose}>
      <div className="dr-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Select project</h2>
        <p className="hint">
          The app under test. Projects are the git repos under <span className="mono">{info.devRoot}</span> (the
          same list as the Dev Env picker; change the dev root there). [drill book] marks projects that
          already carry a Drill Book.
        </p>
        <label>
          Project
          <select
            value={info.projects.find((p) => p.path === path) ? path : ""}
            onChange={(e) => { if (e.target.value) setPath(e.target.value); }}
          >
            {info.projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}{p.hasDrillBook ? " [drill book]" : ""}{p.runSkill ? "" : " (no run skill)"}
              </option>
            ))}
            <option value="">custom path…</option>
          </select>
        </label>
        <label>
          Path
          <input
            value={path}
            placeholder="/home/you/dev/project"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onClose(); }}
          />
        </label>
        {err && <div style={{ color: "var(--alarm)", fontSize: 11.5, marginBottom: 8 }}>{err}</div>}
        <div className="row">
          <button className="btn small" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !path.trim()} onClick={submit}>{busy ? "Selecting…" : "Select"}</button>
        </div>
      </div>
    </div>
  );
}

// Explicit (re)plan doorway: full plan when the brief is empty, an update
// scoped to a change when it names one. The agent session authors the Book;
// the Authoring surface stays the manual override.
function PlanDialog({ hasPages, onClose, onKick }: { hasPages: boolean; onClose: () => void; onKick: (brief: string | null) => void }) {
  const [brief, setBrief] = useState("");
  return (
    <div className="dr-modal-overlay" onClick={onClose}>
      <div className="dr-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Plan the Drill Book</h2>
        <p className="hint">
          A headless agent session explores the project and authors the Book on its own judgment - pages,
          steps, and states, the works. Leave the brief empty to plan the whole app
          {hasPages ? " (the agent extends and corrects the existing Book - it may revise steps, but is told never to discard manual work)" : ""}; describe
          a change to scope the plan to what it touches. Tweak the result in Authoring afterwards if you want.
        </p>
        <label>
          Change brief (optional)
          <textarea
            value={brief}
            rows={3}
            placeholder="e.g. the new invoices page: list, filters, CSV export"
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            style={{ width: "100%", padding: 8, border: "1px solid var(--rule)", background: "var(--paper-2)", color: "var(--ink)", fontSize: 12, fontFamily: "var(--sans)" }}
          />
        </label>
        <div className="row">
          <button className="btn small" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onKick(brief.trim() ? brief.trim() : null)}>
            {brief.trim() ? "Plan the update" : "Plan the whole app"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Reachability chip + start affordance, shown wherever a run can begin.
function AppStatusChip() {
  const [st, setSt] = useState<AppStatus | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => apiGet("/api/app/status").then(setSt).catch(() => {});
  // Light poll, not mount-only: the app comes up through OTHER paths (a run's
  // ensureAppUp, another view's Start) and can also crash after mount - a
  // frozen chip beside a live Run button misleads either way.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);
  if (!st) return null;
  const start = async () => {
    setErr(null);
    try {
      await ensureAppUp(setPhase);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPhase(null);
      refresh();
    }
  };
  return (
    <span className="dr-rowwrap" style={{ gap: 6 }}>
      <span className={"chip " + (st.reachable ? "sage active" : "alarm")}>{st.reachable ? "app up" : "app down"}</span>
      {!st.reachable && st.selected === false && (
        <span style={{ fontSize: 11, color: "var(--mute)" }}>select a project first</span>
      )}
      {!st.reachable && !phase && st.selected !== false && (
        <button className="btn small" onClick={start} title={st.runSkill ? `Start via the ${st.runSkill} skill` : "No run-* skill in the project"}>
          Start app{st.runSkill ? ` (${st.runSkill})` : ""}
        </button>
      )}
      {phase && <span style={{ fontSize: 11, color: "var(--brass)" }}>{phase}</span>}
      {err && <span style={{ fontSize: 11, color: "var(--alarm)" }}>{err}</span>}
    </span>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────

function Checkbox({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className={"dr-checkbox" + (on ? " on" : "")} onClick={onClick} aria-pressed={on}>
      {on && <Check size={10} strokeWidth={3} />}
    </button>
  );
}

// ─── Book view (S11 S12 S13, A1-A9) ─────────────────────────────────────

function BookView({ onRunSelected, projInfo, onOpenPicker, onGoAuthoring, onOpenPage }: {
  onRunSelected: (pageIds: string[], viewports: string[]) => void;
  projInfo: ProjectsInfo | null;
  onOpenPicker: () => void;
  onGoAuthoring: () => void;
  onOpenPage: (pageId: string) => void;
}) {
  const [book, setBook] = useState<DrillBook | null>(null);
  const [pages, setPages] = useState<DrillPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [planPhase, setPlanPhase] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);

  const load = () => {
    Promise.all([apiGet("/api/drillbook"), apiGet("/api/pages")])
      .then(([b, p]) => { setBook(b.book); setPages(p.pages); })
      .catch((e) => setError(e.message));
  };

  // Plan the Book through the headless agent session, then reload what it
  // wrote; with thenRun, continue straight into the run the user asked for.
  // join=true (the mount path) never kicks a session - it attaches to an
  // in-flight plan, or just surfaces a failure that predates this mount
  // while the Book is still empty (the only time it is the live blocker).
  const runPlan = async (brief: string | null, thenRun: boolean, join = false) => {
    if (planBusy) return;
    setError(null);
    setPlanBusy(true);
    try {
      const st = await ensurePlanned({ brief, join }, setPlanPhase);
      if (join && (!st.job || st.job.status !== "done")) {
        if (st.job && st.job.status === "failed" && st.pages === 0) {
          setError(st.job.error || "planning failed");
        }
        return;
      }
      const [b, p] = await Promise.all([apiGet("/api/drillbook"), apiGet("/api/pages")]);
      setBook(b.book);
      setPages(p.pages);
      const freshBook = b.book as DrillBook;
      const freshPages = p.pages as DrillPage[];
      if (freshPages.length === 0) throw new Error("planning finished but the Book still has no pages - see the plan log");
      if (thenRun) {
        const ticked = freshBook.pages.filter((pg) => pg.selected).map((pg) => pg.id);
        const ids = freshBook.fullDrill || ticked.length === 0 ? freshPages.map((pg) => pg.id) : ticked;
        onRunSelected(ids, freshBook.viewports.length ? freshBook.viewports : ["desktop"]);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPlanPhase(null);
      setPlanBusy(false);
    }
  };

  useEffect(() => {
    load();
    // A plan kicked before a reload (or from another tab) is still this
    // view's business: join it (never kick - join mode cannot spawn an
    // unrequested agent session) and show its progress or its failure.
    runPlan(null, false, true);
  }, []);

  if (error && !book) return <div className="dr-placeholder">{error}</div>;
  if (!book) return <div className="dr-placeholder">Loading…</div>;

  const selectedIds = new Set(book.pages.filter((p) => p.selected).map((p) => p.id));
  const togglePageSelected = async (pageId: string) => {
    const nextPages = book.pages.some((p) => p.id === pageId)
      ? book.pages.map((p) => (p.id === pageId ? { ...p, selected: !p.selected } : p))
      : [...book.pages, { id: pageId, title: pageId, path: "/", mode: "steps" as const, selected: true }];
    const saved = await apiPatch("/api/drillbook", { pages: nextPages });
    setBook(saved.book);
  };
  const toggleFullDrill = async () => {
    const saved = await apiPatch("/api/drillbook", { fullDrill: !book.fullDrill });
    setBook(saved.book);
  };
  const setAutonomy = async (autonomy: "gated" | "auto") => {
    const saved = await apiPatch("/api/drillbook", { autonomy });
    setBook(saved.book);
  };
  const runSelected = () => {
    if (planBusy) return;
    // An empty Book is Drill's job, not the user's: plan it (a headless
    // agent session authors pages, steps, and states for the whole app on
    // its own judgment), then run what it authored. Authoring stays the
    // manual override surface.
    if (pages.length === 0) {
      runPlan(null, true);
      return;
    }
    const ids = book.fullDrill
      ? pages.map((p) => p.id)
      : book.pages.filter((p) => p.selected).map((p) => p.id);
    if (ids.length === 0) { setError("select at least one page (or turn Full Drill on)"); return; }
    setError(null);
    onRunSelected(ids, book.viewports.length ? book.viewports : ["desktop"]);
  };

  return (
    <div>
      {projInfo && !projInfo.selected && (
        <div className="dr-sec card" style={{ borderColor: "var(--brass)", borderWidth: 1.5 }}>
          <div className="dr-rowwrap" style={{ justifyContent: "space-between" }}>
            <span className="t12">
              <b>No project selected.</b> Pick the app under test from your dev folder to author and run drills.
            </span>
            <button className="btn primary" onClick={onOpenPicker}>Select project</button>
          </div>
        </div>
      )}

      <Help>
        The Drill Book is this project's QA plan, stored in the repo under <span className="mono">drills/</span>:
        every page of the app, the checks (steps) to run on it, and the named states they apply to.
        Tick the pages you care about and Run selected - or Plan book to have an agent author the plan for you.
        Click a page name to open it in Authoring.
      </Help>
      <div className="dr-sec dr-rowwrap" style={{ justifyContent: "space-between" }}>
        <div>
          <div className="dr-lbl">App under test</div>
          <div className="dr-rowwrap">
            <b>{book.app.name || "(not configured)"}</b>
            {book.app.url && <span className="mono" style={{ color: "var(--mute)", fontSize: 11 }}>{book.app.url}</span>}
            <AppStatusChip />
          </div>
        </div>
        <div className="dr-rowwrap">
          <button className="btn" onClick={() => setPlanOpen(true)} disabled={planBusy}
            title="An agent session plans the Book - the whole app, or just a change you describe">
            Plan book
          </button>
          <button className="btn primary" onClick={runSelected} disabled={planBusy}>Run selected</button>
        </div>
      </div>

      {planPhase && (
        <div className="dr-sec" style={{ color: "var(--brass)", fontSize: 12 }}>{planPhase}</div>
      )}

      {error && (
        <div className="dr-placeholder">
          {error}
          {pages.length === 0 && (
            <button className="btn small" style={{ marginLeft: 8 }} onClick={onGoAuthoring}>Open Authoring</button>
          )}
        </div>
      )}

      <div className="dr-sec dr-rowwrap">
        <span className={"chip click ink" + (book.fullDrill ? " active" : "")} aria-pressed={book.fullDrill} {...chipAction(toggleFullDrill)}>
          Full Drill {book.fullDrill ? "on" : "off"}
        </span>
        {book.viewports.map((vp) => (
          <span key={vp} className="chip sage">{vp}</span>
        ))}
        <select value={book.autonomy} onChange={(e) => setAutonomy(e.target.value as "gated" | "auto")}
          style={{ fontSize: 11, padding: "6px 8px", border: "1px solid var(--rule)", background: "var(--paper-2)", color: "var(--ink)", fontFamily: "var(--sans)" }}>
          <option value="gated">Gated: approve plan before running</option>
          <option value="auto">Autonomous: plan, run, report</option>
        </select>
      </div>

      <div className="dr-sec">
        <div className="dr-lbl">Global rules and notes</div>
        <textarea
          className="mono"
          defaultValue={book.globalRules}
          placeholder="App-specific truths that feed every plan and review (citations required, no console errors, …)"
          onBlur={(e) => apiPatch("/api/drillbook", { globalRules: e.target.value }).then((r) => setBook(r.book))}
          style={{ width: "100%", minHeight: 64, padding: 10, border: "1px solid var(--rule)", background: "var(--paper-2)", color: "var(--ink-2)", fontSize: 12, fontFamily: "var(--sans)" }}
        />
      </div>

      <div className="dr-sec dr-tablewrap">
        <table className="dr-table">
          <thead>
            <tr><th /><th>Page</th><th>Mode</th><th>Areas</th><th>Steps</th><th>States</th></tr>
          </thead>
          <tbody>
            {pages.length === 0 && (
              <tr><td colSpan={6} style={{ color: "var(--mute)" }}>
                No pages yet. Run selected (or Plan book) has an agent author the whole plan; Authoring is the manual override.
              </td></tr>
            )}
            {pages.map((p) => (
              <tr key={p.id}>
                <td><Checkbox on={book.fullDrill || selectedIds.has(p.id)} onClick={() => togglePageSelected(p.id)} /></td>
                <td>
                  <button className="dr-link" onClick={() => onOpenPage(p.id)} title="Open this page in Authoring">{p.title}</button>{" "}
                  <span className="mono" style={{ color: "var(--mute-2)", fontSize: 10.5 }}>{p.path}</span>
                </td>
                <td>{p.mode === "steps" ? "Step by step" : <span style={{ color: "var(--brass)", fontWeight: 600 }}>Whole page vision</span>}</td>
                <td>{p.areas.length}</td>
                <td>{p.steps.length}</td>
                <td>{p.states.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {planOpen && (
        <PlanDialog
          hasPages={pages.length > 0}
          onClose={() => setPlanOpen(false)}
          onKick={(brief) => { setPlanOpen(false); runPlan(brief, false); }}
        />
      )}
    </div>
  );
}

// ─── Authoring surface (B1-B12, S2-S10, S16, S17, S24 strip) ─────────────

function StepRow({ step, onToggleEnabled, onToggleMode, onToggleJudgment, onRemove, onEditDescription, onJumpRef }: {
  step: Step;
  onToggleEnabled: () => void;
  onToggleMode: () => void;
  onToggleJudgment: () => void;
  onRemove: () => void;
  onEditDescription: (text: string) => void;
  onJumpRef: (ref: string) => void;
}) {
  return (
    <div className="dr-step" style={{ opacity: step.enabled ? 1 : 0.5 }}>
      <Checkbox on={step.enabled} onClick={onToggleEnabled} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <textarea
          className="dr-step-desc"
          defaultValue={step.description}
          onBlur={(e) => { if (e.target.value !== step.description) onEditDescription(e.target.value); }}
          rows={2}
        />
        <div className="dr-rowwrap" style={{ marginTop: 4 }}>
          <button className={"dr-mode" + (step.mode === "vision" ? " vision" : " e2e")} onClick={onToggleMode}>
            {step.mode === "vision" ? <Eye size={10} /> : <FileCode2 size={10} />}
            {step.mode}
          </button>
          {step.mode === "vision" && (
            <span className={"chip click" + (step.judgment ? " brass active" : "")} aria-pressed={!!step.judgment} {...chipAction(onToggleJudgment)} title="Needs ongoing model judgment (drillJudge), not a one-time deterministic find">
              judgment
            </span>
          )}
          {step.spec && <span className="mono" style={{ fontSize: 10, color: "var(--mute)" }}>{step.spec}</span>}
          {step.viewports.map((v) => {
            const vp = VIEWPORTS.find((x) => x.id === v);
            const Icon = vp?.icon ?? Monitor;
            return <Icon key={v} size={11} style={{ color: "var(--mute)" }} />;
          })}
          {step.ref && (
            <span className="chip click sage" {...chipAction(() => onJumpRef(step.ref!))}>{step.ref}</span>
          )}
          {step.state !== "default" && <span className="chip brass">{step.state}</span>}
        </div>
      </div>
      <button className="dr-xbtn" onClick={onRemove} title="Remove step"><X size={14} /></button>
    </div>
  );
}

function AuthoringView() {
  const [pages, setPages] = useState<DrillPage[]>([]);
  // Remember the last-authored page across reloads - resetting to the first
  // page alphabetically loses the author's place every refresh.
  const [pageId, setPageId] = useState<string | null>(() => localStorage.getItem("drill.authoring.page"));
  const [viewportId, setViewportId] = useState("desktop");
  const [tab, setTab] = useState<{ tabId: string; canvasUrl: string; viewport: { width: number; height: number } } | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [stateSel, setStateSel] = useState("default");
  const [error, setError] = useState<string | null>(null);
  // Tab-open / pick failures surface as an inline banner - they must never
  // replace the whole surface (losing the plan column over a transient
  // browser-fitting hiccup is what made failures read as "nothing works").
  const [authError, setAuthError] = useState<string | null>(null);
  const [newPageId, setNewPageId] = useState("");
  // E1/E2: on a phone-width viewport the plan is a FAB-toggled bottom sheet
  // over a full-screen canvas, not a side column - CSS (.dr-au-plan's
  // mobile breakpoint) hides/shows it off this same flag.
  const [mobileSheetOpen, setMobileSheetOpen] = useState(true);
  const overlayRef = useRef<HTMLDivElement>(null);
  // The canvas column's live width drives the preview scale: the app runs at
  // the REAL viewport size (the embed canvas resizes the tab to the iframe's
  // layout box) and is only VISUALLY scaled down to fit the column - so
  // breakpoints, picks, and badges are all exact at every viewport.
  const [cvEl, setCvEl] = useState<HTMLDivElement | null>(null);
  const [cvWidth, setCvWidth] = useState(0);
  // Manual-testing toolbar state: the live URL (polled), the editable URL
  // draft (reverts to live on blur, like a real browser urlbar), the console
  // buffer, and an optional custom viewport size that overrides the preset.
  const [urlDraft, setUrlDraft] = useState("");
  const urlFocused = useRef(false);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<Array<{ ts: number; level: string; text: string }>>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const [customVp, setCustomVp] = useState<{ width: number; height: number } | null>(null);
  const [vpDraft, setVpDraft] = useState<{ w: string; h: string }>({ w: "", h: "" });
  // Bumped after reload/navigate so area badges re-resolve against the new DOM.
  const [resolveTick, setResolveTick] = useState(0);
  useEffect(() => {
    if (!cvEl) return;
    const ro = new ResizeObserver(() => setCvWidth(cvEl.clientWidth));
    ro.observe(cvEl);
    setCvWidth(cvEl.clientWidth);
    return () => ro.disconnect();
  }, [cvEl]);

  useEffect(() => {
    if (pageId) localStorage.setItem("drill.authoring.page", pageId);
  }, [pageId]);

  const loadPages = () => {
    apiGet("/api/pages").then((r) => {
      setPages(r.pages);
      // A remembered id that no longer exists (deleted page, project switch)
      // must fall back, or the view wedges on "Loading…" forever.
      setPageId((prev) => (prev && r.pages.some((p: DrillPage) => p.id === prev) ? prev : (r.pages.length > 0 ? r.pages[0].id : null)));
    }).catch((e) => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch; loadPages uses functional setState so it never reads stale pageId
  useEffect(loadPages, []);

  const page = pages.find((p) => p.id === pageId) ?? null;

  // Open/reuse the authoring tab whenever the page or viewport changes.
  useEffect(() => {
    if (!pageId) return;
    setTab(null);
    setAuthError(null);
    apiPost("/api/authoring/tab", { pageId, viewport: viewportId })
      .then((r) => setTab({ tabId: r.tabId, canvasUrl: r.canvasUrl, viewport: r.viewport }))
      .catch((e) => setAuthError(`Could not open the app preview: ${e.message}`));
  }, [pageId, viewportId]);

  // Live URL + console poll: keeps the urlbar honest while the author clicks
  // around inside the preview, and surfaces console errors (findings
  // material) without opening devtools anywhere.
  useEffect(() => {
    if (!tab) { setLiveUrl(null); setConsoleEntries([]); return; }
    let stop = false;
    const poll = async () => {
      try {
        const [info, con] = await Promise.all([
          apiGet(`/api/authoring/tab-info?tabId=${encodeURIComponent(tab.tabId)}`),
          apiGet(`/api/authoring/console?tabId=${encodeURIComponent(tab.tabId)}&limit=150`)
        ]);
        if (stop) return;
        const u = info.tab?.url ?? null;
        setLiveUrl(u);
        if (!urlFocused.current && u) setUrlDraft(u);
        setConsoleEntries(con.entries ?? []);
      } catch { /* transient browser hiccup - keep the last known state */ }
    };
    poll();
    const t = setInterval(poll, 2500);
    return () => { stop = true; clearInterval(t); };
  }, [tab]);

  useEffect(() => {
    if (consoleOpen) consoleEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [consoleOpen, consoleEntries.length]);

  const doNav = async (dest: string) => {
    if (!tab) return;
    const target = dest.trim();
    if (!target) return;
    try {
      const r = await apiPost("/api/authoring/nav", { tabId: tab.tabId, url: /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `http://${target}` });
      if (r.ok === false && r.error) setAuthError(`Navigation failed: ${r.error}`);
      else setAuthError(null);
      if (r.url) { setLiveUrl(r.url); if (!urlFocused.current) setUrlDraft(r.url); }
      setResolveTick((n) => n + 1);
    } catch (err: any) {
      setAuthError(`Navigation failed: ${err.message}`);
    }
  };
  const doTabAction = async (action: "back" | "forward" | "reload") => {
    if (!tab) return;
    try {
      const r = await apiPost("/api/authoring/tab-action", { tabId: tab.tabId, action });
      if (r.url) { setLiveUrl(r.url); if (!urlFocused.current) setUrlDraft(r.url); }
      setAuthError(null);
      setResolveTick((n) => n + 1);
    } catch (err: any) {
      setAuthError(`Could not ${action}: ${err.message}`);
    }
  };
  const restartTab = async () => {
    if (!pageId) return;
    setTab(null);
    setAuthError(null);
    setConsoleEntries([]);
    try {
      const r = await apiPost("/api/authoring/restart", { pageId, viewport: viewportId });
      setTab({ tabId: r.tabId, canvasUrl: r.canvasUrl, viewport: r.viewport });
    } catch (err: any) {
      setAuthError(`Could not restart the app preview: ${err.message}`);
    }
  };

  // Saves are serialized and each patch is computed against the FRESHEST page
  // (the previous save's server response), not the caller's render-time
  // closure. Two quick edits (add a step, then type its description and blur
  // within the first PUT's round-trip) are otherwise two racing full-array
  // PUTs - last write wins and the earlier edit is silently lost.
  const saveChain = useRef(Promise.resolve());
  const freshPage = useRef<DrillPage | null>(null);
  freshPage.current = page ?? freshPage.current;
  const savePage = (make: (current: DrillPage) => Partial<DrillPage>) => {
    const id = pageId;
    if (!id) return Promise.resolve();
    saveChain.current = saveChain.current.then(async () => {
      const current = freshPage.current;
      if (!current || current.id !== id) return;
      const r = await fetch(`/api/pages/${encodeURIComponent(id)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(make(current))
      });
      const j = await r.json();
      freshPage.current = j.page;
      setPages((ps) => ps.map((p) => (p.id === id ? j.page : p)));
    });
    return saveChain.current;
  };

  const createPage = async () => {
    const id = newPageId.trim();
    if (!id) return;
    await fetch(`/api/pages/${encodeURIComponent(id)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: id, path: "/" + id })
    });
    setNewPageId("");
    await loadPages();
    setPageId(id);
  };

  const onOverlayClick: React.MouseEventHandler<HTMLDivElement> = async (e) => {
    if (!pickMode || !tab || !page) return;
    const box = overlayRef.current!.getBoundingClientRect();
    const effVp = customVp ?? tab.viewport;
    const x = ((e.clientX - box.left) / box.width) * effVp.width;
    const y = ((e.clientY - box.top) / box.height) * effVp.height;
    setPickMode(false);
    try {
      const r = await apiPost("/api/authoring/pick", { tabId: tab.tabId, x, y });
      if (!r.anchors) { setAuthError("No element under that point - try clicking directly on the element you want."); return; }
      await savePage((current) => {
        // Max+1, never count+1: after a removal the count re-collides with a
        // surviving area's number and two areas would share a badge.
        const n = current.areas.reduce((m, a) => Math.max(m, a.n), 0) + 1;
        const a: Area = {
          n,
          id: `${current.id}#${n}`,
          label: r.anchors.testId || r.anchors.ariaLabel
            || (r.anchors.text ? r.anchors.text.replace(/\s+/g, " ").trim().slice(0, 32) : `Area ${n}`),
          anchors: {
            testId: r.anchors.testId, role: r.anchors.role, ariaLabel: r.anchors.ariaLabel, text: r.anchors.text,
            tag: r.anchors.tag, css: r.anchors.css, cssMethod: r.anchors.cssMethod, xpath: r.anchors.xpath
          },
          pct: r.anchors.pct
        };
        return { areas: [...current.areas, a] };
      });
      setAuthError(null);
      // E2: reopen the sheet with the new area ready for steps.
      setMobileSheetOpen(true);
    } catch (err: any) {
      setAuthError(`Pick failed: ${err.message}`);
    }
  };

  // Removing an area also removes its steps (they anchor to it); surviving
  // areas keep their numbers - stable badges beat compact numbering, and
  // cross-page step refs ("page#3") must not silently re-point.
  const removeArea = (n: number) => {
    savePage((current) => ({
      areas: current.areas.filter((a) => a.n !== n),
      steps: current.steps.filter((s) => s.area !== n)
    }));
  };

  // E2: Highlight closes the sheet (full-screen canvas for picking with
  // touch), enters pick mode; the sheet reopens once a pick lands (above) or
  // the user cancels (toggling pick mode back off manually).
  const startHighlight = () => {
    setMobileSheetOpen(false);
    setPickMode(true);
  };

  // Re-resolve every area's badge position against the LIVE tab whenever the
  // tab (page/viewport) changes - anchors survive reload/viewport changes
  // because they're re-resolved, not replayed from a stale stored rect (B3/B4).
  const [livePct, setLivePct] = useState<Record<string, Pct | null>>({});
  useEffect(() => {
    if (!tab || !page) { setLivePct({}); return; }
    let cancelled = false;
    (async () => {
      const next: Record<string, Pct | null> = {};
      for (const a of page.areas) {
        try {
          const r = await apiPost("/api/authoring/resolve", { tabId: tab.tabId, anchors: a.anchors });
          next[a.id] = r.resolved?.pct ?? a.pct ?? null;
        } catch {
          next[a.id] = a.pct ?? null;
        }
      }
      if (!cancelled) setLivePct(next);
    })();
    return () => { cancelled = true; };
    // Deliberately keyed on area COUNT, not the `page` object identity - an
    // unrelated step edit produces a new `page` reference on every keystroke
    // and would otherwise re-fire this network round trip needlessly.
    // customVp/resolveTick re-resolve after a custom resize, reload, or
    // navigation reflows the live DOM under the stored anchors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, page?.areas.length, page?.id, customVp, resolveTick]);

  const addStep = (area: number) => {
    const step: Step = { id: newStepId(), area, mode: "vision", enabled: true, viewports: [viewportId], state: stateSel, description: "", tags: [] };
    savePage((current) => ({ steps: [...current.steps, step] }));
  };
  const patchStep = (stepId: string, patch: Partial<Step>) => {
    savePage((current) => ({ steps: current.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) }));
  };
  const removeStep = (stepId: string) => {
    savePage((current) => ({ steps: current.steps.filter((s) => s.id !== stepId) }));
  };

  if (error) return <div className="dr-placeholder">{error} <button className="btn small" onClick={() => setError(null)}>dismiss</button></div>;
  if (pages.length === 0) {
    return (
      <div className="dr-placeholder">
        No pages yet.
        <div className="dr-rowwrap" style={{ justifyContent: "center", marginTop: 10 }}>
          <input value={newPageId} onChange={(e) => setNewPageId(e.target.value)} placeholder="page id, e.g. chat"
            style={{ fontSize: 12, padding: "6px 8px", border: "1px solid var(--rule)" }} />
          <button className="btn small" onClick={createPage}><Plus size={12} /> Add page</button>
        </div>
      </div>
    );
  }
  if (!page) return <div className="dr-placeholder">Loading…</div>;

  const states: string[] = ["default", ...page.states.map((s) => s.id).filter((s) => s !== "default")];
  const pageSteps = page.steps.filter((s) => s.area === 0 && s.state === stateSel);
  const areaSteps = (n: number) => page.steps.filter((s) => s.area === n && s.state === stateSel);

  // Display scale: never upscale (a phone viewport in a wide column renders
  // at its native 390px, centered), downscale to fit otherwise. A custom size
  // overrides the preset - the iframe's layout box IS the real viewport (the
  // embed canvas resizes the live tab to it), so this is all it takes.
  const vp = customVp ?? tab?.viewport ?? null;
  const scale = vp && cvWidth > 0 ? Math.min(1, cvWidth / vp.width) : 1;
  const dispW = vp ? Math.round(vp.width * scale) : 0;
  const dispH = vp ? Math.round(vp.height * scale) : 0;
  const consoleErrors = consoleEntries.filter((e) => e.level === "error").length;

  return (
    <div>
      <Help>
        The manual authoring surface: your step plan alongside the live app (on a phone it slides up as
        a sheet). Highlight an area, then write steps against it (or page-level steps) - plain-language
        checks. Steps start as vision checks (a model judges the page); when a vision check passes and
        grounds a deterministic assertion it graduates to e2e automatically. The preview is interactive -
        click and type in it to steer the app, use the toolbar to navigate, reload, restart the tab
        fresh, or watch the page's console while you test by hand.
      </Help>
      {authError && (
        <div className="dr-banner">
          <span style={{ flex: "1 1 240px" }}>{authError}</span>
          <button className="btn small" onClick={() => setAuthError(null)}>Dismiss</button>
        </div>
      )}
      <div className="dr-au">
      <div className="dr-au-canvas">
        <div className="dr-lbl">App under test</div>
        <div className="dr-rowwrap" style={{ marginBottom: 8 }}>
          <select value={pageId ?? ""} onChange={(e) => setPageId(e.target.value)} style={{ fontSize: 12, padding: "5px 8px", border: "1px solid var(--rule)" }}>
            {pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          <div className="dr-rowwrap">
            {VIEWPORTS.map((v) => {
              const Icon = v.icon;
              const active = !customVp && viewportId === v.id;
              return (
                <span key={v.id} className={"chip click" + (active ? " ink active" : " sage")} aria-pressed={active}
                  title={`Author at the ${v.label} viewport - the app really reflows to this size`}
                  {...chipAction(() => { setCustomVp(null); setViewportId(v.id); })}>
                  <Icon size={11} /> {v.label}
                </span>
              );
            })}
            <span className={"chip click" + (customVp ? " ink active" : " sage")} aria-pressed={!!customVp}
              title="Author at any viewport size - type width x height"
              {...chipAction(() => {
                const base = customVp ?? tab?.viewport ?? { width: 1280, height: 800 };
                setVpDraft({ w: String(base.width), h: String(base.height) });
                setCustomVp(base);
              })}>
              <Ruler size={11} /> custom
            </span>
            {customVp && (
              <span className="dr-vpsize">
                <input className="dr-vpnum" type="number" min={280} max={3840} value={vpDraft.w}
                  onChange={(e) => setVpDraft((d) => ({ ...d, w: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  onBlur={() => {
                    const width = Math.max(280, Math.min(3840, Number(vpDraft.w) || 0)) || customVp.width;
                    setVpDraft((d) => ({ ...d, w: String(width) }));
                    setCustomVp((c) => (c ? { ...c, width } : c));
                  }} aria-label="viewport width" />
                <span className="t11">x</span>
                <input className="dr-vpnum" type="number" min={280} max={3840} value={vpDraft.h}
                  onChange={(e) => setVpDraft((d) => ({ ...d, h: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  onBlur={() => {
                    const height = Math.max(280, Math.min(3840, Number(vpDraft.h) || 0)) || customVp.height;
                    setVpDraft((d) => ({ ...d, h: String(height) }));
                    setCustomVp((c) => (c ? { ...c, height } : c));
                  }} aria-label="viewport height" />
              </span>
            )}
          </div>
        </div>

        {tab && (
          <div className="dr-cv-bar">
            <button className="dr-iconbtn" title="Back" onClick={() => doTabAction("back")}><ArrowLeft size={13} /></button>
            <button className="dr-iconbtn" title="Forward" onClick={() => doTabAction("forward")}><ArrowRight size={13} /></button>
            <button className="dr-iconbtn" title="Reload the page" onClick={() => doTabAction("reload")}><RotateCw size={13} /></button>
            <input className="dr-urlin" value={urlDraft} spellCheck={false}
              onFocus={() => { urlFocused.current = true; }}
              onBlur={() => { urlFocused.current = false; if (liveUrl) setUrlDraft(liveUrl); }}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") doNav(urlDraft); }}
              placeholder="URL - press Enter to navigate" aria-label="preview URL" />
            <button className="btn small" title="Close this preview tab and reopen the page fresh (resets app state)" onClick={restartTab}>
              <RefreshCcw size={11} /> Restart
            </button>
            <a className="btn small" href={tab.canvasUrl.replace(/\?embed=1$/, "")} target="_blank" rel="noreferrer"
              title="Open this same live tab full-size in the Browser fitting">
              <ExternalLink size={11} /> Full view
            </a>
            <button className={"btn small" + (consoleOpen ? " primary" : "")} onClick={() => setConsoleOpen((v) => !v)}
              title="The page's browser console - errors here are findings material">
              <Terminal size={11} /> Console{consoleErrors > 0 ? ` (${consoleErrors})` : ""}
            </button>
          </div>
        )}

        <div className="dr-cv-outer" ref={setCvEl}>
          {tab ? (
            <div className="dr-cv" style={{ width: dispW, height: dispH }}>
              <iframe
                title="app under test"
                src={tab.canvasUrl}
                className="dr-cv-frame"
                style={{ width: vp!.width, height: vp!.height, transform: `scale(${scale})` }}
              />
              <div
                ref={overlayRef}
                className="dr-cv-overlay"
                style={{ cursor: pickMode ? "crosshair" : "default", pointerEvents: pickMode ? "auto" : "none" }}
                onClick={onOverlayClick}
              />
              {page.areas.map((a) => {
                const pct = livePct[a.id] ?? a.pct;
                if (!pct) return null;
                return (
                  <div key={a.id} className="dr-abox" style={{ left: `${pct.leftPct}%`, top: `${pct.topPct}%`, width: `${pct.widthPct}%`, height: `${pct.heightPct}%` }}>
                    <span className="dr-abadge">{a.n}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="dr-placeholder">{authError ? "App preview unavailable." : "Opening the app preview…"}</div>
          )}
        </div>

        {consoleOpen && (
          <div className="dr-console">
            {consoleEntries.length === 0 && <div className="dr-con-empty">No console output from the page yet.</div>}
            {consoleEntries.slice(-80).map((e, i) => (
              <div key={`${e.ts}-${i}`} className={"dr-con-row" + (e.level === "error" ? " err" : e.level === "warning" ? " warn" : "")}>
                <span className="dr-con-lvl">{e.level}</span>
                <span className="dr-con-text">{e.text}</span>
              </div>
            ))}
            <div ref={consoleEndRef} />
          </div>
        )}

        <div className="dr-rowwrap" style={{ marginTop: 8 }}>
          <button className={"btn small" + (pickMode ? " primary" : "")} onClick={() => (pickMode ? setPickMode(false) : startHighlight())}>
            <Crosshair size={11} /> {pickMode ? "Now click an element in the preview…" : "Highlight new area"}
          </button>
          {pickMode && <span style={{ fontSize: 11, color: "var(--brass)" }}>Click the element you want to check - it becomes a numbered area you can attach steps to.</span>}
        </div>

        {/* E1: FAB - shown only at phone width (CSS) AND while the sheet is
            closed, to open it back up; toggles the plan sheet. */}
        {!pickMode && !mobileSheetOpen && (
          <button className="dr-fab" onClick={() => setMobileSheetOpen((v) => !v)} aria-label="Toggle plan">
            <NotebookPen size={18} />
          </button>
        )}
      </div>

      <div className={"dr-au-plan" + (mobileSheetOpen ? " dr-sheet-open" : " dr-sheet-closed")}>
        <div className="dr-rowwrap" style={{ marginBottom: 10 }}>
          <b>Drill: {page.title}</b>
          <button className="dr-sheet-close" onClick={() => setMobileSheetOpen(false)} title="Close plan sheet"><X size={16} /></button>
        </div>

        {/* Phone-only (CSS): a tall phone-aspect canvas pushes the canvas
            column's Highlight button under this very sheet, so the sheet
            carries its own - tapping it closes the sheet and enters pick
            mode on the full-screen canvas (E2). */}
        <button className="btn small dr-sheet-highlight" onClick={startHighlight}>
          <Crosshair size={11} /> Highlight new area
        </button>

        {states.length > 1 && (
          <>
            <div className="dr-lbl">State</div>
            <div className="dr-rowwrap" style={{ marginBottom: 12 }}>
              {states.map((s) => (
                <span key={s} className={"chip click brass" + (stateSel === s ? " active" : "")} aria-pressed={stateSel === s} {...chipAction(() => setStateSel(s))}>{s}</span>
              ))}
            </div>
          </>
        )}

        <div className="dr-lbl">Page steps</div>
        {pageSteps.map((s) => (
          <StepRow key={s.id} step={s}
            onToggleEnabled={() => patchStep(s.id, { enabled: !s.enabled })}
            onToggleMode={() => patchStep(s.id, { mode: s.mode === "vision" ? "e2e" : "vision" })}
            onToggleJudgment={() => patchStep(s.id, { judgment: !s.judgment })}
            onRemove={() => removeStep(s.id)}
            onEditDescription={(text) => patchStep(s.id, { description: text })}
            onJumpRef={(ref) => setPageId(ref.split("#")[0])}
          />
        ))}
        <button className="btn small" onClick={() => addStep(0)}><Plus size={11} /> Page step</button>

        {page.areas.map((a) => (
          <div key={a.id} style={{ marginTop: 14 }}>
            <div className="dr-rowwrap" style={{ marginBottom: 4 }}>
              <span className="dr-area-n">{a.n}</span>
              <b>{a.label}</b>
              <span className="mono" style={{ fontSize: 10, color: "var(--mute-2)" }}>{a.id}</span>
              <button className="dr-xbtn" onClick={() => removeArea(a.n)}
                title={areaSteps(a.n).length > 0 ? `Remove area ${a.n} and its ${areaSteps(a.n).length} step(s)` : `Remove area ${a.n}`}>
                <X size={13} />
              </button>
            </div>
            {areaSteps(a.n).map((s) => (
              <StepRow key={s.id} step={s}
                onToggleEnabled={() => patchStep(s.id, { enabled: !s.enabled })}
                onToggleMode={() => patchStep(s.id, { mode: s.mode === "vision" ? "e2e" : "vision" })}
                onToggleJudgment={() => patchStep(s.id, { judgment: !s.judgment })}
                onRemove={() => removeStep(s.id)}
                onEditDescription={(text) => patchStep(s.id, { description: text })}
                onJumpRef={(ref) => setPageId(ref.split("#")[0])}
              />
            ))}
            <button className="btn small" onClick={() => addStep(a.n)}><Plus size={11} /> Step</button>
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}

// ─── Run & results (D1-D10, R10) ─────────────────────────────────────────

interface RunPageEntry {
  pageId: string; stepId: string; viewportId: string; automationRunId: string | null; status: string; error?: string;
  infra?: boolean;
  result: { stepId: string; status: string; tier?: string | null; error?: string; evidencePath?: string; durationMs?: number; result?: { passed?: boolean; reasoning?: string } } | null;
}
interface RunRow {
  id: string; startedAt: string; endedAt: string | null; contextTag: string; state: string;
  project: string | null; dispatchedAt: string | null; steps: number;
  summary: { steps: number; failed: number; infra: number } | null;
  findings: { proposed: number; confirmed: number; dismissed: number };
}
interface Finding { id: string; kind: string; pageId: string; stepId: string | null; text: string; status: "proposed" | "confirmed" | "dismissed"; at: string; card?: { id: string; url: string | null; at: string } | null }
interface Observation { id: string; text: string; at: string; convertedToStep: string | null; convertedToFinding: string | null }
interface DrillRun {
  id: string; startedAt: string; endedAt: string | null; contextTag: string; state: string;
  pages: RunPageEntry[];
  feedback: Record<string, Array<{ id: string; note: string; at: string }>>;
  overrides: Record<string, { verdict: string; note: string; at: string }>;
  observations: Observation[];
  findings: Finding[];
}

function tierTone(tier?: string | null) {
  if (tier === "cached") return "sage";
  if (tier === "vision") return "brass";
  if (tier === "recovered") return "brass";
  return "paper";
}

function stepPassed(entry: RunPageEntry): boolean {
  if (!entry.result) return false;
  if (entry.result.status === "failed") return false;
  if (entry.result.result && entry.result.result.passed === false) return false;
  return true;
}

function ResultsView({ initialRun, onConsumeInitialRun }: {
  initialRun: { pageIds: string[]; viewports: string[] } | null;
  onConsumeInitialRun: () => void;
}) {
  const [pages, setPages] = useState<DrillPage[]>([]);
  const [book, setBook] = useState<DrillBook | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [run, setRun] = useState<DrillRun | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [selectedViewports, setSelectedViewports] = useState<Set<string>>(new Set(["desktop"]));
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [obsText, setObsText] = useState("");
  const [dispatchMode, setDispatchMode] = useState<"manual" | "heartbeat" | "immediate">("manual");
  // The card minted by the last dispatch click - shown inline as a link so
  // "did my fixes reach the kanban?" is answered right here.
  const [dispatchedCard, setDispatchedCard] = useState<{ id: string; url: string | null } | null>(null);
  const [runsPage, setRunsPage] = useState(0);
  const [deleteArm, setDeleteArm] = useState<string | null>(null);
  const [pendingGate, setPendingGate] = useState<{ plan: Array<{ pageId: string; viewportId: string; steps: Array<{ id: string; description: string; mode: string }> }>; resume: unknown } | null>(null);

  const load = () => {
    Promise.all([apiGet("/api/pages"), apiGet("/api/drillbook"), apiGet("/api/runs")])
      .then(([p, b, r]) => {
        setPages(p.pages);
        setBook(b.book);
        setRuns(r.runs);
        if (!run && r.runs.length > 0) apiGet(`/api/runs/${r.runs[0].id}`).then((rr) => setRun(rr.run));
      })
      .catch((e) => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch
  useEffect(load, []);

  const startRun = async (pageIdsArg?: string[], viewportsArg?: string[]) => {
    const pageIds = pageIdsArg ?? [...selectedPages];
    const viewports = viewportsArg ?? [...selectedViewports];
    if (pageIds.length === 0 || viewports.length === 0) { setError("select at least one page and one viewport"); return; }
    setRunning(true);
    setError(null);
    setPendingGate(null);
    try {
      // The app under test must be serving first - down means "start it
      // through the project's run skill" and wait, not a wall of failures.
      await ensureAppUp(setPhase);
      setPhase(null);
      const r = await apiPost("/api/runs", { pageIds, viewports, contextTag: "drill" });
      if (r.held) {
        // A5/R7/S22: gated autonomy pauses with a plan diff before running.
        setPendingGate({ plan: r.plan, resume: r.resume });
      } else {
        setRun(r.run);
        load();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPhase(null);
      setRunning(false);
    }
  };

  // The Book view's "Run selected" lands here: preselect its pages and
  // viewports and start immediately.
  useEffect(() => {
    if (!initialRun) return;
    setSelectedPages(new Set(initialRun.pageIds));
    setSelectedViewports(new Set(initialRun.viewports));
    onConsumeInitialRun();
    startRun(initialRun.pageIds, initialRun.viewports);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot handoff consume
  }, [initialRun]);

  const approveGate = async () => {
    if (!pendingGate) return;
    setRunning(true);
    try {
      const r = await apiPost("/api/runs", pendingGate.resume as any);
      setPendingGate(null);
      setRun(r.run);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const refreshRun = (r: DrillRun) => setRun(r);

  const openRun = (id: string) => {
    setDispatchedCard(null);
    return apiGet(`/api/runs/${encodeURIComponent(id)}`).then((r) => setRun(r.run)).catch((e) => setError(e.message));
  };
  const deleteRun = async (id: string) => {
    await fetch(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    setDeleteArm(null);
    const r = await apiGet("/api/runs").catch(() => null);
    const rows: RunRow[] = r?.runs ?? [];
    setRuns(rows);
    if (run?.id === id) {
      if (rows.length > 0) void openRun(rows[0].id);
      else setRun(null);
    }
  };

  const giveFeedback = async (pageId: string, stepId: string, note: string) => {
    const r = await apiPost(`/api/runs/${run!.id}/feedback`, { pageId, stepId, note });
    refreshRun(r.run);
  };
  const override = async (pageId: string, stepId: string, verdict: "passed" | "failed", note = "") => {
    const r = await apiPost(`/api/runs/${run!.id}/override`, { pageId, stepId, verdict, note });
    refreshRun(r.run);
  };
  const addObs = async () => {
    if (!obsText.trim()) return;
    const r = await apiPost(`/api/runs/${run!.id}/observation`, { text: obsText.trim() });
    setObsText("");
    refreshRun(r.run);
  };
  const convertObsToStep = async (obsId: string, pageId: string) => {
    const r = await apiPost(`/api/runs/${run!.id}/observation/${obsId}/convert-step`, { pageId });
    refreshRun(r.run);
  };
  const convertObsToFinding = async (obsId: string, pageId: string) => {
    const r = await apiPost(`/api/runs/${run!.id}/observation/${obsId}/convert-finding`, { pageId });
    refreshRun(r.run);
  };
  const triage = async (findingId: string, status: "confirmed" | "dismissed") => {
    const r = await fetch(`/api/runs/${run!.id}/findings/${findingId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status })
    });
    const j = await r.json();
    refreshRun(j.run);
  };
  const dispatch = async () => {
    try {
      const j = await apiPost(`/api/runs/${run!.id}/dispatch`, { mode: dispatchMode });
      if (j.dispatched) {
        setError(null);
        setDispatchedCard(j.card ? { id: j.card.id, url: j.card.url ?? null } : null);
        if (j.run) refreshRun(j.run);
      } else {
        setError(`Heartbeat: ${j.pending} confirmed finding(s) queued for the next beat.`);
      }
    } catch (e: any) {
      setError(e.message);
    }
  };

  const confirmedCount = run ? run.findings.filter((f) => f.status === "confirmed").length : 0;
  // Only findings not already on a fix card can go out - the button reflects
  // what a click would actually send.
  const dispatchableCount = run ? run.findings.filter((f) => f.status === "confirmed" && !f.card).length : 0;

  const RUNS_PER_PAGE = 8;
  const totalRunPages = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE));
  const runRows = runs.slice(runsPage * RUNS_PER_PAGE, (runsPage + 1) * RUNS_PER_PAGE);

  return (
    <div>
      <div className="dr-sec card">
        <div className="dr-lbl">Start a run</div>
        <Help>
          Pick the pages and viewports to check, then Run. If the app is down it is started through the
          project's run skill first. With gated autonomy the run pauses and shows you the exact step plan
          before executing.
        </Help>
        <div className="dr-rowwrap" style={{ marginBottom: 8 }}>
          {pages.map((p) => (
            <span key={p.id} className={"chip click" + (selectedPages.has(p.id) ? " ink active" : "")}
              aria-pressed={selectedPages.has(p.id)}
              {...chipAction(() => setSelectedPages((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; }))}>
              {p.title}
            </span>
          ))}
        </div>
        <div className="dr-rowwrap" style={{ marginBottom: 8 }}>
          {VIEWPORTS.map((v) => (
            <span key={v.id} className={"chip click" + (selectedViewports.has(v.id) ? " sage active" : "")}
              aria-pressed={selectedViewports.has(v.id)}
              {...chipAction(() => setSelectedViewports((s) => { const n = new Set(s); n.has(v.id) ? n.delete(v.id) : n.add(v.id); return n; }))}>
              {v.label}
            </span>
          ))}
        </div>
        <div className="dr-rowwrap">
          <button className="btn primary" disabled={running} onClick={() => startRun()}>{running ? (phase ?? "Running…") : "Run"}</button>
          <AppStatusChip />
        </div>
      </div>

      {error && <div className="dr-banner"><span style={{ flex: "1 1 240px" }}>{error}</span><button className="btn small" onClick={() => setError(null)}>Dismiss</button></div>}

      {runs.length > 0 && (
        <div className="dr-sec">
          <div className="dr-lbl">Past runs</div>
          <Help>
            Newest first - click a row to open its results below. "drill-adversarial" tags a blind
            re-check pass. Failed counts real app failures; infra counts harness outages (vision route,
            gateway, or browser fitting down) that say nothing about the app.
          </Help>
          <div className="dr-tablewrap">
            <table className="dr-table dr-runs">
              <thead>
                <tr><th>Started</th><th>Tag</th><th>Steps</th><th>Failed</th><th>Infra</th><th>Findings</th><th aria-label="actions" /></tr>
              </thead>
              <tbody>
                {runRows.map((r) => (
                  <tr key={r.id} className={run?.id === r.id ? "sel" : ""} onClick={() => void openRun(r.id)}>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtDate(r.startedAt)}</td>
                    <td><span className="chip">{r.contextTag}</span></td>
                    <td>{r.steps}</td>
                    <td style={{ color: r.summary && r.summary.failed > 0 ? "var(--alarm)" : "var(--mute)" }}>{r.summary ? r.summary.failed : "-"}</td>
                    <td style={{ color: "var(--mute)" }}>{r.summary ? r.summary.infra : "-"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {r.findings.proposed + r.findings.confirmed === 0
                        ? <span style={{ color: "var(--mute)" }}>none</span>
                        : <>{r.findings.proposed > 0 && <span>{r.findings.proposed} open</span>}{r.findings.confirmed > 0 && <span style={{ color: "var(--sage)" }}>{r.findings.proposed > 0 ? " · " : ""}{r.findings.confirmed} confirmed</span>}</>}
                    </td>
                    <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: "nowrap" }}>
                      {deleteArm === r.id ? (
                        <span className="dr-rowwrap" style={{ gap: 4 }}>
                          <button className="btn small" style={{ color: "var(--alarm)", borderColor: "var(--alarm)" }} onClick={() => void deleteRun(r.id)}>Delete run</button>
                          <button className="btn small" onClick={() => setDeleteArm(null)}>Keep</button>
                        </span>
                      ) : (
                        <button className="dr-xbtn" title="Delete this run and its results" onClick={() => setDeleteArm(r.id)}><X size={13} /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalRunPages > 1 && (
            <div className="dr-rowwrap" style={{ marginTop: 8 }}>
              <button className="btn small" disabled={runsPage === 0} onClick={() => setRunsPage((p) => p - 1)}>Newer</button>
              <span style={{ fontSize: 11, color: "var(--mute)" }}>page {runsPage + 1} of {totalRunPages}</span>
              <button className="btn small" disabled={runsPage >= totalRunPages - 1} onClick={() => setRunsPage((p) => p + 1)}>Older</button>
            </div>
          )}
        </div>
      )}

      {pendingGate && (
        <div className="dr-sec card" style={{ borderColor: "var(--brass)", borderWidth: 1.5 }}>
          <div className="dr-rowwrap" style={{ marginBottom: 8 }}>
            <b className="t12">Plan ready - gated, awaiting approval</b>
          </div>
          {pendingGate.plan.map((p) => (
            // A whole-book run previews hundreds of steps; per-group <details>
            // keeps the gate scannable (a page's step list is one click away),
            // while a small scoped run stays fully expanded.
            <details key={`${p.pageId}:${p.viewportId}`} className="t11" style={{ marginBottom: 6 }} open={pendingGate.plan.length <= 4}>
              <summary style={{ cursor: "pointer" }}>
                <b>{p.pageId}</b> <span className="chip sage">{p.viewportId}</span>{" "}
                <span className="mono" style={{ fontSize: 10, color: "var(--mute)" }}>{p.steps.length} step{p.steps.length === 1 ? "" : "s"}</span>
              </summary>
              <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                {p.steps.map((s) => (
                  <li key={s.id} className="t11">{s.description} <span className="mono" style={{ fontSize: 10, color: "var(--mute)" }}>({s.mode})</span></li>
                ))}
                {p.steps.length === 0 && <li className="t11" style={{ color: "var(--mute)" }}>(no enabled steps)</li>}
              </ul>
            </details>
          ))}
          <div className="dr-rowwrap" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={running} onClick={approveGate}>{running ? "Running…" : "Approve and run"}</button>
            <button className="btn small" onClick={() => setPendingGate(null)}>Cancel</button>
          </div>
        </div>
      )}

      {!run && !error && !pendingGate && (
        <div className="dr-placeholder">No runs yet for this project. Select pages above and Run, or start from the Drill Book tab.</div>
      )}

      {run && (() => {
        const stepOf = (pageId: string, stepId: string) =>
          pages.find((p) => p.id === pageId)?.steps.find((s) => s.id === stepId) ?? null;
        const pageTitle = (pageId: string) => pages.find((p) => p.id === pageId)?.title ?? pageId;
        const liveEntries = run.pages.filter((e) => !e.infra);
        const infraEntries = run.pages.filter((e) => e.infra);
        const byPage: Array<{ pageId: string; entries: RunPageEntry[] }> = [];
        for (const e of liveEntries) {
          const g = byPage.find((x) => x.pageId === e.pageId);
          if (g) g.entries.push(e);
          else byPage.push({ pageId: e.pageId, entries: [e] });
        }
        const renderEntry = (entry: RunPageEntry) => {
          const passed = stepPassed(entry);
          // overrides/feedback stay keyed page:step (a reviewer verdict
          // covers the step, not one viewport), but the React key must
          // include the viewport - the same step renders once per
          // viewport and duplicate keys corrupt list reconciliation.
          const key = `${entry.pageId}:${entry.stepId}`;
          const override_ = run.overrides[key];
          const notes = run.feedback[key] ?? [];
          const desc = stepOf(entry.pageId, entry.stepId)?.description || null;
          return (
            <div key={`${key}:${entry.viewportId}`} className="dr-res" style={{ borderLeft: `3px solid var(${passed && !override_ ? "--sage" : "--alarm"})` }}>
              <div className="dr-rowwrap">
                {passed ? <Check size={14} style={{ color: "var(--sage)" }} /> : <span style={{ color: "var(--alarm)", fontWeight: 700 }}>×</span>}
                <span style={{ flex: "1 1 260px", fontSize: 12.5, minWidth: 0, overflowWrap: "anywhere" }}>
                  {desc ?? <span className="mono" style={{ fontSize: 11 }}>{entry.stepId}</span>}
                </span>
                <span className="chip">{entry.viewportId}</span>
                {entry.result?.tier && (
                  <span className={"chip " + tierTone(entry.result.tier)}
                    title={entry.result.tier === "cached" ? "Checked with a deterministic assertion graduated from an earlier vision pass - fast and stable"
                      : entry.result.tier === "vision" ? "A model judged the live page (screenshot + accessibility tree)"
                      : entry.result.tier === "recovered" ? "The step failed and the self-healing fixer patched it mid-run"
                      : entry.result.tier ?? ""}>
                    {entry.result.tier}
                  </span>
                )}
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: "var(--mute-2)", marginTop: 2 }}>{entry.pageId}#{entry.stepId}</div>
              {entry.result?.evidencePath && <div className="mono dr-evidence">{entry.result.evidencePath}</div>}
              {(entry.error || entry.result?.error) && <div style={{ color: "var(--alarm)", fontSize: 11, marginTop: 4, overflowWrap: "anywhere" }}>{entry.error || entry.result?.error}</div>}
              {entry.result?.result?.reasoning && !passed && <div style={{ color: "var(--ink-2)", fontSize: 11, marginTop: 4 }}>{entry.result.result.reasoning}</div>}
              {override_ && <div style={{ color: "var(--brass)", fontSize: 11, marginTop: 4 }}>Overridden -&gt; {override_.verdict} ({override_.note})</div>}
              {notes.map((n) => <div key={n.id} className="mono" style={{ fontSize: 10.5, color: "var(--sage)", marginTop: 3 }}>{n.note}</div>)}
              <div className="dr-rowwrap" style={{ marginTop: 6 }}>
                <input className="dr-feedback" placeholder="Add feedback…"
                  onKeyDown={(e) => { if (e.key === "Enter") { giveFeedback(entry.pageId, entry.stepId, (e.target as HTMLInputElement).value); (e.target as HTMLInputElement).value = ""; } }} />
                {passed
                  ? <button className="btn small" onClick={() => override(entry.pageId, entry.stepId, "failed", "marked failed by reviewer")}>Mark failed</button>
                  : <button className="btn small" onClick={() => override(entry.pageId, entry.stepId, "passed", "marked passed by reviewer")}>Mark passed</button>}
              </div>
            </div>
          );
        };
        return (
        <>
          <div className="dr-sec">
            <div className="dr-lbl">Results - {fmtDate(run.startedAt)}</div>
            <div className="dr-rowwrap" style={{ marginBottom: 10 }}>
              <span className="chip">{run.contextTag}</span>
              {run.state !== "default" && <span className="chip brass">{run.state}</span>}
              <span className="mono" style={{ fontSize: 10, color: "var(--mute-2)" }}>{run.id}</span>
            </div>
            <Help>
              One row per step and viewport. A red row failed: read the reasoning, then either confirm the
              matching finding below or Mark passed if the check is wrong (that feedback tunes future runs).
            </Help>
            {byPage.map((g) => {
              const passCount = g.entries.filter(stepPassed).length;
              return (
                <div key={g.pageId} style={{ marginBottom: 16 }}>
                  <div className="dr-rowwrap" style={{ marginBottom: 6 }}>
                    <b style={{ fontSize: 13 }}>{pageTitle(g.pageId)}</b>
                    <span style={{ fontSize: 11, color: passCount === g.entries.length ? "var(--sage)" : "var(--alarm)" }}>
                      {passCount}/{g.entries.length} passed
                    </span>
                  </div>
                  {g.entries.map(renderEntry)}
                </div>
              );
            })}
            {liveEntries.length === 0 && infraEntries.length > 0 && (
              <div className="dr-placeholder">
                Every step in this run hit a harness error - the app was never actually judged. See below,
                fix the harness (or just re-run once it is back), and consider deleting this run.
              </div>
            )}
            {infraEntries.length > 0 && (
              // Collapsed when real results exist (noise control); open when
              // the run is NOTHING BUT harness errors - hiding the only
              // information on screen behind a closed disclosure helps nobody.
              <details className="dr-infra" open={liveEntries.length === 0}>
                <summary>Harness errors ({infraEntries.length}) - infrastructure failures, not app bugs</summary>
                <Help>
                  The vision route, model gateway, or browser fitting was unavailable while these steps ran,
                  so the app was not judged at all. They never pool into findings. Re-run once the harness
                  is healthy.
                </Help>
                {infraEntries.map((e) => (
                  <div key={`${e.pageId}:${e.stepId}:${e.viewportId}`} className="dr-res" style={{ borderLeft: "3px solid var(--rule-2)" }}>
                    <div className="dr-rowwrap">
                      <span className="mono" style={{ fontSize: 11, color: "var(--mute)" }}>{e.pageId}#{e.stepId}</span>
                      <span className="chip">{e.viewportId}</span>
                    </div>
                    <div style={{ color: "var(--mute)", fontSize: 11, marginTop: 4, overflowWrap: "anywhere" }}>{e.error || e.result?.error}</div>
                  </div>
                ))}
              </details>
            )}
          </div>

          <div className="dr-sec card">
            <div className="dr-rowwrap" style={{ marginBottom: 8 }}>
              <b>Observations</b>
            </div>
            <Help>
              Things you noticed that no step covers - no re-run needed to record them. Convert one into a
              draft step (future runs will check it) or into a finding (it goes into the fix report below).
            </Help>
            {run.observations.map((o) => (
              <div key={o.id} className="dr-rowwrap" style={{ padding: "5px 0", borderTop: "1px dashed var(--rule)" }}>
                <span style={{ flex: "1 1 220px" }}>{o.text}</span>
                {o.convertedToStep
                  ? <span className="chip sage">-&gt; step added</span>
                  : <select onChange={(e) => e.target.value && convertObsToStep(o.id, e.target.value)} defaultValue="">
                      <option value="" disabled>-&gt; draft step on…</option>
                      {pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                    </select>}
                {o.convertedToFinding
                  ? <span className="chip alarm">-&gt; finding</span>
                  : <button className="btn small" onClick={() => convertObsToFinding(o.id, pages[0]?.id ?? run.pages[0]?.pageId)}>-&gt; finding</button>}
              </div>
            ))}
            <div className="dr-rowwrap" style={{ marginTop: 8 }}>
              <input className="dr-feedback" placeholder="Add an observation…" value={obsText} onChange={(e) => setObsText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addObs(); }} />
              <button className="btn small" onClick={addObs}><Plus size={11} /> Add</button>
            </div>
          </div>

          <div className="dr-sec card" style={{ borderColor: "var(--sage-2)", borderWidth: 1.5 }}>
            <div className="dr-rowwrap" style={{ marginBottom: 8 }}>
              <b>Findings - the fix report</b>
            </div>
            <Help>
              Everything this run caught: failed steps pool here automatically as proposed, and converted
              observations join them. Confirm what is real, Dismiss what is not - then Fix all confirmed
              sends ONE batch fix card to the Kanban board for an agent to work through. A finding
              already on a card shows an "on card" link and is never re-sent.
            </Help>
            {(() => {
              const active = run.findings.filter((f) => f.status !== "dismissed");
              const dismissed = run.findings.filter((f) => f.status === "dismissed");
              const renderFinding = (f: Finding) => (
                <div key={f.id} className="dr-finding">
                  <span className="dr-finding-text" style={{ textDecoration: f.status === "dismissed" ? "line-through" : "none" }}>
                    <span className="chip" style={{ marginRight: 6 }}>{f.kind}</span>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--mute)" }}>{f.pageId}{f.stepId ? `#${f.stepId}` : ""}</span>{" "}
                    {f.text}
                  </span>
                  <span className="dr-finding-actions">
                    <span className={"chip" + (f.status === "confirmed" ? " sage active" : "")}>{f.status}</span>
                    {f.card && (f.card.url
                      ? <a className="chip brass" href={f.card.url} target="_blank" rel="noreferrer" title="This finding is already on a Kanban fix card - click to open it">on card</a>
                      : <span className="chip brass" title="This finding is already on a Kanban fix card">on card</span>)}
                    {f.status !== "confirmed" && <button className="btn small" onClick={() => triage(f.id, "confirmed")}>Confirm</button>}
                    {f.status !== "dismissed" && !f.card && <button className="btn small" onClick={() => triage(f.id, "dismissed")}>Dismiss</button>}
                  </span>
                </div>
              );
              return (
                <>
                  {active.length === 0 && (
                    <div style={{ color: "var(--mute)", fontSize: 12 }}>
                      {dismissed.length > 0 ? "No open findings - everything was dismissed." : "No findings - every step passed."}
                    </div>
                  )}
                  {active.map(renderFinding)}
                  {dismissed.length > 0 && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: "pointer", fontSize: 11.5, color: "var(--mute)" }}>Dismissed ({dismissed.length})</summary>
                      {dismissed.map(renderFinding)}
                    </details>
                  )}
                </>
              );
            })()}
            <div className="dr-rowwrap" style={{ marginTop: 10 }}>
              <select value={dispatchMode} onChange={(e) => setDispatchMode(e.target.value as any)} style={{ fontSize: 11, padding: "5px 8px" }}
                title="Manual: dispatch now, with this button. Heartbeat: the periodic sweep dispatches once findings are confirmed. Immediate: dispatch as soon as a run ends.">
                <option value="manual">Dispatch: Manual</option>
                <option value="heartbeat">Dispatch: Heartbeat (autonomous)</option>
                <option value="immediate">Dispatch: Immediate</option>
              </select>
              <button className="btn primary" disabled={dispatchableCount === 0} onClick={dispatch}>Fix all confirmed ({dispatchableCount})</button>
              <span style={{ fontSize: 10, color: "var(--mute)" }}>
                {confirmedCount > 0 && dispatchableCount === 0
                  ? "every confirmed finding is already on a fix card"
                  : "one batch card carrying the new confirmed findings"}
              </span>
              {dispatchedCard && (
                <span className="chip sage active">
                  Sent to card{" "}
                  {dispatchedCard.url
                    ? <a href={dispatchedCard.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>{dispatchedCard.id.slice(-6)}</a>
                    : dispatchedCard.id.slice(-6)}
                </span>
              )}
            </div>
          </div>
        </>
        );
      })()}
    </div>
  );
}

// ─── States (C1-C7, R11) ──────────────────────────────────────────────────

interface DrillStateFull {
  id: string; label: string;
  fingerprint?: { url: string; headingText: string; shapeSketch: string };
  matcher?: { assertion: unknown | null };
  reachPath?: Array<{ id: string; description: string }>;
  screenshotPath?: string | null;
}
interface Snapshot { id: string; pageId: string; at: string; headingText: string; shapeSketch: string; screenshotPath: string | null }

// Per-card promote form: the name input's state must live IN the card - a
// single shared label field typed into one card mirroring into every other
// card was one of the audit's "nothing is intuitive" moments.
function SnapshotCard({ pageId, snap, onPromote }: { pageId: string; snap: Snapshot; onPromote: (snapshotId: string, label: string) => void }) {
  const [label, setLabel] = useState("");
  return (
    <div className="card dr-statecard">
      {snap.screenshotPath
        ? <img alt={`snapshot: ${snap.headingText || snap.id}`} src={`/api/states/${encodeURIComponent(pageId)}/snapshots/${encodeURIComponent(snap.id)}/screenshot`} className="dr-stateimg" />
        : <div className="dr-stateimg dr-noimg">no image captured</div>}
      <div className="mono" style={{ fontSize: 10, color: "var(--mute)" }}>{fmtDate(snap.at)}</div>
      <div style={{ fontSize: 11, margin: "4px 0" }}>{snap.headingText || "(no heading)"}</div>
      <input placeholder="state name, e.g. logged-out" value={label} onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && label.trim()) onPromote(snap.id, label.trim()); }}
        style={{ width: "100%", fontSize: 11, padding: "4px 6px", border: "1px solid var(--rule)", marginBottom: 4 }} />
      <button className="btn small" style={{ width: "100%", justifyContent: "center" }} disabled={!label.trim()} onClick={() => onPromote(snap.id, label.trim())}>
        Promote to state
      </button>
    </div>
  );
}

function StatesView() {
  const [pages, setPages] = useState<DrillPage[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Capture/promote problems are inline banners, never a full-view swap.
  const [stateError, setStateError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const load = () => {
    apiGet("/api/pages").then((r) => {
      setPages(r.pages);
      if (!pageId && r.pages.length > 0) setPageId(r.pages[0].id);
    }).catch((e) => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch
  useEffect(load, []);

  const loadSnapshots = (pid: string) => apiGet(`/api/states/${pid}/snapshots`).then((r) => setSnapshots(r.snapshots)).catch((e) => setStateError(e.message));
  useEffect(() => { if (pageId) loadSnapshots(pageId); }, [pageId]);

  const page = pages.find((p) => p.id === pageId) ?? null;

  const takeSnapshot = async () => {
    if (!pageId || capturing) return;
    setCapturing(true);
    setStateError(null);
    try {
      await apiPost(`/api/states/${pageId}/snapshot`, { viewport: "desktop" });
      loadSnapshots(pageId);
    } catch (e: any) {
      setStateError(`Capture failed: ${e.message}`);
    } finally {
      setCapturing(false);
    }
  };
  const promote = async (snapshotId: string, label: string) => {
    if (!pageId) return;
    setStateError(null);
    try {
      await apiPost(`/api/states/${pageId}/promote`, { snapshotId, label, reachPath: [] });
      load();
    } catch (e: any) {
      setStateError(`Promote failed: ${e.message}`);
    }
  };

  if (error) return <div className="dr-placeholder">{error} <button className="btn small" onClick={() => setError(null)}>dismiss</button></div>;
  if (!page) return <div className="dr-placeholder">No pages yet - plan the Book (Drill Book tab) or add a page in Authoring first.</div>;

  const states: DrillStateFull[] = (page.states as unknown as DrillStateFull[]) ?? [];

  return (
    <div>
      <Help>
        A state is a distinct condition a page can be in - logged out, empty, error - that changes what
        should be checked. Steps in Authoring can be scoped to a state, and each state records how to
        REACH it so runs can reproduce it. States are normally authored by the planning agent (Plan book
        on the Drill Book tab); this page is where you inspect them and hand-author extras.
      </Help>
      <div className="dr-sec dr-rowwrap">
        <span className="dr-lbl" style={{ margin: 0 }}>Page</span>
        <select value={pageId ?? ""} onChange={(e) => { setStateError(null); setPageId(e.target.value); }} style={{ fontSize: 12, padding: "5px 8px", border: "1px solid var(--rule)" }}>
          {pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      </div>

      {stateError && (
        <div className="dr-banner">
          <span style={{ flex: "1 1 240px" }}>{stateError}</span>
          <button className="btn small" onClick={() => setStateError(null)}>Dismiss</button>
        </div>
      )}

      <div className="dr-sec">
        <div className="dr-lbl">Named states - {page.title}</div>
        {states.length === 0 && (
          <div style={{ color: "var(--mute)", fontSize: 12, marginBottom: 8 }}>
            No named states yet for this page - Plan book authors them, or promote a manual snapshot below.
          </div>
        )}
        <div className="dr-cardrow">
          {states.map((s) => (
            <div key={s.id} className="card dr-statecard">
              {s.screenshotPath
                ? <img alt={`state: ${s.label}`} src={`/api/states/${encodeURIComponent(pageId!)}/${encodeURIComponent(s.id)}/screenshot`} className="dr-stateimg" />
                : <div className="dr-stateimg dr-noimg">no reference image - promoting a snapshot of this condition attaches one</div>}
              <div className="dr-rowwrap" style={{ marginBottom: 6 }}>
                <span className="chip brass active wrap">{s.label}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-2)", overflowWrap: "anywhere" }}>
                <b>Recognized by:</b> {s.fingerprint ? `heading "${s.fingerprint.headingText}" + page shape` : "nothing yet"}
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-2)", overflowWrap: "anywhere" }}>
                <b>How to reach it:</b> {s.reachPath && s.reachPath.length > 0 ? s.reachPath.map((r) => r.description).join(" -> ") : "(page entry)"}
              </div>
              <div style={{ fontSize: 10, color: "var(--mute)", marginTop: 4 }}>
                {(() => { const n = page.steps.filter((st) => (st as any).state === s.id).length; return `${n} step${n === 1 ? "" : "s"} scoped to this state`; })()}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="dr-sec">
        <div className="dr-lbl">Manual snapshots</div>
        <Help>
          A snapshot captures the page exactly as it renders right now. To hand-author a state: steer the
          app into the condition you want (use the interactive preview in Authoring), capture a snapshot
          here, then name it and promote it.
        </Help>
        <div className="dr-rowwrap" style={{ marginBottom: 10 }}>
          <button className="btn small" onClick={takeSnapshot} disabled={capturing}>
            <Camera size={11} /> {capturing ? "Capturing…" : "Capture snapshot"}
          </button>
        </div>
        <div className="dr-cardrow">
          {snapshots.length === 0 && <span style={{ color: "var(--mute)", fontSize: 12 }}>No snapshots yet.</span>}
          {snapshots.map((s) => (
            <SnapshotCard key={s.id} pageId={pageId!} snap={s} onPromote={promote} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── tab shell ───────────────────────────────────────────────────────────

const VIEWS: Array<{ id: string; label: string }> = [
  { id: "book", label: "Drill Book" },
  { id: "authoring", label: "Authoring" },
  { id: "states", label: "States" },
  { id: "results", label: "Run & results" }
];

function App() {
  const [view, setView] = useState("book");
  const [pendingRun, setPendingRun] = useState<{ pageIds: string[]; viewports: string[] } | null>(null);
  const [projInfo, setProjInfo] = useState<ProjectsInfo | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    apiGet("/api/projects").then((r) => {
      setProjInfo(r);
      // Fresh install / nothing selected: the choice IS the first step, so
      // put the picker front and center rather than a corner dropdown.
      if (!r.selected) setPickerOpen(true);
    }).catch(() => {});
  }, []);
  const runSelected = (pageIds: string[], viewports: string[]) => {
    setPendingRun({ pageIds, viewports });
    setView("results");
  };
  // Book -> Authoring navigation: AuthoringView reads its page from
  // localStorage at mount, so stamping it first lands on the right page.
  const openPage = (pid: string) => {
    try { localStorage.setItem("drill.authoring.page", pid); } catch { /* private mode */ }
    setView("authoring");
  };
  return (
    <>
      <div className="dr-header">
        <div className="topbar">
          <div className="brand">
            <span className="name">Drill</span>
            <span className="sub">visual QA</span>
          </div>
          <div className="spacer" />
          <ProjectBar info={projInfo} onOpenPicker={() => setPickerOpen(true)} />
        </div>
        <div className="dr-tabs">
          {VIEWS.map((v) => (
            <button key={v.id} className={"dr-tab" + (view === v.id ? " on" : "")} onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </div>
      </div>
      <div className="dr-body">
        {view === "book" && <BookView onRunSelected={runSelected} projInfo={projInfo} onOpenPicker={() => setPickerOpen(true)} onGoAuthoring={() => setView("authoring")} onOpenPage={openPage} />}
        {view === "authoring" && <AuthoringView />}
        {view === "states" && <StatesView />}
        {view === "results" && <ResultsView initialRun={pendingRun} onConsumeInitialRun={() => setPendingRun(null)} />}
      </div>
      {pickerOpen && projInfo && <ProjectPickerDialog info={projInfo} onClose={() => setPickerOpen(false)} />}
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

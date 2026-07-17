import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, Crosshair, Plus, X, Eye, FileCode2, Monitor, Tablet, Smartphone, Camera, NotebookPen } from "lucide-react";

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

function BookView({ onRunSelected, projInfo, onOpenPicker, onGoAuthoring }: {
  onRunSelected: (pageIds: string[], viewports: string[]) => void;
  projInfo: ProjectsInfo | null;
  onOpenPicker: () => void;
  onGoAuthoring: () => void;
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

      <div className="dr-sec dr-rowwrap" style={{ justifyContent: "space-between" }}>
        <div>
          <div className="dr-lbl">App</div>
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
        <span className={"chip click ink" + (book.fullDrill ? " active" : "")} onClick={toggleFullDrill}>
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
                <td><b>{p.title}</b> <span className="mono" style={{ color: "var(--mute-2)", fontSize: 10.5 }}>{p.path}</span></td>
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
            <span className={"chip click" + (step.judgment ? " brass active" : "")} onClick={onToggleJudgment} title="Needs ongoing model judgment (drillJudge), not a one-time deterministic find">
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
            <span className="chip click sage" onClick={() => onJumpRef(step.ref!)}>{step.ref}</span>
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
  const [pageId, setPageId] = useState<string | null>(null);
  const [viewportId, setViewportId] = useState("desktop");
  const [tab, setTab] = useState<{ tabId: string; canvasUrl: string; viewport: { width: number; height: number } } | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [stateSel, setStateSel] = useState("default");
  const [error, setError] = useState<string | null>(null);
  const [newPageId, setNewPageId] = useState("");
  // E1/E2: on a phone-width viewport the plan is a FAB-toggled bottom sheet
  // over a full-screen canvas, not a side column - CSS (.dr-au-plan's
  // mobile breakpoint) hides/shows it off this same flag.
  const [mobileSheetOpen, setMobileSheetOpen] = useState(true);
  const overlayRef = useRef<HTMLDivElement>(null);

  const loadPages = () => {
    apiGet("/api/pages").then((r) => {
      setPages(r.pages);
      setPageId((prev) => prev ?? (r.pages.length > 0 ? r.pages[0].id : null));
    }).catch((e) => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch; loadPages uses functional setState so it never reads stale pageId
  useEffect(loadPages, []);

  const page = pages.find((p) => p.id === pageId) ?? null;

  // Open/reuse the authoring tab whenever the page or viewport changes.
  useEffect(() => {
    if (!pageId) return;
    setTab(null);
    apiPost("/api/authoring/tab", { pageId, viewport: viewportId })
      .then((r) => setTab({ tabId: r.tabId, canvasUrl: r.canvasUrl, viewport: r.viewport }))
      .catch((e) => setError(e.message));
  }, [pageId, viewportId]);

  const savePage = async (patch: Partial<DrillPage>) => {
    if (!pageId) return;
    const r = await fetch(`/api/pages/${encodeURIComponent(pageId)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch)
    });
    const j = await r.json();
    setPages((ps) => ps.map((p) => (p.id === pageId ? j.page : p)));
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
    const x = ((e.clientX - box.left) / box.width) * tab.viewport.width;
    const y = ((e.clientY - box.top) / box.height) * tab.viewport.height;
    setPickMode(false);
    try {
      const r = await apiPost("/api/authoring/pick", { tabId: tab.tabId, x, y });
      if (!r.anchors) { setError("No element at that point"); return; }
      const n = page.areas.length + 1;
      const a: Area = {
        n,
        id: `${page.id}#${n}`,
        label: r.anchors.testId || r.anchors.ariaLabel || (r.anchors.text ? r.anchors.text.slice(0, 24) : `Area ${n}`),
        anchors: {
          testId: r.anchors.testId, role: r.anchors.role, ariaLabel: r.anchors.ariaLabel, text: r.anchors.text,
          tag: r.anchors.tag, css: r.anchors.css, cssMethod: r.anchors.cssMethod, xpath: r.anchors.xpath
        },
        pct: r.anchors.pct
      };
      await savePage({ areas: [...page.areas, a] });
      // E2: reopen the sheet with the new area ready for steps.
      setMobileSheetOpen(true);
    } catch (err: any) {
      setError(err.message);
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, page?.areas.length, page?.id]);

  const addStep = (area: number) => {
    if (!page) return;
    const step: Step = { id: newStepId(), area, mode: "vision", enabled: true, viewports: [viewportId], state: stateSel, description: "", tags: [] };
    savePage({ steps: [...page.steps, step] });
  };
  const patchStep = (stepId: string, patch: Partial<Step>) => {
    if (!page) return;
    savePage({ steps: page.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) });
  };
  const removeStep = (stepId: string) => {
    if (!page) return;
    savePage({ steps: page.steps.filter((s) => s.id !== stepId) });
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

  return (
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
              return (
                <span key={v.id} className={"chip click" + (viewportId === v.id ? " ink active" : " sage")} onClick={() => setViewportId(v.id)}>
                  <Icon size={11} /> {v.label}
                </span>
              );
            })}
          </div>
        </div>

        {tab ? (
          <div className="dr-cv" style={{ aspectRatio: `${tab.viewport.width} / ${tab.viewport.height}` }}>
            <iframe title="app under test" src={tab.canvasUrl} className="dr-cv-frame" />
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
          <div className="dr-placeholder">Opening tab…</div>
        )}

        <div className="dr-rowwrap" style={{ marginTop: 8 }}>
          <button className={"btn small" + (pickMode ? " primary" : "")} onClick={() => (pickMode ? setPickMode(false) : startHighlight())}>
            <Crosshair size={11} /> {pickMode ? "Click an element…" : "Highlight new area"}
          </button>
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
                <span key={s} className={"chip click brass" + (stateSel === s ? " active" : "")} onClick={() => setStateSel(s)}>{s}</span>
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
  );
}

// ─── Run & results (D1-D10, R10) ─────────────────────────────────────────

interface RunPageEntry {
  pageId: string; stepId: string; viewportId: string; automationRunId: string | null; status: string; error?: string;
  result: { stepId: string; status: string; tier?: string | null; error?: string; evidencePath?: string; durationMs?: number; result?: { passed?: boolean; reasoning?: string } } | null;
}
interface Finding { id: string; kind: string; pageId: string; stepId: string | null; text: string; status: "proposed" | "confirmed" | "dismissed"; at: string }
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
  const [runs, setRuns] = useState<Array<{ id: string; startedAt: string; contextTag: string }>>([]);
  const [run, setRun] = useState<DrillRun | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [selectedViewports, setSelectedViewports] = useState<Set<string>>(new Set(["desktop"]));
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [obsText, setObsText] = useState("");
  const [dispatchMode, setDispatchMode] = useState<"manual" | "heartbeat" | "immediate">("manual");
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
      setError(j.dispatched ? null : `Heartbeat: ${j.pending} confirmed finding(s) queued for the next beat.`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const confirmedCount = run ? run.findings.filter((f) => f.status === "confirmed").length : 0;

  return (
    <div>
      <div className="dr-sec card">
        <div className="dr-lbl">Run selected</div>
        <div className="dr-rowwrap" style={{ marginBottom: 8 }}>
          {pages.map((p) => (
            <span key={p.id} className={"chip click" + (selectedPages.has(p.id) ? " ink active" : "")}
              onClick={() => setSelectedPages((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}>
              {p.title}
            </span>
          ))}
        </div>
        <div className="dr-rowwrap" style={{ marginBottom: 8 }}>
          {VIEWPORTS.map((v) => (
            <span key={v.id} className={"chip click" + (selectedViewports.has(v.id) ? " sage active" : "")}
              onClick={() => setSelectedViewports((s) => { const n = new Set(s); n.has(v.id) ? n.delete(v.id) : n.add(v.id); return n; })}>
              {v.label}
            </span>
          ))}
        </div>
        <button className="btn primary" disabled={running} onClick={() => startRun()}>{running ? (phase ?? "Running…") : "Run"}</button>
        <AppStatusChip />
        {runs.length > 0 && (
          <select style={{ marginLeft: 8, fontSize: 11, padding: "5px 8px" }}
            value={run?.id ?? ""} onChange={(e) => apiGet(`/api/runs/${e.target.value}`).then((r) => setRun(r.run))}>
            {runs.map((r) => <option key={r.id} value={r.id}>{r.id} ({r.contextTag})</option>)}
          </select>
        )}
      </div>

      {error && <div className="dr-placeholder">{error}</div>}

      {pendingGate && (
        <div className="dr-sec card" style={{ borderColor: "var(--brass)", borderWidth: 1.5 }}>
          <div className="dr-rowwrap" style={{ marginBottom: 8 }}>
            <b className="t12">Plan ready - gated, awaiting approval</b>
          </div>
          {pendingGate.plan.map((p) => (
            <div key={`${p.pageId}:${p.viewportId}`} className="t11" style={{ marginBottom: 6 }}>
              <b>{p.pageId}</b> <span className="chip sage">{p.viewportId}</span>
              <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                {p.steps.map((s) => (
                  <li key={s.id} className="t11">{s.description} <span className="mono" style={{ fontSize: 10, color: "var(--mute)" }}>({s.mode})</span></li>
                ))}
                {p.steps.length === 0 && <li className="t11" style={{ color: "var(--mute)" }}>(no enabled steps)</li>}
              </ul>
            </div>
          ))}
          <div className="dr-rowwrap" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={running} onClick={approveGate}>{running ? "Running…" : "Approve and run"}</button>
            <button className="btn small" onClick={() => setPendingGate(null)}>Cancel</button>
          </div>
        </div>
      )}

      {!run && !error && !pendingGate && <div className="dr-placeholder">No runs yet.</div>}

      {run && (
        <>
          <div className="dr-sec">
            <div className="dr-lbl">Results - run {run.id}</div>
            {run.pages.map((entry) => {
              const passed = stepPassed(entry);
              const key = `${entry.pageId}:${entry.stepId}`;
              const override_ = run.overrides[key];
              const notes = run.feedback[key] ?? [];
              return (
                <div key={key} className="dr-res" style={{ borderLeft: `3px solid var(${passed && !override_ ? "--sage" : "--alarm"})` }}>
                  <div className="dr-rowwrap">
                    {passed ? <Check size={14} style={{ color: "var(--sage)" }} /> : <span style={{ color: "var(--alarm)", fontWeight: 700 }}>×</span>}
                    <span className="mono" style={{ fontSize: 11, color: "var(--mute)" }}>{entry.pageId}#{entry.stepId}</span>
                    <span className="chip">{entry.viewportId}</span>
                    {entry.result?.tier && <span className={"chip " + tierTone(entry.result.tier)}>{entry.result.tier}</span>}
                    {entry.result?.evidencePath && <span className="mono" style={{ fontSize: 9.5, color: "var(--mute-2)" }}>{entry.result.evidencePath}</span>}
                  </div>
                  {entry.result?.error && <div style={{ color: "var(--alarm)", fontSize: 11, marginTop: 4 }}>{entry.result.error}</div>}
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
            })}
          </div>

          <div className="dr-sec card">
            <div className="dr-rowwrap" style={{ marginBottom: 8 }}>
              <b>Observations</b>
              <span style={{ fontSize: 10, color: "var(--mute)" }}>things no step covers, no re-run needed</span>
            </div>
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
              <b>Run report - findings</b>
            </div>
            {run.findings.length === 0 && <div style={{ color: "var(--mute)", fontSize: 12 }}>No findings yet.</div>}
            {run.findings.map((f) => (
              <div key={f.id} className="dr-rowwrap" style={{ padding: "5px 0", borderTop: "1px dashed var(--rule)" }}>
                <span style={{ flex: "1 1 220px", textDecoration: f.status === "dismissed" ? "line-through" : "none" }}>
                  [{f.kind}] {f.pageId}{f.stepId ? `#${f.stepId}` : ""}: {f.text}
                </span>
                <span className={"chip" + (f.status === "confirmed" ? " sage active" : "")}>{f.status}</span>
                {f.status !== "confirmed" && <button className="btn small" onClick={() => triage(f.id, "confirmed")}>Confirm</button>}
                {f.status !== "dismissed" && <button className="btn small" onClick={() => triage(f.id, "dismissed")}>Dismiss</button>}
              </div>
            ))}
            <div className="dr-rowwrap" style={{ marginTop: 10 }}>
              <select value={dispatchMode} onChange={(e) => setDispatchMode(e.target.value as any)} style={{ fontSize: 11, padding: "5px 8px" }}>
                <option value="manual">Dispatch: Manual</option>
                <option value="heartbeat">Dispatch: Heartbeat (autonomous)</option>
                <option value="immediate">Dispatch: Immediate</option>
              </select>
              <button className="btn primary" disabled={confirmedCount === 0} onClick={dispatch}>Fix all confirmed ({confirmedCount})</button>
              <span style={{ fontSize: 10, color: "var(--mute)" }}>one batch card carrying the report</span>
            </div>
          </div>
        </>
      )}
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

function StatesView() {
  const [pages, setPages] = useState<DrillPage[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  const load = () => {
    apiGet("/api/pages").then((r) => {
      setPages(r.pages);
      if (!pageId && r.pages.length > 0) setPageId(r.pages[0].id);
    }).catch((e) => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch
  useEffect(load, []);

  const loadSnapshots = (pid: string) => apiGet(`/api/states/${pid}/snapshots`).then((r) => setSnapshots(r.snapshots)).catch((e) => setError(e.message));
  useEffect(() => { if (pageId) loadSnapshots(pageId); }, [pageId]);

  const page = pages.find((p) => p.id === pageId) ?? null;

  const takeSnapshot = async () => {
    if (!pageId) return;
    try {
      await apiPost(`/api/states/${pageId}/snapshot`, { viewport: "desktop" });
      loadSnapshots(pageId);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const promote = async (snapshotId: string) => {
    if (!pageId || !label.trim()) return;
    try {
      await apiPost(`/api/states/${pageId}/promote`, { snapshotId, label: label.trim(), reachPath: [] });
      setLabel("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (error) return <div className="dr-placeholder">{error} <button className="btn small" onClick={() => setError(null)}>dismiss</button></div>;
  if (!page) return <div className="dr-placeholder">No pages yet.</div>;

  const states: DrillStateFull[] = (page.states as unknown as DrillStateFull[]) ?? [];

  return (
    <div>
      <div className="dr-sec dr-rowwrap">
        <select value={pageId ?? ""} onChange={(e) => setPageId(e.target.value)} style={{ fontSize: 12, padding: "5px 8px", border: "1px solid var(--rule)" }}>
          {pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <button className="btn small" onClick={takeSnapshot}><Camera size={11} /> Take snapshot</button>
      </div>

      <div className="dr-sec">
        <div className="dr-lbl">Snapshots</div>
        <div className="dr-rowwrap">
          {snapshots.length === 0 && <span style={{ color: "var(--mute)", fontSize: 12 }}>No snapshots yet.</span>}
          {snapshots.map((s) => (
            <div key={s.id} className="card" style={{ width: 160 }}>
              <div className="mono" style={{ fontSize: 10, color: "var(--mute)" }}>{new Date(s.at).toLocaleTimeString()}</div>
              <div style={{ fontSize: 11, margin: "4px 0" }}>{s.headingText || "(no heading)"}</div>
              <input placeholder="name…" value={label} onChange={(e) => setLabel(e.target.value)}
                style={{ width: "100%", fontSize: 11, padding: "4px 6px", border: "1px solid var(--rule)", marginBottom: 4 }} />
              <button className="btn small" style={{ width: "100%", justifyContent: "center" }} onClick={() => promote(s.id)}>Promote to state</button>
            </div>
          ))}
        </div>
      </div>

      <div className="dr-sec">
        <div className="dr-lbl">States</div>
        <div className="dr-rowwrap" style={{ alignItems: "stretch" }}>
          {states.length === 0 && <span style={{ color: "var(--mute)", fontSize: 12 }}>No named states yet - promote a snapshot above.</span>}
          {states.map((s) => (
            <div key={s.id} className="card" style={{ width: 240 }}>
              <div className="dr-rowwrap" style={{ marginBottom: 6 }}>
                <span className="chip brass active">{s.label}</span>
              </div>
              {s.screenshotPath && (
                <img alt={s.label} src={`/api/states/${pageId}/${s.id}/screenshot`} style={{ width: "100%", height: 90, objectFit: "cover", marginBottom: 6, border: "1px solid var(--rule)" }} />
              )}
              <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
                <b>Matcher:</b> {s.fingerprint ? `shape ~${s.fingerprint.shapeSketch.split(",").length} tokens, heading "${s.fingerprint.headingText}"` : "none"}
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
                <b>Reach:</b> {s.reachPath && s.reachPath.length > 0 ? s.reachPath.map((r) => r.description).join(" -> ") : "(entry)"}
              </div>
              <div style={{ fontSize: 10, color: "var(--mute)", marginTop: 4 }}>
                {page.steps.filter((st) => (st as any).state === s.id).length} scoped steps
              </div>
            </div>
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
        {view === "book" && <BookView onRunSelected={runSelected} projInfo={projInfo} onOpenPicker={() => setPickerOpen(true)} onGoAuthoring={() => setView("authoring")} />}
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

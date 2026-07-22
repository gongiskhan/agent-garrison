import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import useEmblaCarousel from "embla-carousel-react";
import { Check, Crosshair, Plus, X, Eye, FileCode2, Monitor, Tablet, Smartphone, NotebookPen, ArrowLeft, ArrowRight, RotateCw, RefreshCcw, ExternalLink, Terminal, Play, Pause, Flag, Film, Video as VideoIcon, LayoutGrid, ListFilter, LocateFixed, MessageSquare, Wrench, SquarePen } from "lucide-react";

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

// The server's canvasUrl is a loopback URL into the Browser fitting - correct
// on the Garrison machine, unreachable from anywhere else. The user is usually
// on ANOTHER device reaching this UI over the HTTPS tailnet address, so the
// server pairs every canvas URL with canvasTailnetUrl (the same embed at its
// `tailscale serve` mapping). Pick by where this page actually runs - mirrors
// the shell's resolveViewUrl (src/components/fitting-views/browser-view-url.ts).
// Returns "" when nothing reachable exists (remote page + unmapped port): an
// http:// loopback rebind under an HTTPS page is mixed content, which the
// browser blocks into a silently blank iframe - callers must say so instead.
function resolveEmbedUrl(url?: string | null, tailnetUrl?: string | null): string {
  if (!url) return "";
  const here = window.location.hostname;
  if (!here || here === "127.0.0.1" || here === "localhost") return url;
  if (tailnetUrl) {
    try {
      if (new URL(tailnetUrl).hostname === here) return tailnetUrl;
    } catch { /* fall through to the rebind fallback */ }
  }
  const rebound = url.replace(/^(https?:\/\/)(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i, `$1${here}`);
  if (window.location.protocol === "https:" && rebound.startsWith("http://")) return "";
  return rebound;
}

// Reveal `el` within its nearest INTERNAL scroll container only — never the
// page/window. `element.scrollIntoView()` walks every scrollable ancestor, so
// as the debrief reel auto-advances it kept dragging the whole page back to the
// pinned rail (the "keeps pulling me to the screenshots" bug). We adjust only
// the first genuine inner scroll container's scrollTop; if none exists (mobile
// stacked layout, where the rail flows in the page), we leave scroll untouched.
function revealWithinScrollParent(el: HTMLElement | null | undefined) {
  if (!el) return;
  let parent = el.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const overflowY = getComputedStyle(parent).overflowY;
    if (/(auto|scroll)/.test(overflowY) && parent.scrollHeight > parent.clientHeight) {
      const pr = parent.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (er.top < pr.top) parent.scrollTop -= pr.top - er.top;
      else if (er.bottom > pr.bottom) parent.scrollTop += er.bottom - pr.bottom;
      return;
    }
    parent = parent.parentElement;
  }
}

function fullBrowserViewUrl(canvasUrl: string) {
  try {
    const url = new URL(canvasUrl, window.location.href);
    // Preserve viewport-related query parameters added by the Browser client;
    // only remove the chrome-suppression flag used by Drill's embed.
    url.searchParams.delete("embed");
    return url.toString();
  } catch {
    return canvasUrl;
  }
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
interface DrillState { id: string; label: string; matcher?: unknown; reachPath?: unknown; screenshotPath?: string | null }
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

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function DialogFrame({ labelledBy, onClose, children }: {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const root = dialogRef.current;
    const initial = root?.querySelector<HTMLElement>("[data-dialog-initial]")
      ?? root?.querySelector<HTMLElement>(FOCUSABLE);
    initial?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dr-modal-overlay" onClick={() => closeRef.current()}>
      <div
        ref={dialogRef}
        className="dr-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

// ─── project selection + app-under-test lifecycle ────────────────────────

interface Project { name: string; path: string; runSkill: string | null; hasDrillBook: boolean; active: boolean }
interface ProjectsInfo { projects: Project[]; active: { root: string; name: string } | null; selected: boolean; devRoot: string }
interface AppStartJob { status: string; skill: string | null; error: string | null; url: string | null; logFile: string | null }
interface AppStatus { root: string; url: string | null; configured: boolean; reachable: boolean; runSkill: string | null; selected?: boolean; job: AppStartJob | null }
interface PlanProgress {
  transcriptBytes: number;
  transcriptEvents: number;
  lastActivityAt: string | null;
  lastActivity: string | null;
  drillsFilesChanged: number;
  pagesAuthored: number;
}
interface PlanJob {
  status: string;
  mode: string;
  brief: string | null;
  error: string | null;
  logFile: string | null;
  pages: number | null;
  startedAt: string;
  deadlineAt: string;
  canceledAt: string | null;
  progress?: PlanProgress;
}
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
  { brief = null, join = false, rootHint = null }: { brief?: string | null; join?: boolean; rootHint?: string | null },
  onPhase: (msg: string | null) => void,
  onJob?: (job: PlanJob | null) => void
): Promise<PlanStatus> {
  // A caller that already has a pinned project identity (e.g. BookView, once
  // it has loaded) passes it here so even the FIRST status check follows
  // that identity - not whatever project is live right now in another tab.
  let st = (await apiGet(rootHint ? `/api/plan/status?root=${encodeURIComponent(rootHint)}` : "/api/plan/status")) as PlanStatus;
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
    onJob?.(st.job);
    if (st.job && st.job.status === "done") { onPhase(null); return st; }
    // A cancel is a normal, user-requested stop - not an error. Return
    // normally so the caller can show a notice instead of an error banner.
    if (st.job && st.job.status === "canceled") { onPhase(null); return st; }
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
      <select aria-label="Project" value={info.selected && info.active ? info.active.root : ""} disabled={switching} onChange={(e) => onChange(e.target.value)}>
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
    <DialogFrame labelledBy="dr-project-dialog-title" onClose={onClose}>
        <h2 id="dr-project-dialog-title">Select project</h2>
        <p className="hint">
          The app under test. Projects are the git repos under <span className="mono">{info.devRoot}</span> (the
          same list as the Dev Env picker; change the dev root there). [drill book] marks projects that
          already carry a Drill Book.
        </p>
        <label>
          Project
          <select
            data-dialog-initial
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
        {err && <div role="alert" style={{ color: "var(--alarm)", fontSize: 11.5, marginBottom: 8 }}>{err}</div>}
        <div className="row">
          <button className="btn small" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !path.trim()} onClick={submit}>{busy ? "Selecting…" : "Select"}</button>
        </div>
    </DialogFrame>
  );
}

// Explicit (re)plan doorway: full plan when the brief is empty, an update
// scoped to a change when it names one. The agent session authors the Book;
// the Authoring surface stays the manual override.
function PlanDialog({ hasPages, onClose, onKick }: { hasPages: boolean; onClose: () => void; onKick: (brief: string | null) => void }) {
  const [brief, setBrief] = useState("");
  return (
    <DialogFrame labelledBy="dr-plan-dialog-title" onClose={onClose}>
        <h2 id="dr-plan-dialog-title">Plan the Drill Book</h2>
        <p className="hint">
          A headless agent session explores the project and authors the Book on its own judgment - pages,
          steps, and states, the works. Leave the brief empty to plan the whole app
          {hasPages ? " (the agent extends and corrects the existing Book - it may revise steps, but is told never to discard manual work)" : ""}; describe
          a change to scope the plan to what it touches. Tweak the result in Authoring afterwards if you want.
        </p>
        <label>
          Change brief (optional)
          <textarea
            data-dialog-initial
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
    </DialogFrame>
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

function Checkbox({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button className={"dr-checkbox" + (on ? " on" : "")} onClick={onClick} aria-pressed={on} aria-label={label}>
      {on && <Check size={10} strokeWidth={3} />}
    </button>
  );
}

function SectionIntro({ title, children, aside }: {
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="dr-intro">
      <div>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      {aside && <div className="dr-intro-aside">{aside}</div>}
    </div>
  );
}

function formatDate(value: string | null | undefined) {
  if (!value) return "In progress";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatDuration(startedAt: string, endedAt: string | null) {
  if (!endedAt) return "Running";
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// Browser <img> requests emit noisy console errors for an expected stale
// reference. Fetch first so a 404 becomes an intentional UI state, then show
// the successful bytes through a short-lived object URL.
function useFetchedImage(src: string | null, availabilityUrl: string | null = null) {
  const [imageUrl, setImageUrl] = useState<string | null | undefined>(() => src ? undefined : null);
  useEffect(() => {
    if (!src) {
      setImageUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setImageUrl(undefined);
    Promise.resolve()
      .then(async () => {
        if (!availabilityUrl) return;
        const status = await fetch(availabilityUrl, { cache: "no-store" });
        if (!status.ok || !(await status.json()).available) throw new Error("image unavailable");
      })
      .then(async () => {
        const response = await fetch(src, { cache: "no-store" });
        if (!response.ok) throw new Error(`image unavailable (${response.status})`);
        objectUrl = URL.createObjectURL(await response.blob());
        if (!cancelled) setImageUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setImageUrl(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, availabilityUrl]);
  return imageUrl;
}

// ─── Book view (S11 S12 S13, A1-A9) ─────────────────────────────────────

function BookView({ onRunSelected, projInfo, onOpenPicker, onGoAuthoring }: {
  onRunSelected: (pageIds: string[], viewports: string[]) => void;
  projInfo: ProjectsInfo | null;
  onOpenPicker: () => void;
  onGoAuthoring: (pageId?: string) => void;
}) {
  const [book, setBook] = useState<DrillBook | null>(null);
  const [pages, setPages] = useState<DrillPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [planPhase, setPlanPhase] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [planJob, setPlanJob] = useState<PlanJob | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [canceledNotice, setCanceledNotice] = useState<string | null>(null);
  const [planLog, setPlanLog] = useState<string | null>(null);
  const [planLogOpen, setPlanLogOpen] = useState(false);
  // Captured from the first load and reused on every write: a second tab
  // switching the live project selection must not redirect THIS view's
  // writes to the newly selected repo mid-session (see resolveMutationRoot
  // in the server - a stale/mismatched pin is rejected there, not silently
  // widened).
  const pinnedRootRef = useRef<string | null>(null);

  const load = () => {
    Promise.all([apiGet("/api/drillbook"), apiGet("/api/pages")])
      .then(([b, p]) => { pinnedRootRef.current = b.root ?? pinnedRootRef.current; setBook(b.book); setPages(p.pages); })
      .catch((e) => setError(e.message));
  };

  // Every Book write is pinned to the root this view loaded against, not
  // whatever project happens to be live when the request lands.
  const patchBook = (patch: Partial<DrillBook>) =>
    apiPatch("/api/drillbook", { ...patch, root: pinnedRootRef.current ?? undefined });

  // Plan the Book through the headless agent session, then reload what it
  // wrote; with thenRun, continue straight into the run the user asked for.
  // join=true (the mount path) never kicks a session - it attaches to an
  // in-flight plan, or just surfaces a failure that predates this mount
  // while the Book is still empty (the only time it is the live blocker).
  const runPlan = async (brief: string | null, thenRun: boolean, join = false) => {
    if (planBusy) return;
    setError(null);
    setCanceledNotice(null);
    setPlanJob(null);
    setPlanBusy(true);
    try {
      const st = await ensurePlanned({ brief, join, rootHint: pinnedRootRef.current }, setPlanPhase, setPlanJob);
      if (st.job && st.job.status === "canceled") {
        setCanceledNotice(`Planning canceled - ${st.pages} page${st.pages === 1 ? "" : "s"} on disk. Plan book to retry.`);
        return;
      }
      if (join && (!st.job || st.job.status !== "done")) {
        if (st.job && st.job.status === "failed" && st.pages === 0) {
          setError(st.job.error || "planning failed");
        }
        return;
      }
      const [b, p] = await Promise.all([apiGet("/api/drillbook"), apiGet("/api/pages")]);
      pinnedRootRef.current = b.root ?? pinnedRootRef.current;
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
      setPlanJob(null);
      setPlanBusy(false);
    }
  };

  // Cancel the plan currently in flight (planJob is only ever non-null while
  // ensurePlanned's poll loop is running). A safe stop, not an error - the
  // notice comes from runPlan once ensurePlanned returns the "canceled" job.
  const cancelRunningPlan = async () => {
    if (canceling) return;
    setCanceling(true);
    try {
      await apiPost("/api/plan/cancel", { root: pinnedRootRef.current ?? undefined });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCanceling(false);
    }
  };

  const loadPlanLog = async () => {
    try {
      const r = await fetch(`/api/plan/log${pinnedRootRef.current ? `?root=${encodeURIComponent(pinnedRootRef.current)}` : ""}`);
      setPlanLog(r.ok ? await r.text() : "(no plan log available)");
    } catch (e: any) {
      setPlanLog(`(could not load the plan log: ${e.message})`);
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
    const saved = await patchBook({ pages: nextPages });
    setBook(saved.book);
  };
  const toggleFullDrill = async () => {
    const saved = await patchBook({ fullDrill: !book.fullDrill });
    setBook(saved.book);
  };
  const setAutonomy = async (autonomy: "gated" | "auto") => {
    const saved = await patchBook({ autonomy });
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

  // Turns the raw job/progress payload into the activity line a healthy
  // 11-minute plan and a genuine hang used to be indistinguishable without:
  // elapsed time, time left before the deadline, what the agent last did,
  // and how long ago - so a stalled session actually LOOKS stalled.
  const planActivity = (() => {
    if (!planJob || planJob.status !== "planning") return null;
    const fmt = (sec: number) => {
      const m = Math.floor(sec / 60), s = Math.round(sec % 60);
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };
    const now = Date.now();
    const parts: string[] = [];
    if (planJob.startedAt) parts.push(`running ${fmt((now - Date.parse(planJob.startedAt)) / 1000)}`);
    if (planJob.deadlineAt) {
      const remaining = (Date.parse(planJob.deadlineAt) - now) / 1000;
      if (remaining > 0) parts.push(`${fmt(remaining)} left before timeout`);
    }
    const p = planJob.progress;
    let staleSec: number | null = null;
    if (p?.lastActivityAt) {
      staleSec = (now - Date.parse(p.lastActivityAt)) / 1000;
      parts.push(p.lastActivity ? `last: ${p.lastActivity} (${fmt(Math.max(0, staleSec))} ago)` : `active ${fmt(Math.max(0, staleSec))} ago`);
    }
    if (p && (p.pagesAuthored > 0 || p.drillsFilesChanged > 0)) {
      parts.push(`${p.pagesAuthored} page${p.pagesAuthored === 1 ? "" : "s"} on disk, ${p.drillsFilesChanged} file change${p.drillsFilesChanged === 1 ? "" : "s"}`);
    }
    const stale = staleSec !== null && staleSec > 120;
    return { text: parts.join(" · "), stale };
  })();

  return (
    <div>
      <SectionIntro
        title="Drill Book"
        aside={<AppStatusChip />}
      >
        This is the test plan the agent maintains for the selected app. Choose what to cover, review the rules, or open a page to inspect and edit its steps beside the live preview.
      </SectionIntro>

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
            {book.app.url && <span className="mono dr-app-url">{book.app.url}</span>}
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
        <div className="dr-sec">
          <div className="dr-rowwrap" style={{ justifyContent: "space-between" }}>
            <span style={{ color: "var(--brass)", fontSize: 12 }}>{planPhase}</span>
            <button className="btn small" onClick={cancelRunningPlan} disabled={canceling}>
              {canceling ? "Canceling…" : "Cancel"}
            </button>
          </div>
          {planActivity && (
            <div style={{ fontSize: 11, marginTop: 4, color: planActivity.stale ? "var(--alarm)" : "var(--ink-2)" }}>
              {planActivity.text}
              {planActivity.stale && " · no output recently - the plan may be stuck, Cancel to stop it"}
            </div>
          )}
        </div>
      )}

      {canceledNotice && (
        <div className="dr-notice" role="status">{canceledNotice}</div>
      )}

      {error && (
        <div className="dr-placeholder">
          {error}
          {pages.length === 0 && (
            <button className="btn small" style={{ marginLeft: 8 }} onClick={() => onGoAuthoring()}>Open Authoring</button>
          )}
          <button
            className="btn small"
            style={{ marginLeft: 8 }}
            onClick={() => { const next = !planLogOpen; setPlanLogOpen(next); if (next && planLog === null) loadPlanLog(); }}
          >
            {planLogOpen ? "Hide plan log" : "Show plan log"}
          </button>
          {planLogOpen && (
            <pre className="mono" style={{ marginTop: 8, maxHeight: 240, overflow: "auto", fontSize: 11, whiteSpace: "pre-wrap" }}>
              {planLog ?? "Loading…"}
            </pre>
          )}
        </div>
      )}

      <div className="dr-sec dr-rowwrap">
        <button className={"chip click ink" + (book.fullDrill ? " active" : "")} onClick={toggleFullDrill} aria-pressed={book.fullDrill}>
          Full Drill {book.fullDrill ? "on" : "off"}
        </button>
        {book.viewports.map((vp) => (
          <span key={vp} className="chip sage">{vp}</span>
        ))}
        <select aria-label="Run autonomy" value={book.autonomy} onChange={(e) => setAutonomy(e.target.value as "gated" | "auto")}
          style={{ fontSize: 11, padding: "6px 8px", border: "1px solid var(--rule)", background: "var(--paper-2)", color: "var(--ink)", fontFamily: "var(--sans)" }}>
          <option value="gated">Gated: approve plan before running</option>
          <option value="auto">Autonomous: plan, run, report</option>
        </select>
      </div>

      <div className="dr-sec">
        <div className="dr-lbl">Global rules and notes</div>
        <textarea
          aria-label="Global rules and notes"
          className="mono"
          defaultValue={book.globalRules}
          placeholder="App-specific truths that feed every plan and review (citations required, no console errors, …)"
          onBlur={(e) => patchBook({ globalRules: e.target.value }).then((r) => setBook(r.book))}
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
                <td data-label="Run"><Checkbox label={`Include ${p.title} in runs`} on={book.fullDrill || selectedIds.has(p.id)} onClick={() => togglePageSelected(p.id)} /></td>
                <td data-label="Page">
                  <button className="dr-page-link" onClick={() => onGoAuthoring(p.id)}>
                    <span><b>{p.title}</b> <span className="mono">{p.path}</span></span>
                    <span aria-hidden="true">→</span>
                  </button>
                </td>
                <td data-label="Mode">{p.mode === "steps" ? "Step by step" : <span style={{ color: "var(--brass)", fontWeight: 600 }}>Whole page vision</span>}</td>
                <td data-label="Areas">{p.areas.length}</td>
                <td data-label="Steps">{p.steps.length}</td>
                <td data-label="States">{p.states.length}</td>
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
  // The check text reads as full, wrapping prose by default (a check is an
  // acceptance-criterion sentence, not a one-liner) with an explicit Edit
  // button; a cramped 2-row textarea clipped it and hid what the check said.
  // Clicking the text also enters edit mode; blur / Esc / Cmd+Enter commit.
  const [editing, setEditing] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const commit = () => {
    const el = taRef.current;
    if (el && el.value !== step.description) onEditDescription(el.value);
    setEditing(false);
  };
  return (
    <div className="dr-step" style={{ opacity: step.enabled ? 1 : 0.5 }}>
      <Checkbox label={`${step.enabled ? "Disable" : "Enable"} check ${step.description || step.id}`} on={step.enabled} onClick={onToggleEnabled} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <textarea
            ref={taRef}
            className="dr-step-desc"
            aria-label={`Edit check description for ${step.id}`}
            defaultValue={step.description}
            autoFocus
            rows={Math.min(12, Math.max(3, Math.ceil((step.description?.length || 0) / 56) + 1))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); commit(); }
              else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commit(); }
            }}
          />
        ) : (
          <div
            className={"dr-step-text" + (step.description ? "" : " empty")}
            role="button"
            tabIndex={0}
            title="Click to edit this check"
            onClick={() => setEditing(true)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditing(true); } }}
          >
            {step.description || "No check written yet — click to add one"}
          </div>
        )}
        <div className="dr-rowwrap" style={{ marginTop: 4 }}>
          {/* preventDefault on mousedown keeps the textarea from blur-committing
              before this click toggles, so Done never re-opens the editor. */}
          <button
            className={"dr-edit chip click" + (editing ? " sage active" : "")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (editing ? commit() : setEditing(true))}
            aria-label={editing ? `Finish editing ${step.id}` : `Edit check ${step.description || step.id}`}
          >
            {editing ? <><Check size={10} /> Done</> : <><SquarePen size={10} /> Edit</>}
          </button>
          <button
            className={"dr-mode" + (step.mode === "vision" ? " vision" : " e2e")}
            onClick={onToggleMode}
            aria-label={`Change ${step.description || step.id} from ${step.mode} mode`}
          >
            {step.mode === "vision" ? <Eye size={10} /> : <FileCode2 size={10} />}
            {step.mode}
          </button>
          {step.mode === "vision" && (
            <button className={"chip click" + (step.judgment ? " brass active" : "")} onClick={onToggleJudgment} aria-pressed={!!step.judgment} aria-label={`Ongoing model judgment for ${step.description || step.id}`} title="Needs ongoing model judgment (drillJudge), not a one-time deterministic find">
              judgment
            </button>
          )}
          {step.spec && <span className="mono" style={{ fontSize: 10, color: "var(--mute)" }}>{step.spec}</span>}
          {step.viewports.map((v) => {
            const vp = VIEWPORTS.find((x) => x.id === v);
            const Icon = vp?.icon ?? Monitor;
            return <Icon key={v} size={11} style={{ color: "var(--mute)" }} />;
          })}
          {step.ref && (
            <button className="chip click sage" aria-label={`Open referenced area ${step.ref}`} onClick={() => onJumpRef(step.ref!)}>{step.ref}</button>
          )}
          {step.state !== "default" && <span className="chip brass">{step.state}</span>}
        </div>
      </div>
      <button className="dr-xbtn" onClick={onRemove} title="Remove step" aria-label={`Remove check ${step.description || step.id}`}><X size={14} /></button>
    </div>
  );
}

function AuthoringView({ initialPageId, onPageChange }: {
  initialPageId?: string | null;
  onPageChange: (pageId: string) => void;
}) {
  const [pages, setPages] = useState<DrillPage[]>([]);
  // Remember the last-authored page across reloads - resetting to the first
  // page alphabetically loses the author's place every refresh.
  const initialAuthoringPage = initialPageId ?? localStorage.getItem("drill.authoring.page");
  const [pageId, setPageId] = useState<string | null>(initialAuthoringPage);
  const pageIdRef = useRef<string | null>(initialAuthoringPage);
  const [viewportId, setViewportId] = useState("desktop");
  const [tab, setTab] = useState<{
    tabId: string;
    canvasUrl: string;
    canvasTailnetUrl: string | null;
    screenshotUrl: string;
    url: string;
    // The authored page's target URL (page.path against the Book's app URL) at
    // open time. `url` above is a live-URL mirror the tab-info poll rewrites
    // as the author browses; this one stays fixed so "Go to page" always has
    // the way back.
    pageUrl: string;
    viewport: { width: number; height: number };
  } | null>(null);
  const [tabError, setTabError] = useState<string | null>(null);
  const [tabLoadRevision, setTabLoadRevision] = useState(0);
  const [pickMode, setPickMode] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [areaResolutionRevision, setAreaResolutionRevision] = useState(0);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const [targetViewport, setTargetViewport] = useState<{ width: number; height: number } | null>(null);
  const [preparingPick, setPreparingPick] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
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
  // Browser-first on narrow screens: opening Authoring must show the app, not
  // cover it immediately with a 62vh fixed sheet. The FAB opens the plan.
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const isNarrowAuthoring = useMediaQuery("(max-width: 760px)");
  const overlayRef = useRef<HTMLDivElement>(null);
  // Manual-testing toolbar state: the live URL (polled), the editable URL
  // draft (reverts to live on blur, like a real browser urlbar), and console.
  const [urlDraft, setUrlDraft] = useState("");
  const urlFocused = useRef(false);
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<Array<{ ts: number; level: string; text: string }>>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const planFabRef = useRef<HTMLButtonElement>(null);
  const planCloseRef = useRef<HTMLButtonElement>(null);
  const sheetWasOpenRef = useRef(false);
  const pagesRef = useRef<DrillPage[]>([]);
  const saveQueuesRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const frozenTabRef = useRef<string | null>(null);
  const pickEpochRef = useRef(0);
  // Captured on load and reused on every save/create/delete - a project
  // switch in another tab must not redirect this authoring session's writes
  // (see resolveMutationRoot server-side).
  const pinnedRootRef = useRef<string | null>(null);

  useEffect(() => {
    const wasOpen = sheetWasOpenRef.current;
    sheetWasOpenRef.current = mobileSheetOpen;
    if (!isNarrowAuthoring || wasOpen === mobileSheetOpen) return;
    const target = mobileSheetOpen ? planCloseRef.current : planFabRef.current;
    requestAnimationFrame(() => target?.focus());
  }, [isNarrowAuthoring, mobileSheetOpen]);

  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  useEffect(() => {
    pageIdRef.current = pageId;
    if (pageId) localStorage.setItem("drill.authoring.page", pageId);
  }, [pageId]);

  const loadPages = () => {
    return apiGet("/api/pages").then((r) => {
      pinnedRootRef.current = r.root ?? pinnedRootRef.current;
      setPages(r.pages);
      const previous = pageIdRef.current;
      const next = previous && r.pages.some((candidate: DrillPage) => candidate.id === previous)
        ? previous
        : (r.pages.length > 0 ? r.pages[0].id : null);
      pageIdRef.current = next;
      setPageId(next);
      // Keep the parent route in sync from this async completion, never from
      // inside a state updater (which React may execute during render).
      if (next && next !== previous) onPageChange(next);
    }).catch((e) => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch; loadPages uses functional setState so it never reads stale pageId
  useEffect(() => { void loadPages(); }, []);

  const page = pages.find((p) => p.id === pageId) ?? null;
  const pageStateIds = page?.states.map((state) => state.id) ?? [];
  const pageStateKey = pageStateIds.join("\u0000");
  const activeStateSel = stateSel === "default" || pageStateIds.includes(stateSel)
    ? stateSel
    : "default";
  const activeState = page?.states.find((state) => state.id === activeStateSel) ?? null;
  const activeStateImageSource = activeState?.screenshotPath ? `/api/states/${page?.id}/${activeStateSel}/screenshot` : null;
  const activeStateImage = useFetchedImage(
    activeStateImageSource,
    activeStateImageSource ? `/api/states/${page?.id}/${activeStateSel}/screenshot-status` : null
  );

  // A named state belongs to one page. Moving to a page that does not define
  // it must never leave Authoring apparently empty or create an invalid step.
  useEffect(() => {
    if (stateSel !== activeStateSel) setStateSel(activeStateSel);
  }, [activeStateSel, page?.id, pageStateKey, stateSel]);

  // Open/reuse the authoring tab whenever the page or viewport changes.
  useEffect(() => {
    if (!pageId) return;
    const previousFrozen = frozenTabRef.current;
    pickEpochRef.current += 1;
    frozenTabRef.current = null;
    setPickMode(false);
    setPreparingPick(false);
    if (previousFrozen) {
      apiPost("/api/authoring/freeze", { tabId: previousFrozen, frozen: false }).catch(() => {});
    }
    setTab(null);
    setTabError(null);
    setPreviewReady(false);
    setPreviewSize(null);
    setTargetViewport(null);
    let cancelled = false;
    apiPost("/api/authoring/tab", { pageId, viewport: viewportId, root: pinnedRootRef.current ?? undefined })
      .then((r) => {
        if (cancelled) return;
        setTab({
          tabId: r.tabId,
          canvasUrl: r.canvasUrl,
          canvasTailnetUrl: r.canvasTailnetUrl ?? null,
          screenshotUrl: r.screenshotUrl,
          url: r.url,
          pageUrl: r.url,
          viewport: r.viewport
        });
      })
      .catch((e) => {
        if (!cancelled) setTabError(e.message);
      });
    return () => {
      cancelled = true;
      const frozen = frozenTabRef.current;
      pickEpochRef.current += 1;
      frozenTabRef.current = null;
      if (frozen) apiPost("/api/authoring/freeze", { tabId: frozen, frozen: false }).catch(() => {});
    };
  }, [pageId, viewportId, tabLoadRevision]);

  // Keep the embedded browser controls honest while the author navigates
  // inside the live preview, and surface console failures without DevTools.
  useEffect(() => {
    if (!tab) {
      setLiveUrl(null);
      setConsoleEntries([]);
      return;
    }
    let stopped = false;
    const poll = async () => {
      try {
        const [info, consoleResult] = await Promise.all([
          apiGet(`/api/authoring/tab-info?tabId=${encodeURIComponent(tab.tabId)}`),
          apiGet(`/api/authoring/console?tabId=${encodeURIComponent(tab.tabId)}&limit=150`)
        ]);
        if (stopped) return;
        const nextUrl = info.tab?.url ?? tab.url;
        setLiveUrl(nextUrl);
        setTab((current) => current?.tabId === tab.tabId ? { ...current, url: nextUrl } : current);
        if (!urlFocused.current) setUrlDraft(nextUrl);
        setConsoleEntries(consoleResult.entries ?? []);
      } catch {
        // A transient Browser fitting hiccup should not erase the last useful
        // URL or console buffer.
      }
    };
    void poll();
    const timer = setInterval(poll, 2_500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [tab?.tabId]);

  useEffect(() => {
    if (consoleOpen) consoleEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [consoleOpen, consoleEntries.length]);

  const refreshPreviewAfterBrowserAction = () => {
    setPreviewReady(false);
    setPreviewRevision(Date.now());
    setAreaResolutionRevision((revision) => revision + 1);
  };

  const doNav = async (destination: string) => {
    if (!tab) return;
    const draft = destination.trim();
    if (!draft) return;
    try {
      const target = new URL(draft, liveUrl ?? tab.url).toString();
      const response = await apiPost("/api/authoring/nav", { tabId: tab.tabId, url: target });
      const nextUrl = response.url ?? target;
      setLiveUrl(nextUrl);
      setTab((current) => current?.tabId === tab.tabId ? { ...current, url: nextUrl } : current);
      if (!urlFocused.current) setUrlDraft(nextUrl);
      setAuthError(null);
      refreshPreviewAfterBrowserAction();
    } catch (err: any) {
      setAuthError(`Navigation failed: ${err.message}`);
    }
  };

  const doTabAction = async (action: "back" | "forward" | "reload") => {
    if (!tab) return;
    try {
      const response = await apiPost("/api/authoring/tab-action", { tabId: tab.tabId, action });
      const nextUrl = response.url ?? liveUrl ?? tab.url;
      setLiveUrl(nextUrl);
      setTab((current) => current?.tabId === tab.tabId ? { ...current, url: nextUrl } : current);
      if (!urlFocused.current) setUrlDraft(nextUrl);
      setAuthError(null);
      refreshPreviewAfterBrowserAction();
    } catch (err: any) {
      setAuthError(`Could not ${action}: ${err.message}`);
    }
  };

  // Auth-gated apps redirect the pooled tab to /login; after signing in the
  // author was stranded there with no way back but hand-typing the path.
  // tab.pageUrl is the server-computed page target (page.path against the
  // Book's app URL) - one click re-navigates, and the button lights up
  // whenever the live browser has drifted off the authored page's path.
  const strandedOffPage = (() => {
    if (!tab?.pageUrl) return false;
    const current = liveUrl ?? tab.url;
    try {
      const here = new URL(current);
      const target = new URL(tab.pageUrl);
      // Compare origin + path + hash, trailing slash normalised away so
      // "/login" vs "/login/" is NOT drift. Hash IS compared so a hash-routed
      // SPA's "#/login" redirect counts as drift; search is NOT, so benign
      // query params the app appends to the same page ("?tab=overview") don't
      // falsely light the button. A path-level "/login" redirect - the common
      // case - is caught by the path either way.
      const norm = (u: URL) =>
        u.origin + u.pathname.replace(/\/+$/, "") + u.hash;
      return norm(here) !== norm(target);
    } catch {
      return false;
    }
  })();

  // The selected state's reach steps as one readable sentence, defensively:
  // page YAML is user/planner-authored, so reachPath may be a non-array or hold
  // non-object entries. Anything that isn't a usable {description} is dropped;
  // an empty result renders nothing (no dangling "Reach it:" label, no crash).
  const reachGuidance = (() => {
    const raw = activeState?.reachPath;
    if (!Array.isArray(raw)) return "";
    return raw
      .map((step) => (step && typeof step === "object" ? step.description : typeof step === "string" ? step : ""))
      .map((text) => (typeof text === "string" ? text.trim() : ""))
      .filter(Boolean)
      .join(", then ");
  })();

  const restartTab = async () => {
    if (!pageId) return;
    cancelHighlight();
    setTab(null);
    setTabError(null);
    setAuthError(null);
    setConsoleEntries([]);
    try {
      const response = await apiPost("/api/authoring/restart", {
        pageId,
        viewport: viewportId,
        root: pinnedRootRef.current ?? undefined
      });
      setTab({
        tabId: response.tabId,
        canvasUrl: response.canvasUrl,
        canvasTailnetUrl: response.canvasTailnetUrl ?? null,
        screenshotUrl: response.screenshotUrl ?? `/api/authoring/screenshot/${encodeURIComponent(response.tabId)}`,
        url: response.url,
        pageUrl: response.url,
        viewport: response.viewport
      });
      refreshPreviewAfterBrowserAction();
    } catch (err: any) {
      setTabError(err.message);
      setAuthError(`Could not restart the app preview: ${err.message}`);
    }
  };

  // The preview is a viewport-exact screenshot rather than the Browser
  // fitting's iframe UI. The iframe includes its own toolbar and resizes the
  // inner page, which made visual click coordinates wrong in real projects.
  useEffect(() => {
    if (!tab || pickMode) return;
    const timer = setInterval(() => setPreviewRevision((n) => n + 1), 2_000);
    return () => clearInterval(timer);
  }, [tab, pickMode]);

  const mutatePage = (
    mutation: (current: DrillPage) => Partial<DrillPage>,
    targetPageId: string | null = pageId
  ): Promise<DrillPage | null> => {
    if (!targetPageId) return Promise.resolve(null);
    const previous = saveQueuesRef.current.get(targetPageId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = pagesRef.current.find((candidate) => candidate.id === targetPageId);
      if (!current) throw new Error(`page ${targetPageId} is no longer available`);
      const patch = mutation(current);
      setSaveStatus("saving");
      const response = await fetch(`/api/pages/${encodeURIComponent(targetPageId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...patch, root: pinnedRootRef.current ?? undefined })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.page) throw new Error(body.error || `save failed (${response.status})`);
      pagesRef.current = pagesRef.current.map((candidate) =>
        candidate.id === targetPageId ? body.page : candidate
      );
      setPages(pagesRef.current);
      setSaveStatus("saved");
      setPickError((currentError) =>
        currentError?.startsWith("Could not save the Drill Book:") ? null : currentError
      );
      return body.page as DrillPage;
    }).catch((err) => {
      setSaveStatus("error");
      setPickError(`Could not save the Drill Book: ${err.message}`);
      throw err;
    });
    // Keep a rejection-safe tail in the per-page queue while returning the
    // original operation so callers can still handle its failure.
    saveQueuesRef.current.set(targetPageId, operation.catch(() => null));
    return operation;
  };

  const createPage = async () => {
    const id = newPageId.trim();
    if (!id) return;
    await fetch(`/api/pages/${encodeURIComponent(id)}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: id, path: "/" + id, root: pinnedRootRef.current ?? undefined })
    });
    setNewPageId("");
    await loadPages();
    setPageId(id);
    onPageChange(id);
  };

  const onOverlayClick: React.MouseEventHandler<HTMLDivElement> = async (e) => {
    if (!pickMode || !tab || !page) return;
    const targetTab = tab.tabId;
    const epoch = pickEpochRef.current;
    const box = overlayRef.current!.getBoundingClientRect();
    // The screenshot is always the physical device size, while a mobile page
    // without a viewport meta tag can intentionally expose a wider CSS layout
    // viewport (for example 980px). elementFromPoint consumes those layout
    // coordinates, so keep them separate from the image's natural dimensions.
    const targetSize = targetViewport ?? previewSize ?? tab.viewport;
    const x = Math.max(0, Math.min(targetSize.width - 1, ((e.clientX - box.left) / box.width) * targetSize.width));
    const y = Math.max(0, Math.min(targetSize.height - 1, ((e.clientY - box.top) / box.height) * targetSize.height));
    setPickMode(false);
    setPickError(null);
    try {
      const r = await apiPost("/api/authoring/pick", { tabId: targetTab, x, y });
      if (epoch !== pickEpochRef.current) return;
      if (!r.anchors) { setPickError("Nothing was found there. Refresh the preview and try the center of the element."); return; }
      await mutatePage((current) => {
        const n = Math.max(0, ...current.areas.map((candidate) => candidate.n)) + 1;
        const area: Area = {
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
        return { areas: [...current.areas, area] };
      }, page.id);
      // E2: reopen the sheet with the new area ready for steps.
      setMobileSheetOpen(true);
    } catch (err: any) {
      setPickError(err.message);
    } finally {
      if (frozenTabRef.current === targetTab) frozenTabRef.current = null;
      apiPost("/api/authoring/freeze", { tabId: targetTab, frozen: false }).catch(() => {});
    }
  };

  // E2: Highlight closes the sheet (full-screen canvas for picking with
  // touch), enters pick mode; the sheet reopens once a pick lands (above) or
  // the user cancels (toggling pick mode back off manually).
  const startHighlight = async () => {
    // React state updates after the current event turn. The ref is updated
    // synchronously below, so it also rejects a real double-click delivered
    // before `preparingPick` has rendered and prevents two freeze/preload
    // sessions from racing against one another.
    if (!tab || preparingPick || pickMode || frozenTabRef.current) return;
    const targetTab = tab;
    const epoch = pickEpochRef.current + 1;
    pickEpochRef.current = epoch;
    frozenTabRef.current = targetTab.tabId;
    setPreparingPick(true);
    setPickError(null);
    try {
      const frozen = await apiPost("/api/authoring/freeze", { tabId: targetTab.tabId, frozen: true });
      if (epoch !== pickEpochRef.current) {
        await apiPost("/api/authoring/freeze", { tabId: targetTab.tabId, frozen: false }).catch(() => {});
        return;
      }
      if (frozen.viewport?.width && frozen.viewport?.height) setTargetViewport(frozen.viewport);
      const revision = Date.now();
      const frozenPreview = new Image();
      await new Promise<void>((resolve, reject) => {
        frozenPreview.onload = () => resolve();
        frozenPreview.onerror = () => reject(new Error("the frozen viewport preview did not load"));
        frozenPreview.src = `${targetTab.screenshotUrl}?t=${revision}`;
      });
      if (epoch !== pickEpochRef.current) {
        await apiPost("/api/authoring/freeze", { tabId: targetTab.tabId, frozen: false }).catch(() => {});
        return;
      }
      if (frozenPreview.naturalWidth && frozenPreview.naturalHeight) {
        setPreviewSize({ width: frozenPreview.naturalWidth, height: frozenPreview.naturalHeight });
      }
      setPreviewReady(false);
      setPreviewRevision(revision);
    } catch (err: any) {
      if (frozenTabRef.current === targetTab.tabId) frozenTabRef.current = null;
      apiPost("/api/authoring/freeze", { tabId: targetTab.tabId, frozen: false }).catch(() => {});
      if (epoch === pickEpochRef.current) {
        setPickError(`Could not freeze the page for targeting: ${err.message}`);
      }
      return;
    } finally {
      if (epoch === pickEpochRef.current) setPreparingPick(false);
    }
    if (epoch !== pickEpochRef.current) return;
    setMobileSheetOpen(false);
    setPickMode(true);
  };

  const cancelHighlight = () => {
    pickEpochRef.current += 1;
    setPickMode(false);
    setPreparingPick(false);
    const frozen = frozenTabRef.current;
    frozenTabRef.current = null;
    if (frozen) apiPost("/api/authoring/freeze", { tabId: frozen, frozen: false }).catch(() => {});
  };
  useEffect(() => {
    if (!pickMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelHighlight();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [pickMode, tab]);

  useEffect(() => {
    if (!isNarrowAuthoring || !mobileSheetOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMobileSheetOpen(false);
    };
    addEventListener("keydown", closeOnEscape);
    return () => removeEventListener("keydown", closeOnEscape);
  }, [isNarrowAuthoring, mobileSheetOpen]);

  // Resolve every badge in one Browser eval, immediately and then at a light
  // cadence while visible. This keeps responsive/SPAs current without the old
  // area-count × 2-second request storm. A resolved null is authoritative:
  // hide the badge rather than replaying a stale stored rectangle.
  const [livePct, setLivePct] = useState<Record<string, Pct | null>>({});
  const areaAnchorKey = JSON.stringify(page?.areas.map((area) => [area.id, area.anchors]) ?? []);
  useEffect(() => {
    if (!tab || !page) { setLivePct({}); return; }
    let cancelled = false;
    let resolving = false;
    const resolveAreas = async () => {
      if (resolving || document.visibilityState === "hidden" || pickMode) return;
      resolving = true;
      try {
        const r = await apiPost("/api/authoring/resolve-many", {
          tabId: tab.tabId,
          items: page.areas.map((area) => ({ id: area.id, anchors: area.anchors }))
        });
        if (!cancelled) setLivePct(r.resolved ?? {});
      } catch {
        // Keep the last known live positions through a transient Browser
        // outage. A successful response containing null still hides a target
        // that genuinely stopped resolving.
      } finally {
        resolving = false;
      }
    };
    void resolveAreas();
    const interval = setInterval(resolveAreas, 5_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void resolveAreas();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `areaAnchorKey` changes for target edits but unrelated step saves do
    // not reset the poll. The iframe onLoad revision refreshes immediately
    // after a real browser navigation.
  }, [tab?.tabId, page?.id, areaAnchorKey, areaResolutionRevision, pickMode]);

  const addStep = (area: number) => {
    const step: Step = { id: newStepId(), area, mode: "vision", enabled: true, viewports: [viewportId], state: activeStateSel, description: "", tags: [] };
    void mutatePage((current) => ({ steps: [...current.steps, step] }));
  };
  const patchStep = (stepId: string, patch: Partial<Step> | ((step: Step) => Partial<Step>)) => {
    void mutatePage((current) => ({
      steps: current.steps.map((step) =>
        step.id === stepId
          ? { ...step, ...(typeof patch === "function" ? patch(step) : patch) }
          : step
      )
    }));
  };
  const removeStep = (stepId: string) => {
    void mutatePage((current) => ({ steps: current.steps.filter((step) => step.id !== stepId) }));
  };
  const renameArea = (areaId: string, label: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    void mutatePage((current) => ({
      areas: current.areas.map((area) => area.id === areaId ? { ...area, label: nextLabel } : area)
    }));
  };
  const removeArea = (area: Area) => {
    const crossPageRefs = pagesRef.current.flatMap((candidate) =>
      candidate.id === pageId
        ? []
        : candidate.steps.filter((step) => step.ref === area.id).map(() => candidate.title)
    );
    if (crossPageRefs.length > 0) {
      setPickError(`Area ${area.n} is referenced from ${Array.from(new Set(crossPageRefs)).join(", ")}. Remove those links before deleting it.`);
      return;
    }
    const scopedChecks = pagesRef.current.find((candidate) => candidate.id === pageId)?.steps.filter((step) => step.area === area.n).length ?? 0;
    if (!confirm(`Delete “${area.label}”${scopedChecks ? ` and its ${scopedChecks} check${scopedChecks === 1 ? "" : "s"}` : ""}?`)) return;
    void mutatePage((current) => ({
      areas: current.areas.filter((candidate) => candidate.id !== area.id),
      steps: current.steps.filter((step) => step.area !== area.n)
    }));
  };

  if (error) return <div className="dr-placeholder">{error} <button className="btn small" onClick={() => setError(null)}>dismiss</button></div>;
  if (pages.length === 0) {
    return (
      <div className="dr-placeholder">
        No pages yet.
        <div className="dr-rowwrap" style={{ justifyContent: "center", marginTop: 10 }}>
          <input aria-label="New page id" value={newPageId} onChange={(e) => setNewPageId(e.target.value)} placeholder="page id, e.g. chat"
            style={{ fontSize: 12, padding: "6px 8px", border: "1px solid var(--rule)" }} />
          <button className="btn small" onClick={createPage}><Plus size={12} /> Add page</button>
        </div>
      </div>
    );
  }
  if (!page) return <div className="dr-placeholder">Loading…</div>;

  const states: string[] = ["default", ...page.states.map((s) => s.id).filter((s) => s !== "default")];
  const pageSteps = page.steps.filter((s) => s.area === 0 && s.state === activeStateSel);
  const areaSteps = (n: number) => page.steps.filter((s) => s.area === n && s.state === activeStateSel);

  const consoleErrors = consoleEntries.filter((e) => e.level === "error").length;

  return (
    <div className="dr-au">
      <SectionIntro title="Authoring">
        Review one page at a time. Its checks and highlighted areas are on the left; the live, viewport-accurate page preview is on the right. Highlighting adds a stable target for focused checks.
      </SectionIntro>

      {authError && (
        <div className="dr-banner" role="alert">
          <span style={{ flex: "1 1 240px" }}>{authError}</span>
          <button className="btn small" onClick={() => setAuthError(null)}>Dismiss</button>
        </div>
      )}
      <div className="dr-au-canvas">
        <div className="dr-canvas-head">
          <div>
            <div className="dr-lbl">Interactive browser</div>
            {tab?.url && <div className="mono dr-preview-url">{tab.url}</div>}
          </div>
          <button className="btn small" aria-label="Refresh browser preview" onClick={() => {
            setPreviewRevision((n) => n + 1);
            setAreaResolutionRevision((n) => n + 1);
          }}>Refresh preview</button>
        </div>
        <div className="dr-author-controls">
          <select aria-label="Authoring page" value={pageId ?? ""} onChange={(e) => {
            cancelHighlight();
            setPageId(e.target.value);
            onPageChange(e.target.value);
          }} style={{ fontSize: 12, padding: "5px 8px", border: "1px solid var(--rule)" }}>
            {pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </select>
          <div className="dr-rowwrap" role="group" aria-label="Authoring viewport">
            {VIEWPORTS.map((v) => {
              const Icon = v.icon;
              return (
                <button key={v.id} className={"chip click" + (viewportId === v.id ? " ink active" : " sage")} onClick={() => {
                  cancelHighlight();
                  setViewportId(v.id);
                }} aria-pressed={viewportId === v.id}>
                  <Icon size={11} /> {v.label}
                </button>
              );
            })}
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
            <button className={"btn small" + (strandedOffPage ? " primary" : "")}
              title={`Navigate the live browser to this page's path (${tab.pageUrl})`}
              onClick={() => doNav(tab.pageUrl)}>
              <LocateFixed size={11} /> Go to page
            </button>
            <button className="btn small" title="Close this preview tab and reopen the page fresh (resets app state)" onClick={restartTab}>
              <RefreshCcw size={11} /> Restart
            </button>
            <a className="btn small" href={fullBrowserViewUrl(resolveEmbedUrl(tab.canvasUrl, tab.canvasTailnetUrl) || tab.canvasUrl)} target="_blank" rel="noreferrer"
              title="Open this same live tab full-size in the Browser fitting">
              <ExternalLink size={11} /> Full view
            </a>
            <button className={"btn small" + (consoleOpen ? " primary" : "")} onClick={() => setConsoleOpen((v) => !v)}
              title="The page's browser console - errors here are findings material">
              <Terminal size={11} /> Console{consoleErrors > 0 ? ` (${consoleErrors})` : ""}
            </button>
          </div>
        )}

        {tab ? (
          <div className={"dr-cv" + (pickMode ? " is-picking" : "")} style={{ aspectRatio: `${previewSize?.width ?? tab.viewport.width} / ${previewSize?.height ?? tab.viewport.height}` }}>
            {!previewReady && <div className="dr-preview-loading">Loading viewport preview…</div>}
            <img
              key={`${tab.tabId}:${previewRevision}`}
              alt={`${page.title} at ${viewportId} viewport`}
              src={`${tab.screenshotUrl}?t=${previewRevision}`}
              className="dr-cv-frame"
              onLoad={(event) => {
                setPreviewReady(true);
                const image = event.currentTarget;
                if (image.naturalWidth && image.naturalHeight) {
                  setPreviewSize({ width: image.naturalWidth, height: image.naturalHeight });
                }
              }}
              onError={() => setPreviewReady(false)}
            />
            {!pickMode && !preparingPick && (resolveEmbedUrl(tab.canvasUrl, tab.canvasTailnetUrl) ? (
              <iframe
                className="dr-cv-live"
                src={resolveEmbedUrl(tab.canvasUrl, tab.canvasTailnetUrl)}
                title={`${page.title} interactive browser`}
                onLoad={() => setAreaResolutionRevision((n) => n + 1)}
              />
            ) : (
              <div className="dr-cv-unreachable" role="note">
                Live interaction is unavailable from this device: the Browser fitting's port is not
                published to the tailnet. Run scripts/tailnet-serve-views.mjs on the Garrison machine,
                then reload. The screenshot preview above still tracks the page.
              </div>
            ))}
            <div
              ref={overlayRef}
              className="dr-cv-overlay"
              style={{
                cursor: pickMode && previewReady ? "crosshair" : "default",
                pointerEvents: pickMode && previewReady ? "auto" : "none"
              }}
              onClick={onOverlayClick}
            />
            {pickMode && previewReady && (
              <div className="dr-pick-instruction" aria-live="polite">
                Click the element you want Drill to track · Esc or Cancel to stop
              </div>
            )}
            {pickMode && !previewReady && (
              <div className="dr-pick-instruction" aria-live="polite">
                Preparing the frozen viewport…
              </div>
            )}
            {pickMode && (
              <button className="dr-pick-cancel" onClick={(event) => {
                event.stopPropagation();
                cancelHighlight();
              }}>Cancel</button>
            )}
            {page.areas.map((a) => {
              const pct = Object.prototype.hasOwnProperty.call(livePct, a.id) ? livePct[a.id] : a.pct;
              if (!pct) return null;
              return (
                <div key={a.id} className="dr-abox" style={{ left: `${pct.leftPct}%`, top: `${pct.topPct}%`, width: `${pct.widthPct}%`, height: `${pct.heightPct}%` }}>
                  <span className="dr-abadge">{a.n}</span>
                </div>
              );
            })}
          </div>
        ) : tabError ? (
          <div className="dr-placeholder dr-tab-error" role="alert">
            <span>Could not open the browser tab: {tabError}</span>
            <button className="btn small" onClick={() => setTabLoadRevision((n) => n + 1)}>Retry opening tab</button>
          </div>
        ) : (
          <div className="dr-placeholder">Opening tab…</div>
        )}

        <div className="dr-canvas-actions">
          <button className={"btn small" + (pickMode ? " primary" : "")} disabled={preparingPick} onClick={() => (pickMode ? cancelHighlight() : void startHighlight())}>
            <Crosshair size={11} /> {preparingPick ? "Preparing target…" : pickMode ? "Cancel highlighting" : "Highlight an area"}
          </button>
          <span className="dr-help-inline">Interact with the browser normally. Highlight swaps to an exact frozen viewport so the picked element cannot move.</span>
        </div>
        {consoleOpen && (
          <div className="dr-console" aria-label="Browser console">
            {consoleEntries.length === 0 && <div className="dr-con-empty">No console output from the page yet.</div>}
            {consoleEntries.slice(-80).map((entry, index) => (
              <div key={`${entry.ts}-${index}`} className={"dr-con-row" + (entry.level === "error" ? " err" : entry.level === "warning" ? " warn" : "")}>
                <span className="dr-con-lvl">{entry.level}</span>
                <span className="dr-con-text">{entry.text}</span>
              </div>
            ))}
            <div ref={consoleEndRef} />
          </div>
        )}
        {pickError && <div className="dr-inline-error" role="alert">{pickError}</div>}

        {/* E1: FAB - shown only at phone width (CSS) AND while the sheet is
            closed, to open it back up; toggles the plan sheet. */}
        {!pickMode && !mobileSheetOpen && (
          <button ref={planFabRef} className="dr-fab" onClick={() => setMobileSheetOpen(true)} aria-label="Open authoring plan">
            <NotebookPen size={18} />
          </button>
        )}
      </div>

      <aside
        className={"dr-au-plan" + (mobileSheetOpen ? " dr-sheet-open" : " dr-sheet-closed")}
        role={isNarrowAuthoring && mobileSheetOpen ? "dialog" : undefined}
        aria-modal={isNarrowAuthoring && mobileSheetOpen ? "true" : undefined}
        aria-label="Authoring checks"
        aria-hidden={isNarrowAuthoring && !mobileSheetOpen ? true : undefined}
        {...((isNarrowAuthoring && !mobileSheetOpen ? { inert: "" } : {}) as any)}
      >
        <div className="dr-rowwrap" style={{ marginBottom: 10 }}>
          <b>Drill: {page.title}</b>
          <span className={`dr-save-status ${saveStatus}`} data-testid="author-save-status" aria-live="polite">
            {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : saveStatus === "error" ? "Save failed" : ""}
          </span>
          <button ref={planCloseRef} className="dr-sheet-close" onClick={() => setMobileSheetOpen(false)} title="Close plan sheet" aria-label="Close plan sheet"><X size={16} /></button>
        </div>

        {/* Phone-only (CSS): a tall phone-aspect canvas pushes the canvas
            column's Highlight button under this very sheet, so the sheet
            carries its own - tapping it closes the sheet and enters pick
            mode on the full-screen canvas (E2). */}
        <button className="btn small dr-sheet-highlight" disabled={preparingPick} onClick={() => void startHighlight()}>
          <Crosshair size={11} /> {preparingPick ? "Preparing target…" : "Highlight an area"}
        </button>

        {activeStateSel !== "default" && (
          <div className="dr-state-reference">
            <div className="dr-lbl">State reference</div>
            {activeStateImage ? (
              <img
                alt={`${activeStateSel} reference`}
                src={activeStateImage}
              />
            ) : activeStateImage === undefined ? (
              <div className="dr-state-reference-missing" role="status">Loading state reference…</div>
            ) : (
              <div className="dr-state-reference-missing" role="status">
                {activeState?.screenshotPath ? "Recorded state reference unavailable." : "No state reference captured yet."}
              </div>
            )}
            {reachGuidance && (
              <div className="dr-state-reach">
                <b>Reach it in the live browser:</b> {reachGuidance}
              </div>
            )}
          </div>
        )}

        {states.length > 1 && (
          <>
            <div className="dr-lbl">State</div>
            <div className="dr-rowwrap" style={{ marginBottom: 12 }}>
              {states.map((s) => (
                <button key={s} className={"chip click brass dr-label-chip" + (activeStateSel === s ? " active" : "")} onClick={() => setStateSel(s)} aria-pressed={activeStateSel === s}>{s}</button>
              ))}
            </div>
          </>
        )}

        <div className="dr-lbl">Page steps</div>
        {pageSteps.map((s) => (
          <StepRow key={s.id} step={s}
            onToggleEnabled={() => patchStep(s.id, (current) => ({ enabled: !current.enabled }))}
            onToggleMode={() => patchStep(s.id, (current) => ({ mode: current.mode === "vision" ? "e2e" : "vision" }))}
            onToggleJudgment={() => patchStep(s.id, (current) => ({ judgment: !current.judgment }))}
            onRemove={() => removeStep(s.id)}
            onEditDescription={(text) => patchStep(s.id, { description: text })}
            onJumpRef={(ref) => {
              const nextPage = ref.split("#")[0];
              setPageId(nextPage);
              onPageChange(nextPage);
            }}
          />
        ))}
        <button className="btn small" onClick={() => addStep(0)}><Plus size={11} /> Page step</button>

        {page.areas.map((a) => (
          <div key={a.id} style={{ marginTop: 14 }}>
            <div className="dr-rowwrap" style={{ marginBottom: 4 }}>
              <span className="dr-area-n">{a.n}</span>
              <input
                className="dr-area-label"
                aria-label={`Area ${a.n} name`}
                defaultValue={a.label}
                onBlur={(event) => {
                  if (event.currentTarget.value.trim() !== a.label) renameArea(a.id, event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span className="mono" style={{ fontSize: 10, color: "var(--mute-2)" }}>{a.id}</span>
              <button className="dr-xbtn dr-area-delete" aria-label={`Delete area ${a.n}`} onClick={() => removeArea(a)}><X size={14} /></button>
            </div>
            {areaSteps(a.n).map((s) => (
              <StepRow key={s.id} step={s}
                onToggleEnabled={() => patchStep(s.id, (current) => ({ enabled: !current.enabled }))}
                onToggleMode={() => patchStep(s.id, (current) => ({ mode: current.mode === "vision" ? "e2e" : "vision" }))}
                onToggleJudgment={() => patchStep(s.id, (current) => ({ judgment: !current.judgment }))}
                onRemove={() => removeStep(s.id)}
                onEditDescription={(text) => patchStep(s.id, { description: text })}
                onJumpRef={(ref) => {
                  const nextPage = ref.split("#")[0];
                  setPageId(nextPage);
                  onPageChange(nextPage);
                }}
              />
            ))}
            <button className="btn small" onClick={() => addStep(a.n)}><Plus size={11} /> Step</button>
          </div>
        ))}
      </aside>
    </div>
  );
}

// ─── Run & results (D1-D10, R10) ─────────────────────────────────────────

interface RunPageEntry {
  pageId: string; stepId: string; viewportId: string; automationRunId: string | null; status: string; error?: string;
  infra?: boolean;
  stateReferenceSeeded?: string;
  stateReferenceRejected?: {
    state: string;
    reason: string;
    warnings: Array<{ code: string; text: string }>;
  };
  terminal?: {
    kind: "passed" | "product-failure" | "infra-failure" | "blocked" | "incomplete";
    source: string;
    code: string;
    component?: string;
    message?: string;
    tier?: string | null;
    evidencePath?: string;
    durationMs?: number;
    reasoning?: string;
  };
  result: { stepId: string; status: string; tier?: string | null; error?: string; evidencePath?: string; durationMs?: number; result?: { passed?: boolean; reasoning?: string } } | null;
}
interface Finding {
  id: string;
  kind: string;
  pageId: string;
  stepId: string | null;
  viewportId?: string | null;
  text: string;
  status: "proposed" | "confirmed" | "dismissed";
  at: string;
  card?: { id: string; url: string | null; at: string } | null;
  evidence?: { screenshot: string | null; trace: string | null; videoMs: number | null } | null;
}

// Drill Evidence v0.1 — run-level pointer (relative names inside the run's
// evidence dir) + the per-check index rows served by /evidence-index.
interface RunEvidence { video: string | null; steps: string | null; index?: string | null }
interface EvidenceStepRow {
  item: string; kind: string; pageId?: string; stepId?: string; viewportId?: string;
  status?: string; startMs?: number; endMs?: number; automationRunId?: string | null;
  trace?: string | null; screenshot?: string | null; failureScreenshot?: string | null;
  path?: string; bytes?: number | null; sha256?: string | null; pruned?: boolean;
}
// Drill Evidence V2 - the reel/spotter manifests the Debrief consumes. A run's
// evidence-index carries summary rows; the frame-level detail lives in these
// two sidecars, joined to steps.json by `chunk` (the sanitized check key).
interface ReelHighlight { x: number; y: number; w: number; h: number }
interface ReelFrame {
  name: string;
  tMs: number;
  trigger: string;
  chunk: string | null;
  keep?: boolean;
  importance?: "normal" | "high";
  annotation?: string;
  highlight?: ReelHighlight | null;
  uncurated?: boolean;
}
interface ReelManifest {
  version?: number;
  routedVia?: string | null;
  counts?: { frames?: number; candidates?: number; curated?: number; reel?: number; uncurated?: number };
  frames: ReelFrame[];
}
interface SpotterFrame {
  name: string;
  tMs: number;
  trigger: string;
  chunk: string | null;
  hash?: string;
  bytes?: number;
  collapsed?: boolean;
}
interface SpotterManifest {
  counts?: { frames?: number; kept?: number; collapsed?: number; dropped?: number };
  frames: SpotterFrame[];
  collapsed?: SpotterFrame[];
}
// Rows of steps.json (D1): the per-check offset manifest. Distinct from the
// evidence-index step items - it carries the human-readable `title`.
interface DebriefStep {
  pageId: string;
  stepId: string;
  viewportId: string;
  title?: string;
  startMs?: number;
  endMs?: number;
  status?: string;
  automationRunId?: string | null;
}
type DebriefScope =
  | { kind: "all" }
  | { kind: "page"; pageId: string }
  | { kind: "check"; pageId: string; stepId: string; viewportId: string };

// The check-key sanitizer mirrors lib/evidence.mjs `checkKey`: frames carry
// `chunk` in this exact shape, so scope filtering must build the same key.
function chunkKeyFor(pageId: string, stepId: string, viewportId: string): string {
  const clean = (part: string) => String(part ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return `${clean(pageId)}--${clean(stepId)}--${clean(viewportId)}`;
}

interface InfraError {
  id: string;
  pageId: string | null;
  stepId: string | null;
  text: string;
  at: string;
  code?: string;
  component?: string;
  count?: number;
  occurrences?: Array<{ pageId: string | null; stepId: string | null; viewportId?: string | null }>;
}
interface Observation { id: string; text: string; at: string; convertedToStep: string | null; convertedToFinding: string | null }
interface DrillRun {
  id: string; startedAt: string; endedAt: string | null; contextTag: string; state: string;
  dispatch?: "manual" | "heartbeat" | "immediate";
  dispatchedAt?: string | null;
  dispatchedCard?: { id: string; list?: string | null } | null;
  pages: RunPageEntry[];
  selection?: { pageIds: string[]; viewportIds: string[] };
  plannedChecks?: number;
  executedChecks?: number;
  circuit?: RunCircuit | null;
  sessions?: RunSessionInfo[];
  feedback: Record<string, Array<{ id: string; note: string; at: string }>>;
  overrides: Record<string, { verdict: string; note: string; at: string }>;
  observations: Observation[];
  findings: Finding[];
  infraErrors?: InfraError[];
  evidence?: RunEvidence | null;
}

// Verify-session linkage (S31): the Claude sessions that resolved this run's
// vision checks. Transcript bytes ride only the confined session-stream route.
interface RunSessionInfo {
  id: string;
  firstAt?: string;
  lastAt?: string;
  checks?: number;
  slice?: string;
  events?: number;
  hasTranscript?: boolean;
}

interface DrillRunSummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  contextTag: string;
  state: string;
  dispatch?: "manual" | "heartbeat" | "immediate";
  dispatchedAt?: string | null;
  dispatchedCard?: { id: string; list?: string | null } | null;
  pages: RunPageEntry[];
  selection?: { pageIds: string[]; viewportIds: string[] };
  plannedChecks?: number;
  executedChecks?: number;
  circuit?: RunCircuit | null;
  overrides: Record<string, { verdict: string; note: string; at: string }>;
  findings: Finding[];
  infraErrors?: InfraError[];
}

interface RunCircuit {
  component: string;
  code: string;
  message: string;
  kind: string;
  openedAt: string;
  afterCheck: number;
  skippedChecks: number;
  trigger?: { pageId: string; stepId: string; viewportId: string };
}

function legacyInfrastructureMeta(finding: Pick<Finding, "kind" | "text">) {
  const text = String(finding.text ?? "").trim();
  if (finding.kind === "infra-error") return { component: "drill", code: "legacy-infra" };
  if (finding.kind !== "step-fail") return null;
  if (/^automations unavailable(?:\b|:)/i.test(text) || /^automations fitting not running\b/i.test(text)) {
    return { component: "automations", code: "automations-unavailable" };
  }
  let match = text.match(/^vision (?:HTTP )?([45]\d\d)(?::.*)?$/i);
  if (match) return { component: "vision", code: `vision-http-${match[1]}` };
  match = text.match(/^fixer (?:HTTP )?([45]\d\d)(?::.*)?$/i)
    ?? text.match(/^fixer failed: fixer (?:HTTP )?([45]\d\d)(?::.*)?$/i);
  if (match) return { component: "fixer", code: `fixer-http-${match[1]}` };
  if (/^(?:TypeError:\s*)?fetch failed(?:$|:)/i.test(text)) {
    return { component: "automations", code: "transport-fetch-failed" };
  }
  const unavailable = text.match(/^(browser|vision|fixer|gateway|orchestrator) fitting not running(?:\b|:)/i);
  if (unavailable) return { component: unavailable[1].toLowerCase(), code: `${unavailable[1].toLowerCase()}-unavailable` };
  return null;
}

function groupInfraErrors(items: InfraError[]) {
  const grouped = new Map<string, InfraError>();
  for (const item of items) {
    const component = item.component ?? "drill";
    const code = item.code ?? "dependency-error";
    const text = String(item.text ?? "Infrastructure failure").trim();
    const key = `${component}\u0000${code}\u0000${text}`;
    const occurrences = item.occurrences?.length
      ? item.occurrences
      : [{ pageId: item.pageId, stepId: item.stepId }];
    const count = Math.max(item.count ?? 0, occurrences.length, 1);
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences = [...(existing.occurrences ?? []), ...occurrences];
      existing.count = (existing.count ?? 1) + count;
    } else {
      grouped.set(key, { ...item, component, code, text, count, occurrences: [...occurrences] });
    }
  }
  return [...grouped.values()];
}

function splitRunIssues(run: DrillRun | DrillRunSummary) {
  const legacyInfra = (run.findings ?? []).filter((finding) => legacyInfrastructureMeta(finding));
  const productFindings = (run.findings ?? []).filter((f) => !legacyInfra.includes(f));
  const infraErrors = groupInfraErrors([
    ...(run.infraErrors ?? []),
    ...legacyInfra.map((finding) => {
      const meta = legacyInfrastructureMeta(finding)!;
      return {
        id: finding.id,
        pageId: finding.pageId,
        stepId: finding.stepId,
        text: finding.text,
        at: finding.at,
        count: 1,
        ...meta
      };
    })
  ]);
  return { productFindings, infraErrors };
}

function overrideForEntry(
  overrides: Record<string, { verdict: string; note: string; at: string }> | undefined,
  entry: RunPageEntry
) {
  const recordKey = `${entry.pageId}:${entry.stepId}`;
  return overrides?.[`${recordKey}:${entry.viewportId}`] ?? overrides?.[recordKey];
}

function effectiveStepPassed(
  run: Pick<DrillRun, "overrides"> | Pick<DrillRunSummary, "overrides">,
  entry: RunPageEntry
) {
  const review = overrideForEntry(run.overrides, entry);
  return review ? review.verdict === "passed" : stepPassed(entry);
}

function activeProductFindings(run: DrillRun | DrillRunSummary, findings: Finding[]) {
  return findings.filter((finding) => {
    if (finding.status === "dismissed") return false;
    if (!finding.stepId) return true;
    const matchingEntries = run.pages.filter((entry) =>
      entry.pageId === finding.pageId &&
      entry.stepId === finding.stepId &&
      (!finding.viewportId || entry.viewportId === finding.viewportId)
    );
    // Historical failure findings predate viewport-aware overrides. If every
    // check the finding can refer to is now explicitly/effectively passed,
    // it no longer keeps the run red. The record remains visible for audit.
    return matchingEntries.length === 0 || matchingEntries.some((entry) => !effectiveStepPassed(run, entry));
  });
}

function runVerdict(run: DrillRunSummary) {
  if (!run.endedAt) return "Running";
  const { productFindings, infraErrors } = splitRunIssues(run);
  if (
    run.circuit ||
    infraErrors.length > 0 ||
    run.pages.some((entry) =>
      ["infra-failure", "blocked", "incomplete"].includes(entry.terminal?.kind ?? "") ||
      (!entry.terminal && (entry.status === "error" || (entry.status === "failed" && !entry.result)))
    )
  ) return "Incomplete";
  if (activeProductFindings(run, productFindings).length > 0) return "Findings";
  return "Passed";
}

function tierTone(tier?: string | null) {
  if (tier === "cached") return "sage";
  if (tier === "vision") return "brass";
  if (tier === "recovered") return "brass";
  return "paper";
}

function EvidenceImage({ src, alt, compact = false }: { src: string; alt: string; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="dr-evidence-missing">Evidence image unavailable</div>;
  return (
    <a className={"dr-evidence-link" + (compact ? " compact" : "")} href={src} target="_blank" rel="noreferrer">
      <img className="dr-evidence-image" src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
      <span>Open full evidence</span>
    </a>
  );
}

function evidenceFileUrl(runId: string, name: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/evidence-file/${encodeURIComponent(name)}`;
}

function fmtOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The whole run in one recording (Drill Evidence v0.1, D1) — chapter buttons
// seek the player to each check's steps.json offset.
function RunEvidenceVideo({ runId, video, steps }: { runId: string; video: string; steps: EvidenceStepRow[] }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="dr-sec card">
      <div className="dr-card-heading">
        <div>
          <b>Run video</b>
          <p>The whole run in one recording. Jump to a check with its chapter button.</p>
        </div>
      </div>
      <video
        ref={ref}
        controls
        preload="metadata"
        src={evidenceFileUrl(runId, video)}
        onError={() => setFailed(true)}
        style={{ width: "100%", maxHeight: 380, background: "#000", borderRadius: 6 }}
      />
      {steps.length > 0 && (
        <div className="dr-rowwrap" style={{ marginTop: 8 }}>
          {steps.map((row) => (
            <button
              key={row.item}
              className="btn small"
              title={`${row.pageId}#${row.stepId} at ${row.viewportId}`}
              onClick={() => {
                const v = ref.current;
                if (!v || !Number.isFinite(row.startMs)) return;
                v.currentTime = (row.startMs ?? 0) / 1000;
                void v.play().catch(() => {});
              }}
            >
              {row.stepId} @{fmtOffset(row.startMs ?? 0)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function stepPassed(entry: RunPageEntry): boolean {
  if (entry.terminal) return entry.terminal.kind === "passed";
  // Historical result hydration depends on Automations being reachable. The
  // Drill record's stored terminal status remains authoritative when detail
  // lookup is temporarily unavailable; a lookup outage must not repaint a
  // previously completed check red.
  if (!entry.result) return entry.status === "completed" || entry.status === "passed";
  if (entry.result.status === "failed") return false;
  if (entry.result.result && entry.result.result.passed === false) return false;
  return true;
}

// ─── Debrief (Evidence V2 D7-D10) ────────────────────────────────────────
// The default run-detail surface: a scope rail + findings on the left, an
// autoplaying reel of curated screenshots (or the scoped run video) on the
// right. Reads the reel/spotter sidecars and joins frames to checks by chunk.

interface DebriefFeedbackEvent { type: string; frame?: string; ms?: number; scope?: string }

// Batched operator feedback (D6): flush at 10 queued events, every 15s, and on
// unmount (best effort). The server stamps timestamps; we never block on it.
function useDebriefFeedback(runId: string) {
  const queue = useRef<DebriefFeedbackEvent[]>([]);
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => {
    const flush = () => {
      if (queue.current.length === 0) return;
      const batch = queue.current.splice(0, 100);
      void fetch(`/api/runs/${encodeURIComponent(runId)}/debrief-feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch })
      }).catch(() => { /* best effort - feedback is advisory */ });
    };
    flushRef.current = flush;
    const timer = window.setInterval(flush, 15000);
    return () => { window.clearInterval(timer); flush(); };
  }, [runId]);
  return useCallback((event: DebriefFeedbackEvent) => {
    queue.current.push(event);
    if (queue.current.length >= 10) flushRef.current();
  }, []);
}

// The check keys a scope covers; null means "everything" (All checks), where
// frames with a null/unmatched chunk are still shown.
function scopeCheckKeys(scope: DebriefScope, steps: DebriefStep[]): Set<string> | null {
  if (scope.kind === "all") return null;
  if (scope.kind === "check") return new Set([chunkKeyFor(scope.pageId, scope.stepId, scope.viewportId)]);
  const keys = new Set<string>();
  for (const step of steps) {
    if (step.pageId === scope.pageId) keys.add(chunkKeyFor(step.pageId, step.stepId, step.viewportId));
  }
  return keys;
}

function frameInScope(chunk: string | null, scopeKeys: Set<string> | null): boolean {
  if (!scopeKeys) return true;
  if (!chunk) return false;
  return scopeKeys.has(chunk);
}

// A finding's coordinate collapses to a single check only when it carries both
// a step and a viewport; otherwise it belongs to the whole page.
function findingChunk(finding: Finding): string | null {
  if (finding.stepId && finding.viewportId) return chunkKeyFor(finding.pageId, finding.stepId, finding.viewportId);
  return null;
}

// The normalized frame the carousel renders - merged from the reel row (kept
// frames, annotations) and, in show-all, the raw spotter candidates.
interface DebriefFrame {
  name: string;
  tMs: number;
  trigger: string;
  chunk: string | null;
  keep: boolean;
  importance: "normal" | "high";
  annotation: string;
  highlight: ReelHighlight | null;
  inReel: boolean;
}

// The highlight never occludes: an outline-only rectangle, or - when it covers
// more than 60% of the frame - a small L-bracket at its top-left corner.
function HighlightOverlay({ rect }: { rect: ReelHighlight }) {
  const x = Math.max(0, Math.min(1, rect.x ?? 0));
  const y = Math.max(0, Math.min(1, rect.y ?? 0));
  const w = Math.max(0, Math.min(1, rect.w ?? 0));
  const h = Math.max(0, Math.min(1, rect.h ?? 0));
  if (w * h > 0.6) {
    return (
      <div className="dr-db-bracket" style={{ left: `${x * 100}%`, top: `${y * 100}%` }} aria-hidden="true">
        <span className="dr-db-bracket-h" />
        <span className="dr-db-bracket-v" />
      </div>
    );
  }
  return (
    <div
      className="dr-db-highlight"
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
      aria-hidden="true"
    />
  );
}

const DWELL_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 1000, label: "1s" },
  { ms: 1500, label: "1.5s" },
  { ms: 2500, label: "2.5s" },
  { ms: 4000, label: "4s" },
  { ms: 6000, label: "6s" }
];

interface ReelCarouselProps {
  runId: string;
  frames: DebriefFrame[];
  dwellMs: number;
  setDwellMs: (ms: number) => void;
  showAll: boolean;
  onToggleShowAll: () => void;
  onActiveFrameChange: (frame: DebriefFrame | null) => void;
  enqueue: (event: DebriefFeedbackEvent) => void;
  scopeLabel: string;
  flagged: Set<string>;
  onFlag: (frameName: string) => void;
  reelCount: number;
  candidateCount: number;
  curationPending: boolean;
}
function ReelCarousel({
  runId, frames, dwellMs, setDwellMs, showAll, onToggleShowAll, onActiveFrameChange,
  enqueue, scopeLabel, flagged, onFlag, reelCount, candidateCount, curationPending
}: ReelCarouselProps) {
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true, align: "center", containScroll: false });
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [held, setHeld] = useState(false);

  // Re-init and snap to the start whenever the source list changes (scope
  // change, show-all toggle) so a stale index never points past the new list.
  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.reInit();
    emblaApi.scrollTo(0, true);
    setSelected(0);
  }, [emblaApi, frames]);

  useEffect(() => {
    if (!emblaApi) return;
    const onSel = () => setSelected(emblaApi.selectedScrollSnap());
    emblaApi.on("select", onSel);
    onSel();
    return () => { emblaApi.off("select", onSel); };
  }, [emblaApi]);

  const active = frames[selected] ?? null;
  useEffect(() => { onActiveFrameChange(active); }, [active, onActiveFrameChange]);

  // Autoplay: advance after the active frame's dwell. High-importance frames
  // never sit shorter than 4s; press-and-hold and the pause button freeze it.
  useEffect(() => {
    if (!emblaApi || !playing || held || frames.length <= 1) return;
    const base = active?.importance === "high" ? Math.max(dwellMs, 4000) : dwellMs;
    const timer = window.setTimeout(() => {
      if (emblaApi.canScrollNext()) emblaApi.scrollNext();
      else emblaApi.scrollTo(0);
    }, base);
    return () => window.clearTimeout(timer);
  }, [emblaApi, playing, held, selected, dwellMs, frames, active]);

  // Long-dwell feedback (D6): a single event when a frame stays active past 5s,
  // paused time included; re-armed on every activation so it fires once/visit.
  useEffect(() => {
    if (!active) return;
    const name = active.name;
    const timer = window.setTimeout(() => {
      enqueue({ type: "dwell", frame: name, ms: 5000, scope: scopeLabel });
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [active, enqueue, scopeLabel]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "ArrowLeft") { e.preventDefault(); emblaApi?.scrollPrev(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); emblaApi?.scrollNext(); }
  };

  if (frames.length === 0) {
    return (
      <div className="dr-db-reel">
        <div className="dr-db-empty">
          {showAll
            ? "No captured frames for this scope."
            : curationPending
              ? "Curation is still selecting the reel for this scope."
              : "No reel frames for this scope. Toggle Show all frames to see raw candidates."}
        </div>
        <div className="dr-db-reel-controls">
          <button className={"btn small" + (showAll ? " primary" : "")} onClick={onToggleShowAll} aria-pressed={showAll}>
            <Film size={12} /> {showAll ? "Showing all frames" : "Show all frames"}
          </button>
        </div>
      </div>
    );
  }

  const flaggedActive = active ? flagged.has(active.name) : false;

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className="dr-db-reel" tabIndex={0} onKeyDown={onKeyDown} aria-label="Screenshot reel" role="group">
      <div className="dr-db-carousel" ref={emblaRef}>
        <div className="dr-db-track">
          {frames.map((frame, i) => (
            <div className="dr-db-slide" key={`${frame.name}:${i}`}>
              <div
                className="dr-db-stage"
                onPointerDown={() => setHeld(true)}
                onPointerUp={() => setHeld(false)}
                onPointerLeave={() => setHeld(false)}
                onPointerCancel={() => setHeld(false)}
              >
                <div className="dr-db-frame">
                  <img className="dr-db-frame-img" src={evidenceFileUrl(runId, frame.name)} alt={frame.annotation || frame.trigger || frame.name} draggable={false} />
                  {frame.inReel && frame.highlight && <HighlightOverlay rect={frame.highlight} />}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Annotation strip - always BELOW the image, fixed height so the reel
          does not jump between annotated and bare frames. */}
      <div className={"dr-db-annot" + (active?.importance === "high" ? " high" : "")}>
        <div className="dr-db-annot-meta">
          <span className="dr-db-annot-trigger">{active?.trigger ?? ""}</span>
          <span className="dr-db-annot-time mono">{fmtOffset(active?.tMs ?? 0)}</span>
          {active?.importance === "high" && <span className="chip brass">key moment</span>}
          {active && !active.inReel && <span className="dr-db-annot-nr">not in reel</span>}
        </div>
        <div className="dr-db-annot-text">
          {active?.inReel && active.annotation
            ? active.annotation
            : active && !active.inReel
              ? `Raw candidate - ${active.trigger || "captured frame"}`
              : ""}
        </div>
        <button
          className={"btn small dr-db-flag" + (flaggedActive ? " primary" : "")}
          disabled={!active}
          aria-pressed={flaggedActive}
          onClick={() => active && onFlag(active.name)}
        >
          <Flag size={12} /> {flaggedActive ? "Flagged" : "Flag"}
        </button>
      </div>

      <div className="dr-db-reel-controls">
        <div className="dr-db-transport">
          <button className="dr-db-iconbtn" aria-label="Previous frame" onClick={() => emblaApi?.scrollPrev()}><ArrowLeft size={14} /></button>
          <button className="dr-db-iconbtn" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((p) => !p)}>
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button className="dr-db-iconbtn" aria-label="Next frame" onClick={() => emblaApi?.scrollNext()}><ArrowRight size={14} /></button>
          <span className="dr-db-counter mono">{frames.length === 0 ? "0 / 0" : `${selected + 1} / ${frames.length}`}</span>
        </div>
        <div className="dr-db-reel-right">
          <label className="dr-db-dwell">
            <span>Dwell</span>
            <select value={dwellMs} onChange={(e) => setDwellMs(Number(e.target.value))} aria-label="Frame dwell time">
              {DWELL_OPTIONS.map((opt) => <option key={opt.ms} value={opt.ms}>{opt.label}</option>)}
            </select>
          </label>
          <button className={"btn small" + (showAll ? " primary" : "")} onClick={onToggleShowAll} aria-pressed={showAll}>
            <Film size={12} /> {showAll ? "All frames" : "Show all"}
          </button>
          <span className="dr-db-reel-counts mono" title="reel / candidate frames">{reelCount} / {candidateCount}</span>
        </div>
      </div>
      {curationPending && !showAll && (
        <div className="dr-db-pending">Curation pending - showing raw candidates until the reel is selected.</div>
      )}
    </div>
  );
}

interface DebriefVideoProps {
  runId: string;
  video: string | null;
  pruned: boolean;
  steps: DebriefStep[];
  scopeKeys: Set<string> | null;
}
function DebriefVideo({ runId, video, pruned, steps, scopeKeys }: DebriefVideoProps) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const scopedSteps = useMemo(() =>
    steps
      .filter((s) => Number.isFinite(s.startMs))
      .filter((s) => frameInScope(chunkKeyFor(s.pageId, s.stepId, s.viewportId), scopeKeys))
      .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0)),
    [steps, scopeKeys]
  );

  // When scope is narrowed, land the player on the scope's first chapter.
  useEffect(() => {
    const v = ref.current;
    if (!v || scopeKeys === null) return;
    const first = scopedSteps[0];
    if (!first || !Number.isFinite(first.startMs)) return;
    const seek = () => { v.currentTime = (first.startMs ?? 0) / 1000; };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
  }, [scopedSteps, scopeKeys]);

  if (pruned) return <div className="dr-db-empty">Video pruned by retention.</div>;
  if (!video) return <div className="dr-db-empty">No video for this run.</div>;
  return (
    <div className="dr-db-video">
      <video
        ref={ref}
        controls
        preload="metadata"
        src={evidenceFileUrl(runId, video)}
        className="dr-db-video-el"
      />
      {scopedSteps.length > 0 && (
        <div className="dr-rowwrap dr-db-chapters">
          {scopedSteps.map((row) => (
            <button
              key={`${row.pageId}:${row.stepId}:${row.viewportId}`}
              className="btn small"
              title={`${row.pageId}#${row.stepId} at ${row.viewportId}`}
              onClick={() => {
                const v = ref.current;
                if (!v || !Number.isFinite(row.startMs)) return;
                v.currentTime = (row.startMs ?? 0) / 1000;
                void v.play().catch(() => {});
              }}
            >
              {row.stepId} @{fmtOffset(row.startMs ?? 0)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Live Browser tab (Evidence V2 S6/D11) ───────────────────────────────
// Replays a check's compiled steps up to and including the selected step in a
// fresh held browser session, then embeds the interactive canvas. The live
// session is a server-side singleton (one at a time); POST is run-scoped, the
// GET/DELETE lifecycle is global.
interface LiveSession {
  sessionId: string;
  tabId?: string | null;
  canvasUrl?: string | null;
  canvasTailnetUrl?: string | null;
  runId?: string;
  pageId?: string;
  stepId?: string;
  viewportId?: string;
  replayed?: number;
  of?: number;
  startedAt?: string;
}

// The canvas embed skews if the wrapper aspect differs from the replayed
// viewport, so we derive the wrapper's aspect from the canvasUrl's viewport
// params (the server sets viewportWidth/viewportHeight) and cap the height so
// a portrait viewport can't blow up the page. Before any session: 16/10.
function liveStageStyle(canvasUrl?: string | null): React.CSSProperties {
  let w = 16;
  let h = 10;
  if (canvasUrl) {
    try {
      const u = new URL(canvasUrl, window.location.href);
      const cw = Number(u.searchParams.get("viewportWidth"));
      const ch = Number(u.searchParams.get("viewportHeight"));
      if (Number.isFinite(cw) && Number.isFinite(ch) && cw > 0 && ch > 0) { w = cw; h = ch; }
    } catch { /* fall back to the default aspect */ }
  }
  const capHeight = 560;
  return { aspectRatio: `${w} / ${h}`, width: "100%", maxWidth: `${Math.round(capHeight * (w / h))}px`, margin: "0 auto" };
}

function liveCheckLabel(step: { stepId: string; viewportId?: string; title?: string }): string {
  const base = step.title?.trim() || step.stepId;
  return step.viewportId ? `${base} @ ${step.viewportId}` : base;
}
function liveTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
}

interface LiveBrowserProps {
  runId: string;
  steps: DebriefStep[];
  scope: DebriefScope;
  scopeKeys: Set<string> | null;
  session: LiveSession | null;
  onSession: (session: LiveSession | null) => void;
  warnings: string[];
  onWarnings: (warnings: string[]) => void;
}
type LiveStatus = "checking" | "idle" | "replaying" | "conflict" | "error";
function LiveBrowser({ runId, steps, scope, scopeKeys, session, onSession, warnings, onWarnings }: LiveBrowserProps) {
  const [status, setStatus] = useState<LiveStatus>(session ? "idle" : "checking");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<LiveSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingStepId, setPendingStepId] = useState<string | null>(null);
  const [pickedKey, setPickedKey] = useState<string>("");

  const scopedChecks = useMemo(() =>
    steps.filter((s) => frameInScope(chunkKeyFor(s.pageId, s.stepId, s.viewportId), scopeKeys)),
    [steps, scopeKeys]
  );
  const singleCheck: DebriefStep | null = scope.kind === "check"
    ? (steps.find((s) => s.pageId === scope.pageId && s.stepId === scope.stepId && s.viewportId === scope.viewportId)
        ?? { pageId: scope.pageId, stepId: scope.stepId, viewportId: scope.viewportId })
    : null;
  const pickedCheck: DebriefStep | null = singleCheck
    ?? scopedChecks.find((s) => chunkKeyFor(s.pageId, s.stepId, s.viewportId) === pickedKey)
    ?? scopedChecks[0]
    ?? null;

  // Discover an already-open session when the tab opens (poll-free). A session
  // for this run re-embeds; one for another run is surfaced as a conflict.
  useEffect(() => {
    if (session) { setStatus("idle"); return; }
    let cancelled = false;
    setStatus("checking");
    fetch("/api/live-replay")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const live = (j.live ?? null) as LiveSession | null;
        if (!live) { setStatus("idle"); return; }
        if (live.runId === runId) { onSession(live); setStatus("idle"); }
        else { setConflict(live); setStatus("conflict"); }
      })
      .catch(() => { if (!cancelled) setStatus("idle"); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- discover once per run
  }, [runId]);

  const openLive = async (check: DebriefStep) => {
    setBusy(true);
    setError(null);
    setConflict(null);
    setPendingStepId(check.stepId);
    setStatus("replaying");
    try {
      const r = await fetch(`/api/runs/${encodeURIComponent(runId)}/live-replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageId: check.pageId, stepId: check.stepId, viewportId: check.viewportId })
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) { setConflict((j.live ?? null) as LiveSession | null); setStatus("conflict"); return; }
      if (!r.ok) { setError(j.error || `Replay failed (${r.status})`); setStatus("error"); return; }
      onWarnings(Array.isArray(j.warnings) ? j.warnings : []);
      onSession((j.live ?? null) as LiveSession | null);
      setStatus("idle");
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    } finally {
      setBusy(false);
      setPendingStepId(null);
    }
  };

  const closeLive = async () => {
    setBusy(true);
    try { await fetch("/api/live-replay", { method: "DELETE" }); } catch { /* best effort close */ }
    onSession(null);
    onWarnings([]);
    setConflict(null);
    setError(null);
    setStatus("idle");
    setBusy(false);
  };

  // A same-run session recovered via GET has no canvasUrl (only POST returns
  // it), so re-running the replay is the only way to re-embed its pixels.
  const reopen = async (s: LiveSession) => {
    if (!s.pageId || !s.stepId) { await closeLive(); return; }
    setBusy(true);
    try { await fetch("/api/live-replay", { method: "DELETE" }); } catch { /* best effort */ }
    onSession(null);
    setBusy(false);
    await openLive({ pageId: s.pageId, stepId: s.stepId, viewportId: s.viewportId ?? "desktop" });
  };

  const showConflict = status === "conflict" && conflict;
  const showSession = !showConflict && status !== "replaying" && !!session;

  return (
    <div className="dr-db-live">
      <p className="dr-db-live-note">Interactive live session - clicks affect the replayed state.</p>

      {status === "checking" && <div className="dr-db-empty">Checking for an open session...</div>}

      {status === "replaying" && (
        <div className="dr-db-live-progress" role="status">
          <span className="dr-db-spinner" aria-hidden="true" />
          <div>
            <b>Replaying steps up to {pendingStepId}...</b>
            <p>Re-running the compiled steps in a fresh browser session. This can take up to a minute.</p>
          </div>
        </div>
      )}

      {showConflict && conflict && (
        <div className="dr-db-live-conflict">
          <b>A live session is already open</b>
          <p>
            {conflict.runId === runId ? "It belongs to this run" : "It belongs to another run"}
            {conflict.stepId ? ` - up to ${conflict.stepId}` : ""}
            {conflict.viewportId ? ` at ${conflict.viewportId}` : ""}
            {Number.isFinite(conflict.replayed) && Number.isFinite(conflict.of) ? ` (${conflict.replayed}/${conflict.of} steps)` : ""}.
          </p>
          <div className="dr-rowwrap">
            {conflict.canvasUrl && (
              <button className="btn small" disabled={busy} onClick={() => { onSession(conflict); setConflict(null); setStatus("idle"); }}>Show it</button>
            )}
            <button className="btn primary" disabled={busy} onClick={closeLive}>Close it</button>
          </div>
        </div>
      )}

      {showSession && session && (
        <div className="dr-db-live-session">
          {session.canvasUrl && resolveEmbedUrl(session.canvasUrl, session.canvasTailnetUrl) ? (
            <div className="dr-db-live-stage" style={liveStageStyle(session.canvasUrl)}>
              <iframe className="dr-db-live-frame" src={resolveEmbedUrl(session.canvasUrl, session.canvasTailnetUrl)} title="Live browser session" />
            </div>
          ) : session.canvasUrl ? (
            <div className="dr-db-live-recover">
              <div className="dr-db-empty">
                The live session is open on the Garrison machine, but the Browser fitting's port is not
                published to the tailnet, so it cannot be embedded from this device. Run
                scripts/tailnet-serve-views.mjs there, then reload.
              </div>
            </div>
          ) : (
            <div className="dr-db-live-recover">
              <div className="dr-db-empty">A live session is active for this run, but its canvas link is only returned when it is opened.</div>
              <div className="dr-rowwrap">
                <button className="btn primary" disabled={busy} onClick={() => reopen(session)}>Reopen to view</button>
              </div>
            </div>
          )}
          <div className="dr-db-live-meta">
            {session.stepId && <span className="chip">{liveCheckLabel({ stepId: session.stepId, viewportId: session.viewportId })}</span>}
            {Number.isFinite(session.replayed) && Number.isFinite(session.of) && (
              <span className="dr-db-live-metaitem">Replayed {session.replayed}/{session.of} steps</span>
            )}
            {session.startedAt && <span className="dr-db-live-metaitem mono">started {liveTime(session.startedAt)}</span>}
          </div>
          {warnings.length > 0 && (
            <div className="dr-db-live-warnings">
              <b>Replay warnings</b>
              <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          <div className="dr-rowwrap">
            <button className="btn small" disabled={busy} onClick={closeLive}>Close live session</button>
          </div>
        </div>
      )}

      {status === "error" && !session && (
        <div className="dr-db-live-error" role="alert">
          <span>{error}</span>
          <button className="btn small" onClick={() => { setError(null); setStatus("idle"); }}>Dismiss</button>
        </div>
      )}

      {status === "idle" && !session && (
        <div className="dr-db-live-launch">
          {scope.kind === "check" && pickedCheck ? (
            <button className="btn primary" disabled={busy} onClick={() => openLive(pickedCheck)}>
              <Eye size={13} /> Open live at {liveCheckLabel(pickedCheck)}
            </button>
          ) : scopedChecks.length > 0 ? (
            <>
              <p className="dr-db-live-hint">Select a check to open the app live at that state.</p>
              <div className="dr-rowwrap">
                <select
                  aria-label="Check to open live"
                  value={pickedCheck ? chunkKeyFor(pickedCheck.pageId, pickedCheck.stepId, pickedCheck.viewportId) : ""}
                  onChange={(e) => setPickedKey(e.target.value)}
                >
                  {scopedChecks.map((s) => {
                    const key = chunkKeyFor(s.pageId, s.stepId, s.viewportId);
                    return <option key={key} value={key}>{liveCheckLabel(s)}</option>;
                  })}
                </select>
                <button className="btn primary" disabled={busy || !pickedCheck} onClick={() => pickedCheck && openLive(pickedCheck)}>
                  <Eye size={13} /> Open live at this state
                </button>
              </div>
            </>
          ) : (
            <div className="dr-db-empty">No checks available to open live for this run.</div>
          )}
        </div>
      )}
    </div>
  );
}

interface DebriefViewProps {
  run: DrillRun;
  pages: DrillPage[];
  steps: DebriefStep[];
  evidenceIndex: { items: EvidenceStepRow[] } | null;
  issues: { productFindings: Finding[]; infraErrors: InfraError[] };
  activeFindings: Finding[];
  confirmedCount: number;
  dispatchableCount: number;
  dispatchedCard: { id: string; url: string | null } | null;
  dispatchMode: "manual" | "heartbeat" | "immediate";
  setDispatchMode: (mode: "manual" | "heartbeat" | "immediate") => void;
  dispatching: boolean;
  dispatch: () => void;
  triage: (findingId: string, status: "confirmed" | "dismissed") => void;
}
type DebriefTab = "screenshots" | "video" | "live" | "session";
function DebriefView({
  run, pages, steps, evidenceIndex, issues, confirmedCount, dispatchableCount,
  dispatchedCard, dispatchMode, setDispatchMode, dispatching, dispatch, triage
}: DebriefViewProps) {
  const [scope, setScope] = useState<DebriefScope>({ kind: "all" });
  const [tab, setTab] = useState<DebriefTab>("screenshots");
  const [showAll, setShowAll] = useState(false);
  const [dwellMs, setDwellMs] = useState(2500);
  const [reel, setReel] = useState<ReelManifest | null>(null);
  const [spotter, setSpotter] = useState<SpotterManifest | null>(null);
  const [activeFrame, setActiveFrame] = useState<DebriefFrame | null>(null);
  const [flagged, setFlagged] = useState<Set<string>>(() => new Set());
  // The live session lives here (not in LiveBrowser) so it survives tab
  // switches; cleared when the selected run changes.
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null);
  const [liveWarnings, setLiveWarnings] = useState<string[]>([]);
  useEffect(() => { setLiveSession(null); setLiveWarnings([]); }, [run.id]);
  const enqueue = useDebriefFeedback(run.id);
  const checkRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const findingRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  const indexItems = evidenceIndex?.items ?? [];
  const hasReelRow = indexItems.some((i) => i.kind === "reel");
  const hasSpotterRow = indexItems.some((i) => i.kind === "spotter");
  const curationPending = hasSpotterRow && !hasReelRow;
  const videoItem = indexItems.find((i) => i.kind === "video");
  const videoPruned = !!videoItem?.pruned;
  const videoName = run.evidence?.video ?? null;

  // Load the sidecars the index advertises. Both are confined artifact routes.
  useEffect(() => {
    setReel(null);
    let cancelled = false;
    if (!hasReelRow) return;
    fetch(evidenceFileUrl(run.id, "reel.json"))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setReel(j); })
      .catch(() => { /* reel not ready */ });
    return () => { cancelled = true; };
  }, [run.id, hasReelRow]);

  useEffect(() => {
    setSpotter(null);
    let cancelled = false;
    if (!hasSpotterRow) return;
    fetch(evidenceFileUrl(run.id, "spotter-frames.json"))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setSpotter(j); })
      .catch(() => { /* spotter manifest absent */ });
    return () => { cancelled = true; };
  }, [run.id, hasSpotterRow]);

  const scopeKeys = useMemo(() => scopeCheckKeys(scope, steps), [scope, steps]);
  const scopeLabel = scope.kind === "all"
    ? "all"
    : scope.kind === "page"
      ? scope.pageId
      : `${scope.pageId}#${scope.stepId}@${scope.viewportId}`;

  const reelByName = useMemo(() => {
    const map = new Map<string, ReelFrame>();
    for (const f of reel?.frames ?? []) map.set(f.name, f);
    return map;
  }, [reel]);

  // The reel is the default source; show-all swaps to every raw candidate.
  // With no reel yet we fall back to spotter frames so the surface is never
  // empty while curation runs.
  const frames = useMemo<DebriefFrame[]>(() => {
    const inScope = (chunk: string | null) => frameInScope(chunk, scopeKeys);
    if (showAll) {
      const raw = spotter?.frames ?? reel?.frames ?? [];
      return raw
        .filter((f) => inScope(f.chunk ?? null))
        .map((f) => {
          const v = reelByName.get(f.name);
          const inReel = v?.keep === true;
          return {
            name: f.name,
            tMs: f.tMs ?? 0,
            trigger: f.trigger ?? "",
            chunk: f.chunk ?? null,
            keep: inReel,
            importance: v?.importance === "high" ? "high" : "normal",
            annotation: inReel ? (v?.annotation ?? "") : "",
            highlight: inReel ? (v?.highlight ?? null) : null,
            inReel
          } as DebriefFrame;
        })
        .sort((a, b) => a.tMs - b.tMs);
    }
    if (reel) {
      return reel.frames
        .filter((f) => f.keep === true)
        .filter((f) => inScope(f.chunk ?? null))
        .map((f): DebriefFrame => ({
          name: f.name,
          tMs: f.tMs ?? 0,
          trigger: f.trigger ?? "",
          chunk: f.chunk ?? null,
          keep: true,
          importance: f.importance === "high" ? "high" : "normal",
          annotation: f.annotation ?? "",
          highlight: f.highlight ?? null,
          inReel: true
        }))
        .sort((a, b) => a.tMs - b.tMs);
    }
    // Fallback while curation is pending: raw spotter frames, no annotations.
    return (spotter?.frames ?? [])
      .filter((f) => inScope(f.chunk ?? null))
      .map((f): DebriefFrame => ({
        name: f.name,
        tMs: f.tMs ?? 0,
        trigger: f.trigger ?? "",
        chunk: f.chunk ?? null,
        keep: false,
        importance: "normal",
        annotation: "",
        highlight: null,
        inReel: false
      }))
      .sort((a, b) => a.tMs - b.tMs);
  }, [showAll, reel, spotter, reelByName, scopeKeys]);

  const reelCount = reel?.counts?.reel ?? reel?.frames.filter((f) => f.keep === true).length ?? 0;
  const candidateCount = spotter?.frames.length ?? reel?.counts?.candidates ?? reel?.frames.length ?? 0;

  // Pass/fail tone per check, taken from the authoritative run verdicts so the
  // rail agrees with the classic check-results list.
  const passedByChunk = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const entry of run.pages) {
      map.set(chunkKeyFor(entry.pageId, entry.stepId, entry.viewportId), effectiveStepPassed(run, entry));
    }
    return map;
  }, [run]);

  // Checks grouped by page for the scope rail, preserving first-seen order.
  const pageGroups = useMemo(() => {
    const order: string[] = [];
    const byPage = new Map<string, DebriefStep[]>();
    for (const step of steps) {
      if (!byPage.has(step.pageId)) { byPage.set(step.pageId, []); order.push(step.pageId); }
      byPage.get(step.pageId)!.push(step);
    }
    return order.map((pageId) => ({
      pageId,
      title: pages.find((p) => p.id === pageId)?.title ?? pageId,
      checks: byPage.get(pageId)!
    }));
  }, [steps, pages]);

  const activeChunk = activeFrame?.chunk ?? null;

  // Follow the active frame's check (and any finding on it) as the reel advances
  // — but only within the rail's own scroll container, never the page. Using
  // scrollIntoView here dragged the whole page back to the screenshots on every
  // auto-advance, making the debrief unusable while scrolling.
  useEffect(() => {
    if (!activeChunk) return;
    revealWithinScrollParent(checkRefs.current.get(activeChunk));
    const finding = issues.productFindings.find((f) => findingChunk(f) === activeChunk);
    if (finding) revealWithinScrollParent(findingRefs.current.get(finding.id));
  }, [activeChunk, issues.productFindings]);

  const toggleShowAll = () => {
    setShowAll((prev) => {
      const next = !prev;
      if (next) enqueue({ type: "show-all", scope: scopeLabel });
      return next;
    });
  };
  const onFlag = (frameName: string) => {
    setFlagged((prev) => {
      const next = new Set(prev);
      next.add(frameName);
      return next;
    });
    enqueue({ type: "flag", frame: frameName, scope: scopeLabel });
  };

  const selectCheck = (step: DebriefStep) => {
    setScope((prev) =>
      prev.kind === "check" && prev.pageId === step.pageId && prev.stepId === step.stepId && prev.viewportId === step.viewportId
        ? { kind: "all" }
        : { kind: "check", pageId: step.pageId, stepId: step.stepId, viewportId: step.viewportId }
    );
  };
  const selectPage = (pageId: string) => {
    setScope((prev) => (prev.kind === "page" && prev.pageId === pageId ? { kind: "all" } : { kind: "page", pageId }));
  };
  const selectFinding = (finding: Finding) => {
    if (finding.stepId && finding.viewportId) {
      setScope({ kind: "check", pageId: finding.pageId, stepId: finding.stepId, viewportId: finding.viewportId });
    } else {
      setScope({ kind: "page", pageId: finding.pageId });
    }
  };

  const passedCount = run.pages.filter((entry) => effectiveStepPassed(run, entry)).length;
  const failedCount = run.pages.length - passedCount;

  return (
    <div className="dr-db">
      <div className="dr-db-topline">
        <div>
          <div className="dr-lbl">Debrief</div>
          <h2 className="dr-db-title">{formatDate(run.startedAt)}</h2>
          <div className="mono dr-run-id">{run.id}</div>
        </div>
        <div className="dr-db-scope-pill">
          {scope.kind === "all"
            ? "All checks"
            : scope.kind === "page"
              ? `Page: ${pages.find((p) => p.id === scope.pageId)?.title ?? scope.pageId}`
              : `Check: ${scope.stepId} @ ${scope.viewportId}`}
          {scope.kind !== "all" && (
            <button className="dr-db-scope-clear" aria-label="Clear scope" onClick={() => setScope({ kind: "all" })}><X size={12} /></button>
          )}
        </div>
      </div>

      <div className="dr-db-grid">
        <aside className="dr-db-rail">
          <div className="dr-db-rail-sec">
            <div className="dr-db-rail-head">
              <ListFilter size={12} /> Scope
              <span className="dr-db-rail-sub">{passedCount} passed · {failedCount} failed</span>
            </div>
            <button
              className={"dr-db-scope-row all" + (scope.kind === "all" ? " active" : "")}
              onClick={() => setScope({ kind: "all" })}
            >
              All checks
            </button>
            {pageGroups.map((group) => (
              <div key={group.pageId} className="dr-db-scope-group">
                <button
                  className={"dr-db-scope-row page" + (scope.kind === "page" && scope.pageId === group.pageId ? " active" : "")}
                  aria-pressed={scope.kind === "page" && scope.pageId === group.pageId}
                  onClick={() => selectPage(group.pageId)}
                >
                  <span className="dr-db-scope-title">{group.title}</span>
                  <span className="dr-db-scope-num">{group.checks.length}</span>
                </button>
                {group.checks.map((check) => {
                  const key = chunkKeyFor(check.pageId, check.stepId, check.viewportId);
                  const passed = passedByChunk.get(key);
                  const isScoped = scope.kind === "check" && scope.pageId === check.pageId && scope.stepId === check.stepId && scope.viewportId === check.viewportId;
                  const isActive = activeChunk === key;
                  const tone = passed === undefined ? "" : passed ? " pass" : " fail";
                  return (
                    <button
                      key={key}
                      ref={(el) => { checkRefs.current.set(key, el); }}
                      className={"dr-db-check" + tone + (isScoped ? " scoped" : "") + (isActive ? " live" : "")}
                      aria-pressed={isScoped}
                      title={`${check.pageId}#${check.stepId} at ${check.viewportId}`}
                      onClick={() => selectCheck(check)}
                    >
                      <span className={"dr-db-dot" + tone} aria-hidden="true" />
                      <span className="dr-db-check-label">{check.title?.trim() || check.stepId}</span>
                      <span className="chip dr-db-vp">{check.viewportId}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="dr-db-rail-sec">
            <div className="dr-db-rail-head">
              Findings <span className="dr-db-rail-sub">{issues.productFindings.length}</span>
            </div>
            {issues.productFindings.length === 0 && <div className="dr-db-rail-empty">No product findings.</div>}
            {issues.productFindings.map((f) => {
              const chunk = findingChunk(f);
              const isActive = !!chunk && chunk === activeChunk;
              return (
                <div key={f.id} className={"dr-db-finding" + (isActive ? " live" : "")}>
                  <button
                    className="dr-db-finding-main"
                    ref={(el) => { findingRefs.current.set(f.id, el); }}
                    onClick={() => selectFinding(f)}
                    title="Narrow the reel to this finding's check"
                  >
                    <span className={"dr-db-finding-status " + f.status}>{f.status}</span>
                    <span className="dr-db-finding-text" style={{ textDecoration: f.status === "dismissed" ? "line-through" : "none" }}>
                      {f.pageId}{f.stepId ? `#${f.stepId}` : ""}: {f.text}
                    </span>
                  </button>
                  <div className="dr-db-finding-actions">
                    {f.card && (f.card.url
                      ? <a className="chip brass" href={f.card.url} target="_blank" rel="noreferrer" title="Open the Kanban fix card carrying this finding">on card</a>
                      : <span className="chip brass" title="This finding is already on a Kanban fix card">on card</span>)}
                    {f.status !== "confirmed" && <button className="btn small" onClick={() => triage(f.id, "confirmed")}>Confirm</button>}
                    {f.status !== "dismissed" && !f.card && <button className="btn small" onClick={() => triage(f.id, "dismissed")}>Dismiss</button>}
                  </div>
                </div>
              );
            })}
            <div className="dr-db-dispatch">
              <select
                aria-label="When to send confirmed findings"
                value={dispatchMode}
                disabled={dispatching}
                onChange={(e) => setDispatchMode(e.target.value as any)}
              >
                <option value="manual">Send now</option>
                <option value="heartbeat">On the next heartbeat</option>
                <option value="immediate">Send now (immediate)</option>
              </select>
              <button className="btn primary" disabled={dispatchableCount === 0 || dispatching} onClick={dispatch}>
                {dispatching
                  ? "Sending…"
                  : dispatchMode === "heartbeat"
                    ? `Queue confirmed (${dispatchableCount})`
                    : `Send confirmed (${dispatchableCount})`}
              </button>
              <span className="dr-help-inline">
                {confirmedCount > 0 && dispatchableCount === 0
                  ? "Every confirmed finding is already on a fix card."
                  : run.dispatch === "heartbeat"
                    ? "Queued. The next heartbeat creates one Code card carrying this reviewed report."
                    : "Creates one Kanban card carrying the reviewed report and moves it into Code."}
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
        </aside>

        <section className="dr-db-content">
          <div className="dr-db-tabs" role="tablist" aria-label="Debrief evidence">
            <button role="tab" aria-selected={tab === "screenshots"} className={"dr-db-tab" + (tab === "screenshots" ? " on" : "")} onClick={() => setTab("screenshots")}>
              <LayoutGrid size={13} /> Screenshots
            </button>
            <button role="tab" aria-selected={tab === "video"} className={"dr-db-tab" + (tab === "video" ? " on" : "")} onClick={() => setTab("video")}>
              <VideoIcon size={13} /> Video
            </button>
            <button role="tab" aria-selected={tab === "live"} className={"dr-db-tab experimental" + (tab === "live" ? " on" : "")} title="Experimental - replays the app live at a check's state" onClick={() => setTab("live")}>
              <Eye size={13} /> Live Browser <span className="dr-db-exp-chip">experimental</span>
            </button>
            {(run.sessions?.length ?? 0) > 0 && (
              <button role="tab" aria-selected={tab === "session"} className={"dr-db-tab" + (tab === "session" ? " on" : "")} title="The Claude session(s) that resolved this run's vision checks" onClick={() => setTab("session")}>
                <MessageSquare size={13} /> Session{(run.sessions?.length ?? 0) > 1 ? "s" : ""}
              </button>
            )}
          </div>

          {tab === "screenshots" && (
            <ReelCarousel
              runId={run.id}
              frames={frames}
              dwellMs={dwellMs}
              setDwellMs={setDwellMs}
              showAll={showAll}
              onToggleShowAll={toggleShowAll}
              onActiveFrameChange={setActiveFrame}
              enqueue={enqueue}
              scopeLabel={scopeLabel}
              flagged={flagged}
              onFlag={onFlag}
              reelCount={reelCount}
              candidateCount={candidateCount}
              curationPending={curationPending}
            />
          )}
          {tab === "video" && (
            <DebriefVideo
              runId={run.id}
              video={videoName}
              pruned={videoPruned}
              steps={steps}
              scopeKeys={scopeKeys}
            />
          )}
          {tab === "live" && (
            <LiveBrowser
              runId={run.id}
              steps={steps}
              scope={scope}
              scopeKeys={scopeKeys}
              session={liveSession}
              onSession={setLiveSession}
              warnings={liveWarnings}
              onWarnings={setLiveWarnings}
            />
          )}
          {tab === "session" && (
            <SessionViewer runId={run.id} sessions={run.sessions ?? []} live={false} />
          )}
        </section>
      </div>
    </div>
  );
}

// Parked pre-Debrief run detail (Evidence V2 D7): the original results
// rendering, kept behaviourally byte-equivalent and reachable via the run
// detail's "Classic view" toggle. Runs with no evidence index render this
// directly.
interface ClassicRunDetailProps {
  run: DrillRun;
  pages: DrillPage[];
  evidenceRows: EvidenceStepRow[] | null;
  productPageEntries: RunPageEntry[];
  activeFindings: Finding[];
  incompleteCoverageCount: number;
  displayedInfra: InfraError[];
  issues: { productFindings: Finding[]; infraErrors: InfraError[] };
  confirmedCount: number;
  dispatchableCount: number;
  dispatchedCard: { id: string; url: string | null } | null;
  dispatchMode: "manual" | "heartbeat" | "immediate";
  setDispatchMode: (mode: "manual" | "heartbeat" | "immediate") => void;
  dispatching: boolean;
  obsText: string;
  setObsText: (value: string) => void;
  giveFeedback: (pageId: string, stepId: string, viewportId: string, note: string) => Promise<boolean>;
  override: (pageId: string, stepId: string, viewportId: string, verdict: "passed" | "failed", note?: string) => void;
  addObs: () => void;
  convertObsToStep: (obsId: string, pageId: string) => void;
  convertObsToFinding: (obsId: string, pageId: string) => void;
  triage: (findingId: string, status: "confirmed" | "dismissed") => void;
  dispatch: () => void;
}
function ClassicRunDetail({
  run, pages, evidenceRows, productPageEntries, activeFindings, incompleteCoverageCount,
  displayedInfra, issues, confirmedCount, dispatchableCount, dispatchedCard, dispatchMode,
  setDispatchMode, dispatching, obsText, setObsText, giveFeedback, override, addObs,
  convertObsToStep, convertObsToFinding, triage, dispatch
}: ClassicRunDetailProps) {
  const evidenceRowFor = (entry: { pageId: string; stepId: string; viewportId: string }) =>
    evidenceRows?.find((row) => row.pageId === entry.pageId && row.stepId === entry.stepId && row.viewportId === entry.viewportId) ?? null;
  return (
        <>
          {run.evidence?.video && (
            <RunEvidenceVideo runId={run.id} video={run.evidence.video} steps={evidenceRows ?? []} />
          )}
          <div className="dr-sec">
            <div className="dr-detail-heading">
              <div>
                <div className="dr-lbl">Selected run</div>
                <h2>{formatDate(run.startedAt)}</h2>
                <div className="mono dr-run-id">{run.id}</div>
                <div className="dr-rowwrap dr-selected-run-meta">
                  <span className="chip">{run.contextTag === "drill-adversarial" ? "Adversarial" : "Standard"}</span>
                  <span className="chip">{run.state === "default" ? "Default state" : `State: ${run.state}`}</span>
                </div>
              </div>
              <div className="dr-run-summary">
                <span><b>{productPageEntries.filter((entry) => effectiveStepPassed(run, entry)).length}</b> passed</span>
                <span><b>{productPageEntries.filter((entry) => !effectiveStepPassed(run, entry)).length}</b> failed</span>
                <span><b>{activeFindings.length}</b> findings</span>
                <span><b>{incompleteCoverageCount}</b> infra-affected or skipped</span>
              </div>
            </div>
            <div className="dr-card-heading">
              <div>
                <b>Check results</b>
                <p>Each row is one Book check at one viewport. Cached means a previously graduated deterministic assertion was reused.</p>
              </div>
            </div>
            {productPageEntries.length === 0 && (
              <div className="dr-empty">No product checks completed. Review the infrastructure section below before rerunning.</div>
            )}
            {productPageEntries.map((entry) => {
              const originalPassed = stepPassed(entry);
              const recordKey = `${entry.pageId}:${entry.stepId}`;
              const renderKey = `${recordKey}:${entry.viewportId}`;
              const override_ = overrideForEntry(run.overrides, entry);
              const passed = override_ ? override_.verdict === "passed" : originalPassed;
              const notes = [
                ...(run.feedback[recordKey] ?? []),
                ...(run.feedback[renderKey] ?? [])
              ];
              const stepDefinition = pages.find((page) => page.id === entry.pageId)?.steps.find((step) => step.id === entry.stepId);
              const resultReasoning = entry.result?.result?.reasoning ?? entry.terminal?.reasoning;
              const deterministicWithoutScreenshot =
                originalPassed &&
                entry.status === "completed" &&
                !!entry.result &&
                !entry.result.evidencePath &&
                !resultReasoning;
              return (
                <div key={renderKey} className="dr-res" style={{ borderLeft: `3px solid var(${passed ? "--sage" : "--alarm"})` }}>
                  <div className="dr-rowwrap">
                    {passed ? <Check size={14} style={{ color: "var(--sage)" }} /> : <span style={{ color: "var(--alarm)", fontWeight: 700 }}>×</span>}
                    <span className="mono" style={{ fontSize: 11, color: "var(--mute)" }}>{entry.pageId}#{entry.stepId}</span>
                    <span className="chip">{entry.viewportId}</span>
                    {entry.result?.tier && <span className={"chip " + tierTone(entry.result.tier)}>{entry.result.tier}</span>}
                  </div>
                  {stepDefinition?.description && <div className="dr-result-description">{stepDefinition.description}</div>}
                  {resultReasoning && (
                    <div className="dr-result-reason">{resultReasoning}</div>
                  )}
                  {entry.result?.error && <div style={{ color: "var(--alarm)", fontSize: 11, marginTop: 4 }}>{entry.result.error}</div>}
                  {deterministicWithoutScreenshot && (
                    <div className="dr-result-reason">Deterministic check - no screenshot was captured.</div>
                  )}
                  {entry.stateReferenceRejected && (
                    <div className="dr-result-reference-warning" role="status">
                      State reference not saved: the screenshot also contains an unexpected page error
                      {entry.stateReferenceRejected.warnings[0]?.text
                        ? ` (“${entry.stateReferenceRejected.warnings[0].text}”).`
                        : "."}
                    </div>
                  )}
                  {!entry.result && entry.status === "completed" && (
                    <div className="dr-result-detail-unavailable">Passed when run · detailed evidence is temporarily unavailable</div>
                  )}
                  {entry.result?.evidencePath && (
                    <EvidenceImage
                      src={`/api/runs/${encodeURIComponent(run.id)}/evidence/${encodeURIComponent(entry.pageId)}/${encodeURIComponent(entry.stepId)}/${encodeURIComponent(entry.viewportId)}`}
                      alt={`${entry.pageId} ${stepDefinition?.description || entry.stepId} at ${entry.viewportId}`}
                    />
                  )}
                  {(() => {
                    const row = evidenceRowFor(entry);
                    if (!row || (!row.screenshot && !row.trace && !row.failureScreenshot)) return null;
                    const videoName = run.evidence?.video;
                    return (
                      <div className="dr-rowwrap" style={{ marginTop: 5, gap: 6 }}>
                        {row.screenshot && (
                          <a className="chip" href={evidenceFileUrl(run.id, row.screenshot)} target="_blank" rel="noreferrer">full-page shot</a>
                        )}
                        {row.failureScreenshot && (
                          <a className="chip alarm" href={evidenceFileUrl(run.id, row.failureScreenshot)} target="_blank" rel="noreferrer">failure shot</a>
                        )}
                        {row.trace && (
                          <a className="chip" href={evidenceFileUrl(run.id, row.trace)} title="Playwright trace chunk - open with npx playwright show-trace">trace</a>
                        )}
                        {videoName && Number.isFinite(row.startMs) && (
                          <a className="chip" href={`${evidenceFileUrl(run.id, videoName)}#t=${Math.floor((row.startMs ?? 0) / 1000)}`} target="_blank" rel="noreferrer">
                            video @{fmtOffset(row.startMs ?? 0)}
                          </a>
                        )}
                      </div>
                    );
                  })()}
                  {override_ && <div style={{ color: "var(--brass)", fontSize: 11, marginTop: 4 }}>Overridden -&gt; {override_.verdict} ({override_.note})</div>}
                  {notes.map((n) => <div key={n.id} className="mono" style={{ fontSize: 10.5, color: "var(--sage)", marginTop: 3 }}>{n.note}</div>)}
                  <div className="dr-rowwrap" style={{ marginTop: 6 }}>
                    <input className="dr-feedback" aria-label={`Feedback for ${entry.pageId} ${entry.stepId} at ${entry.viewportId}`} placeholder="Add feedback…"
                      onKeyDown={async (e) => {
                        if (e.key !== "Enter") return;
                        const input = e.currentTarget;
                        if (await giveFeedback(entry.pageId, entry.stepId, entry.viewportId, input.value)) input.value = "";
                      }} />
                    {passed
                      ? <button className="btn small" onClick={() => override(entry.pageId, entry.stepId, entry.viewportId, "failed", "marked failed by reviewer")}>Mark failed</button>
                      : <button className="btn small" onClick={() => override(entry.pageId, entry.stepId, entry.viewportId, "passed", "marked passed by reviewer")}>Mark passed</button>}
                  </div>
                </div>
              );
            })}
          </div>

          {displayedInfra.length > 0 && (
            <details className="dr-sec dr-infra">
              <summary>
                <span>
                  <b>Test infrastructure problems</b>
                  <small>{incompleteCoverageCount} affected or skipped check{incompleteCoverageCount === 1 ? "" : "s"} · grouped into {displayedInfra.length} incident{displayedInfra.length === 1 ? "" : "s"} · hidden from findings</small>
                </span>
                <span className="chip brass">Run incomplete</span>
              </summary>
              <p>
                These errors came from Drill, Browser, Automations, Vision, or their connection. They are retained for diagnosis but cannot be confirmed or dispatched as product fixes.
              </p>
              {run.circuit && (
                <div className="dr-circuit-summary">
                  <b>Run stopped early to prevent repeated noise.</b>
                  <span>
                    Executed {run.executedChecks ?? run.circuit.afterCheck} of {run.plannedChecks ?? ((run.executedChecks ?? 0) + run.circuit.skippedChecks)} planned checks;
                    {" "}{run.circuit.skippedChecks} were skipped after {run.circuit.component} reported {run.circuit.code}.
                  </span>
                </div>
              )}
              <div className="dr-infra-list">
                {displayedInfra.map((item) => (
                  <div key={item.id}>
                    <span className="mono">
                      {item.component ?? item.pageId ?? "run"}
                      {item.stepId ? ` · ${item.stepId}` : ""}
                      {(item.count ?? 1) > 1 ? ` · ${item.count} checks` : ""}
                    </span>
                    <span>{item.text}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          <div className="dr-sec card">
            <div className="dr-card-heading">
              <div>
                <b>Observations</b>
                <p>Record something you noticed that no existing check covered. Turn it into a future Book step or a product finding without rerunning.</p>
              </div>
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
                  : <select aria-label={`Add observation “${o.text}” as a draft step on page`} onChange={(e) => e.target.value && convertObsToStep(o.id, e.target.value)} defaultValue="">
                      <option value="" disabled>-&gt; draft step on…</option>
                      {pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                    </select>}
                {o.convertedToFinding
                  ? <span className="chip alarm">-&gt; finding</span>
                  : <select aria-label={`Attribute observation “${o.text}” to a product page`} onChange={(e) => e.target.value && convertObsToFinding(o.id, e.target.value)} defaultValue="">
                      <option value="" disabled>-&gt; finding on…</option>
                      {pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                    </select>}
              </div>
            ))}
            <div className="dr-rowwrap" style={{ marginTop: 8 }}>
              <input className="dr-feedback" aria-label="New run observation" placeholder="Add an observation…" value={obsText} onChange={(e) => setObsText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addObs(); }} />
              <button className="btn small" onClick={addObs}><Plus size={11} /> Add</button>
            </div>
          </div>

          <div className="dr-sec card" style={{ borderColor: "var(--sage-2)", borderWidth: 1.5 }}>
            <div className="dr-card-heading">
              <div>
                <b>Product findings</b>
                <p>Only evidence about the app belongs here. Confirm real defects, dismiss false positives, then send confirmed items as one reviewable fix card.</p>
              </div>
              <span className="chip">{issues.productFindings.length}</span>
            </div>
            {issues.productFindings.length === 0 && <div className="dr-empty">No product findings in this run.</div>}
            {issues.productFindings.map((f) => (
              <div key={f.id} className="dr-finding">
                <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <span style={{ textDecoration: f.status === "dismissed" ? "line-through" : "none" }}>
                    [{f.kind}] {f.pageId}{f.stepId ? `#${f.stepId}` : ""}{f.viewportId ? ` [${f.viewportId}]` : ""}: {f.text}
                  </span>
                  {f.evidence?.screenshot ? (
                    // The finding carries its own evidence pointer (Drill
                    // Evidence v0.1); older records fall back to the
                    // render-time join below.
                    <>
                      <EvidenceImage
                        compact
                        src={evidenceFileUrl(run.id, f.evidence.screenshot)}
                        alt={`Evidence for ${f.text}`}
                      />
                      <div className="dr-rowwrap" style={{ marginTop: 4, gap: 6 }}>
                        {f.evidence.trace && (
                          <a className="chip" href={evidenceFileUrl(run.id, f.evidence.trace)} title="Playwright trace chunk - open with npx playwright show-trace">trace</a>
                        )}
                        {run.evidence?.video && Number.isFinite(f.evidence.videoMs) && (
                          <a className="chip" href={`${evidenceFileUrl(run.id, run.evidence.video)}#t=${Math.floor((f.evidence.videoMs ?? 0) / 1000)}`} target="_blank" rel="noreferrer">
                            video @{fmtOffset(f.evidence.videoMs ?? 0)}
                          </a>
                        )}
                      </div>
                    </>
                  ) : f.stepId && run.pages.filter((entry) =>
                    entry.pageId === f.pageId &&
                    entry.stepId === f.stepId &&
                    (!f.viewportId || entry.viewportId === f.viewportId) &&
                    !!entry.result?.evidencePath
                  ).map((entry) => (
                    <EvidenceImage
                      key={`${entry.pageId}:${entry.stepId}:${entry.viewportId}`}
                      compact
                      src={`/api/runs/${encodeURIComponent(run.id)}/evidence/${encodeURIComponent(entry.pageId)}/${encodeURIComponent(entry.stepId)}/${encodeURIComponent(entry.viewportId)}`}
                      alt={`Evidence for ${f.text} at ${entry.viewportId}`}
                    />
                  ))}
                </div>
                <div className="dr-actions">
                  <span className={"chip" + (f.status === "confirmed" ? " sage active" : "")}>{f.status}</span>
                  {f.card && (f.card.url
                    ? <a className="chip brass" href={f.card.url} target="_blank" rel="noreferrer" title="Open the Kanban fix card carrying this finding">on card</a>
                    : <span className="chip brass" title="This finding is already on a Kanban fix card">on card</span>)}
                  {f.status !== "confirmed" && <button className="btn small" onClick={() => triage(f.id, "confirmed")}>Confirm</button>}
                  {f.status !== "dismissed" && !f.card && <button className="btn small" onClick={() => triage(f.id, "dismissed")}>Dismiss</button>}
                </div>
              </div>
            ))}
            <div className="dr-dispatch">
              <select
                aria-label="When to send confirmed findings"
                value={dispatchMode}
                disabled={dispatching}
                onChange={(e) => setDispatchMode(e.target.value as any)}
                style={{ fontSize: 11, padding: "5px 8px" }}
              >
                <option value="manual">Send now</option>
                <option value="heartbeat">On the next heartbeat</option>
                <option value="immediate">Send now (immediate)</option>
              </select>
              <button className="btn primary" disabled={dispatchableCount === 0 || dispatching} onClick={dispatch}>
                {dispatching
                    ? "Sending…"
                    : dispatchMode === "heartbeat"
                      ? `Queue confirmed (${dispatchableCount})`
                      : `Send confirmed to Code (${dispatchableCount})`}
              </button>
              <span className="dr-help-inline">
                {confirmedCount > 0 && dispatchableCount === 0
                  ? "Every confirmed finding is already on a fix card."
                  : run.dispatch === "heartbeat"
                    ? "Queued. The next heartbeat creates one Code card carrying this reviewed report."
                    : "Creates one Kanban card carrying the reviewed report and moves it directly into Code."}
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
}

// ─── Live run observability + session viewer (S31) ─────────────────────────
// The Run page's answer to "is anything happening?": a live panel fed by the
// server's per-run SSE stream (checks ticking in with screenshots) plus a
// Claude-desktop-style transcript of the verify session(s) - tool calls
// collapsed, screenshots inline, click-through when a run used more than one
// session. The same viewer replays stored transcripts on finished runs.

interface SessionImage { mediaType: string; data: string }
interface SessionBlock {
  type: string;
  text?: string;
  name?: string;
  input?: string;
  toolUseId?: string | null;
  isError?: boolean;
  images?: SessionImage[];
}
interface SessionEvent {
  id: string | null;
  role: string;
  ts: number | null;
  toolResultsOnly?: boolean;
  blocks: SessionBlock[];
}

function SessionTextBlock({ text, role }: { text: string; role: string }) {
  // Long prompts (the routed VERIFY instructions) collapse to their first
  // line - the desktop-app "show more" idiom without the chrome.
  if (role === "user" && text.length > 280) {
    const head = text.slice(0, 140).split("\n")[0];
    return (
      <details className="dr-session-longtext">
        <summary>{head}…</summary>
        <pre className="dr-session-pre">{text}</pre>
      </details>
    );
  }
  return <pre className="dr-session-text">{text}</pre>;
}

function SessionToolBlock({ block, result }: { block: SessionBlock; result: SessionBlock | undefined }) {
  const hint = (block.input ?? "").replace(/\s+/g, " ").replace(/^[{[]\s*/, "").slice(0, 90);
  return (
    <div className="dr-session-toolwrap">
      <details className="dr-session-tool">
        <summary>
          <Wrench size={11} aria-hidden="true" />
          <b>{block.name}</b>
          <span className="dr-session-tool-hint">{hint}</span>
          {result?.isError && <span className="chip alarm">error</span>}
        </summary>
        {block.input && <pre className="dr-session-pre">{block.input}</pre>}
        {result?.text && <pre className="dr-session-pre result">{result.text}</pre>}
      </details>
      {(result?.images ?? []).map((image, index) => (
        <img
          key={index}
          className="dr-session-img"
          src={`data:${image.mediaType};base64,${image.data}`}
          alt={`${block.name ?? "tool"} result image ${index + 1}`}
          loading="lazy"
        />
      ))}
    </div>
  );
}

function SessionStream({ runId, sessionId, live }: { runId: string; sessionId: string; live: boolean }) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [title, setTitle] = useState<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "streaming" | "ended" | "unavailable">("connecting");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    setEvents([]);
    setTitle(null);
    setStatus("connecting");
    stickRef.current = true;
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/session-stream?session=${encodeURIComponent(sessionId)}`);
    source.onmessage = (message) => {
      let payload: any;
      try { payload = JSON.parse(message.data); } catch { return; }
      if (payload.type === "init") {
        setEvents(payload.events ?? []);
        if (payload.title) setTitle(payload.title);
        setStatus(payload.available === false ? "unavailable" : payload.live ? "streaming" : "ended");
      } else if (payload.type === "events") {
        if (payload.title) setTitle(payload.title);
        if (payload.events?.length) setEvents((current) => [...current, ...payload.events]);
      } else if (payload.type === "end") {
        setStatus((current) => (current === "unavailable" ? current : "ended"));
        source.close();
      }
    };
    source.onerror = () => {
      // The server ends the stream itself after `end`; an earlier transport
      // error should read as "stream over", not an eternal spinner.
      setStatus((current) => (current === "unavailable" ? current : "ended"));
      source.close();
    };
    return () => source.close();
  }, [runId, sessionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const resultsByToolUse = useMemo(() => {
    const map = new Map<string, SessionBlock>();
    for (const event of events) {
      for (const block of event.blocks) {
        if (block.type === "tool_result" && block.toolUseId) map.set(block.toolUseId, block);
      }
    }
    return map;
  }, [events]);

  return (
    <div className="dr-session">
      <div className="dr-session-head">
        <MessageSquare size={13} aria-hidden="true" />
        <b>{title ?? "Verify session"}</b>
        <span className="mono dr-session-id">{sessionId.slice(0, 8)}</span>
        {live && status === "streaming" && <span className="chip sage">live</span>}
        {status === "connecting" && <span className="chip">connecting…</span>}
        {status === "unavailable" && <span className="chip brass">transcript unavailable</span>}
      </div>
      <div className="dr-session-scroll" ref={scrollRef} onScroll={onScroll}>
        {events.length === 0 && (
          <div className="dr-empty">
            {status === "connecting"
              ? "Opening the session stream…"
              : status === "unavailable"
                ? "No transcript was captured for this session (the gateway did not report one)."
                : live
                  ? "Waiting for the first session activity…"
                  : "No session activity fell inside this run's window."}
          </div>
        )}
        {events.filter((event) => !event.toolResultsOnly).map((event, index) => (
          <div key={event.id ?? `event-${index}`} className={"dr-session-turn " + (event.role === "user" ? "user" : "assistant")}>
            <span className="dr-session-role">{event.role === "user" ? "Prompt" : "Assistant"}</span>
            {event.blocks.map((block, blockIndex) => {
              if (block.type === "text") return <SessionTextBlock key={blockIndex} text={block.text ?? ""} role={event.role} />;
              if (block.type === "thinking") {
                return (
                  <details key={blockIndex} className="dr-session-thinking">
                    <summary>Thinking</summary>
                    <pre className="dr-session-pre">{block.text}</pre>
                  </details>
                );
              }
              if (block.type === "tool_use") {
                return <SessionToolBlock key={blockIndex} block={block} result={block.toolUseId ? resultsByToolUse.get(block.toolUseId) : undefined} />;
              }
              return null;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionViewer({ runId, sessions, live }: { runId: string; sessions: RunSessionInfo[]; live: boolean }) {
  const [selected, setSelected] = useState<string | null>(sessions[0]?.id ?? null);
  const sessionKey = sessions.map((session) => session.id).join(",");
  useEffect(() => {
    if (sessions.length === 0) { setSelected(null); return; }
    setSelected((current) => (current && sessions.some((session) => session.id === current) ? current : sessions[0].id));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the id list
  }, [sessionKey]);
  if (sessions.length === 0) {
    return (
      <div className="dr-empty">
        No verify sessions recorded{live ? " yet - the first vision-resolved check opens one" : " for this run. Cached and deterministic checks run without a model session"}.
      </div>
    );
  }
  return (
    <div className="dr-session-viewer">
      {sessions.length > 1 && (
        <div className="dr-rowwrap dr-session-tabs" role="tablist" aria-label="Verify sessions">
          {sessions.map((session, index) => (
            <button
              key={session.id}
              role="tab"
              aria-selected={selected === session.id}
              className={"chip click" + (selected === session.id ? " ink active" : "")}
              onClick={() => setSelected(session.id)}
            >
              Session {index + 1}
              <span className="dr-count">{session.checks ?? 0} check{(session.checks ?? 0) === 1 ? "" : "s"}</span>
            </button>
          ))}
        </div>
      )}
      {selected && <SessionStream key={selected} runId={runId} sessionId={selected} live={live} />}
    </div>
  );
}

interface LiveCheckRow {
  index: number;
  total: number;
  pageId: string;
  stepId: string;
  viewportId: string;
  kind: string;
  code?: string;
  message?: string;
  reasoning?: string;
  durationMs?: number;
  screenshot?: string;
  failureScreenshot?: string;
  sessionId?: string;
}

// The check screenshot can land on disk a beat after the check_finished
// event (the Browser fitting flushes asynchronously). Fetch-first like
// useFetchedImage - no console 404 noise - and retry briefly so a
// late-landing file still shows without a refresh.
function LiveCheckThumb({ src, alt }: { src: string; alt: string }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    const attempt = async (remaining: number) => {
      try {
        const response = await fetch(src, { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        objectUrl = URL.createObjectURL(await response.blob());
        if (!cancelled) setImageUrl(objectUrl);
      } catch {
        if (!cancelled && remaining > 0) setTimeout(() => void attempt(remaining - 1), 1200);
      }
    };
    void attempt(4);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  if (!imageUrl) return null;
  return (
    <a className="dr-live-check-shot" href={src} target="_blank" rel="noreferrer">
      <img src={imageUrl} alt={alt} />
    </a>
  );
}

function LiveRunPanel({ runId, startedAt, onFinished }: { runId: string; startedAt: string | null; onFinished: (runId: string) => void }) {
  const [planned, setPlanned] = useState<number | null>(null);
  const [current, setCurrent] = useState<{ index: number; total: number; pageId: string; stepId: string; viewportId: string; description?: string } | null>(null);
  const [checks, setChecks] = useState<LiveCheckRow[]>([]);
  const [circuit, setCircuit] = useState<{ code?: string; message?: string; skippedChecks?: number } | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<string | null>(startedAt);
  const [streamLost, setStreamLost] = useState(false);
  const [, setTick] = useState(0);
  const finishedRef = useRef(false);
  const streamLostRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  useEffect(() => { onFinishedRef.current = onFinished; });

  // Elapsed clock - re-render once a second while the panel is up.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    finishedRef.current = false;
    streamLostRef.current = false;
    setChecks([]);
    setCurrent(null);
    setCircuit(null);
    setStreamLost(false);
    setPlanned(null);
    setRunStartedAt(startedAt);
    const finish = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      onFinishedRef.current(runId);
    };
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    source.onmessage = (message) => {
      let event: any;
      try { event = JSON.parse(message.data); } catch { return; }
      if (streamLostRef.current) {
        streamLostRef.current = false;
        setStreamLost(false);
      }
      if (event.type === "run_started") {
        setPlanned(event.plannedChecks ?? null);
        if (event.startedAt) setRunStartedAt(event.startedAt);
      } else if (event.type === "check_started") {
        setCurrent(event);
      } else if (event.type === "check_finished") {
        setCurrent(null);
        // Keyed on the check index: EventSource auto-reconnects after a
        // transport blip and the server replays its whole buffer - a blind
        // prepend would duplicate every row.
        setChecks((rows) => rows.some((row) => row.index === event.index)
          ? rows.map((row) => (row.index === event.index ? event : row))
          : [event, ...rows]);
      } else if (event.type === "circuit_opened") {
        setCircuit(event);
      } else if (event.type === "run_finished" || event.type === "run_unknown") {
        source.close();
        finish();
      }
    };
    source.onerror = () => {
      streamLostRef.current = true;
      setStreamLost(true);
    };
    // Poll fallback: only when the stream broke - the disk record persists
    // incrementally, so endedAt appearing there is the finish signal.
    const poll = setInterval(() => {
      if (finishedRef.current || !streamLostRef.current) return;
      apiGet(`/api/runs/${encodeURIComponent(runId)}`)
        .then((response) => {
          if (response.run?.endedAt) {
            source.close();
            finish();
          }
        })
        .catch(() => { /* transient - keep polling */ });
    }, 5000);
    return () => {
      source.close();
      clearInterval(poll);
    };
  }, [runId]);

  const elapsedMs = runStartedAt ? Date.now() - new Date(runStartedAt).getTime() : null;
  const elapsed = elapsedMs !== null && Number.isFinite(elapsedMs) && elapsedMs >= 0
    ? elapsedMs < 60_000
      ? `${Math.floor(elapsedMs / 1000)}s elapsed`
      : `${Math.floor(elapsedMs / 60_000)}m ${Math.floor((elapsedMs % 60_000) / 1000)}s elapsed`
    : null;

  // Sessions derive from the (deduplicated) check rows, in first-use order.
  const sessions = useMemo<RunSessionInfo[]>(() => {
    const byId = new Map<string, RunSessionInfo>();
    for (const check of [...checks].sort((a, b) => a.index - b.index)) {
      if (!check.sessionId) continue;
      const existing = byId.get(check.sessionId);
      if (existing) existing.checks = (existing.checks ?? 0) + 1;
      else byId.set(check.sessionId, { id: check.sessionId, checks: 1 });
    }
    return [...byId.values()];
  }, [checks]);

  return (
    <div className="dr-sec card dr-live-run" role="region" aria-label="Run in progress">
      <div className="dr-card-heading">
        <div>
          <b>Run in progress</b>
          <p>Checks stream in as they execute; the verify session is live below. Closing this page does not stop the run.</p>
        </div>
        <span className="mono dr-run-id">{runId}</span>
      </div>
      <div className="dr-db-live-progress" role="status" aria-live="polite">
        <span className="dr-db-spinner" aria-hidden="true" />
        <div>
          <b>
            {circuit
              ? `Circuit opened${circuit.code ? ` - ${circuit.code}` : ""}`
              : current
                ? `Check ${current.index}/${current.total}: ${current.description ?? current.stepId}`
                : checks.length > 0
                  ? `Executed ${checks.length}/${planned ?? checks[0]?.total ?? "?"} checks`
                  : "Starting run…"}
          </b>
          <p>
            {current ? `${current.pageId} · ${current.stepId} · ${current.viewportId}` : "Waiting for the next check…"}
            {elapsed ? ` · ${elapsed}` : ""}
            {streamLost ? " · live stream lost - polling the run record" : ""}
          </p>
        </div>
      </div>
      {circuit && (
        <div className="dr-inline-error" role="alert">
          <span>{circuit.message ?? "The run circuit opened."}{Number.isFinite(circuit.skippedChecks) ? ` Remaining ${circuit.skippedChecks} checks were skipped.` : ""}</span>
        </div>
      )}
      {checks.length > 0 && (
        <div className="dr-live-checks" aria-label="Executed checks">
          {checks.slice(0, 40).map((check) => {
            const shot = check.failureScreenshot ?? check.screenshot;
            return (
              <div key={`${check.index}-${check.pageId}-${check.stepId}-${check.viewportId}`} className="dr-live-check" title={check.reasoning ?? check.message ?? undefined}>
                <span className={`chip ${check.kind === "passed" ? "sage" : check.kind === "product-failure" ? "alarm" : "brass"}`}>
                  {check.kind === "passed" ? "pass" : check.kind === "product-failure" ? "fail" : check.kind}
                </span>
                <span className="dr-live-check-name">
                  {check.pageId} · {check.stepId} <span className="mono">[{check.viewportId}]</span>
                </span>
                {Number.isFinite(check.durationMs) && <span className="dr-live-check-ms mono">{((check.durationMs ?? 0) / 1000).toFixed(1)}s</span>}
                {shot && <LiveCheckThumb src={evidenceFileUrl(runId, shot)} alt={`${check.stepId} screenshot`} />}
              </div>
            );
          })}
        </div>
      )}
      <div className="dr-live-session-wrap">
        <div className="dr-lbl">Verify session</div>
        <SessionViewer runId={runId} sessions={sessions} live />
      </div>
    </div>
  );
}

function ResultsView({ initialRun, onConsumeInitialRun, initialSelection, onConsumeInitialSelection, initialRunId, onRunViewed }: {
  initialRun: { pageIds: string[]; viewports: string[] } | null;
  onConsumeInitialRun: () => void;
  initialSelection?: { pageId: string; state: string; viewportId: string } | null;
  onConsumeInitialSelection?: () => void;
  initialRunId?: string | null;
  onRunViewed: (runId: string) => void;
}) {
  const [pages, setPages] = useState<DrillPage[]>([]);
  const [pagesLoaded, setPagesLoaded] = useState(false);
  const [book, setBook] = useState<DrillBook | null>(null);
  const [runs, setRuns] = useState<DrillRunSummary[]>([]);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [run, setRun] = useState<DrillRun | null>(null);
  const [historyPage, setHistoryPage] = useState(0);
  // Per-check evidence rows from the run's evidence.json (Drill Evidence
  // v0.1) - absent for runs recorded before capture existed. The full index
  // (all item kinds) and steps.json feed the Debrief surface (Evidence V2).
  const [evidenceRows, setEvidenceRows] = useState<EvidenceStepRow[] | null>(null);
  const [evidenceIndex, setEvidenceIndex] = useState<{ items: EvidenceStepRow[] } | null>(null);
  const [evidenceStepsJson, setEvidenceStepsJson] = useState<DebriefStep[] | null>(null);
  const [classicView, setClassicView] = useState(false);
  // Reset the view choice only when the SELECTED RUN changes. The evidence
  // effect below re-runs on every data refresh (run?.evidence is a fresh
  // object per refetch after an override/triage/feedback), and resetting
  // there yanked the operator out of the classic view they toggled.
  useEffect(() => { setClassicView(false); }, [run?.id]);
  useEffect(() => {
    setEvidenceRows(null);
    setEvidenceIndex(null);
    setEvidenceStepsJson(null);
    if (!run?.id || !run?.evidence) return;
    let cancelled = false;
    apiGet(`/api/runs/${encodeURIComponent(run.id)}/evidence-index`)
      .then((r) => {
        if (cancelled) return;
        setEvidenceIndex(r.index ?? null);
        setEvidenceStepsJson(Array.isArray(r.steps) ? r.steps : null);
        setEvidenceRows((r.index?.items ?? []).filter((item: EvidenceStepRow) => item.kind === "step"));
      })
      .catch(() => { /* no index for this run */ });
    return () => { cancelled = true; };
  }, [run?.id, run?.evidence]);
  // Cross-view handoffs are already known when Results mounts. Seed the
  // controls from them so the first page-button commit is truthful; waiting
  // for the pages request and then applying a passive effect exposed one frame
  // where a prepared reference run looked completely unselected.
  const [selectedPages, setSelectedPages] = useState<Set<string>>(() => new Set(
    initialSelection ? [initialSelection.pageId] : (initialRun?.pageIds ?? [])
  ));
  const [selectedViewports, setSelectedViewports] = useState<Set<string>>(() => new Set(
    initialSelection ? [initialSelection.viewportId] : (initialRun?.viewports ?? ["desktop"])
  ));
  const [selectedState, setSelectedState] = useState(initialSelection?.state ?? "default");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [obsText, setObsText] = useState("");
  const [dispatchMode, setDispatchMode] = useState<"manual" | "heartbeat" | "immediate">("manual");
  // The card minted by the last dispatch click - shown inline as a link so
  // "did my fixes reach the kanban?" is answered right here.
  const [dispatchedCard, setDispatchedCard] = useState<{ id: string; url: string | null } | null>(null);
  const [deleteArm, setDeleteArm] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [pendingGate, setPendingGate] = useState<{ plan: Array<{ pageId: string; viewportId: string; steps: Array<{ id: string; description: string; mode: string }> }>; resume: unknown } | null>(null);
  // S31: the in-flight run this view is watching live. Runs execute in the
  // background server-side; the panel attaches to the run's SSE event stream.
  const [watchRunId, setWatchRunId] = useState<string | null>(null);
  const [watchStartedAt, setWatchStartedAt] = useState<string | null>(null);

  const load = () => {
    Promise.all([apiGet("/api/pages"), apiGet("/api/drillbook"), apiGet("/api/runs")])
      .then(([p, b, r]) => {
        setPages(p.pages);
        setPagesLoaded(true);
        setBook(b.book);
        setRuns(r.runs);
        setRunsLoaded(true);
        const desired = initialRunId && r.runs.some((item: DrillRunSummary) => item.id === initialRunId)
          ? initialRunId
          : r.runs[0]?.id;
        if (!run && desired) apiGet(`/api/runs/${desired}`).then((rr) => setRun(rr.run));
      })
      .catch((e) => {
        setRunsLoaded(true);
        setError(e.message);
      });
    // A run started before this mount (another tab, another device, a page
    // reload) is still observable - re-attach instead of looking idle.
    apiGet("/api/runs/active")
      .then((response) => {
        const active = (response.runs ?? [])[0];
        if (active?.id) {
          setWatchRunId((current) => current ?? active.id);
          setWatchStartedAt((current) => current ?? active.startedAt ?? null);
        }
      })
      .catch(() => { /* older server without the active route */ });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch
  useEffect(load, []);

  // The watched run finished: detach the live panel, load the final record
  // into the detail view, and refresh the history table.
  const onWatchedRunFinished = (finishedRunId: string) => {
    setWatchRunId(null);
    setWatchStartedAt(null);
    void openRun(finishedRunId);
    load();
  };

  const startRun = async (pageIdsArg?: string[], viewportsArg?: string[], stateArg?: string) => {
    if (running || watchRunId) { setError("a run is already in progress - wait for it to finish"); return; }
    const pageIds = pageIdsArg ?? [...selectedPages];
    const viewports = viewportsArg ?? [...selectedViewports];
    if (pageIds.length === 0 || viewports.length === 0) { setError("select at least one page and one viewport"); return; }
    const requestedState = stateArg ?? (availableStates.includes(selectedState) ? selectedState : "default");
    const uncovered = pageIds.flatMap((pageId) => {
      const page = pages.find((candidate) => candidate.id === pageId);
      return viewports
        .filter((viewportId) => !page?.steps.some((step) =>
          step.enabled !== false &&
          (step.state || "default") === requestedState &&
          (!step.viewports?.length || step.viewports.includes(viewportId))
        ))
        .map((viewportId) => `${page?.title || pageId} · ${viewportId}`);
    });
    if (uncovered.length > 0) {
      setError(
        `No enabled ${requestedState === "default" ? "default-state " : `${requestedState} `}checks cover ${uncovered.join(", ")}. Adjust the page, state, or viewport selection before running.`
      );
      return;
    }
    setRunning(true);
    setError(null);
    setPendingGate(null);
    try {
      // The app under test must be serving first - down means "start it
      // through the project's run skill" and wait, not a wall of failures.
      await ensureAppUp(setPhase);
      setPhase(null);
      // background:true (S31): the server returns the in-flight record
      // immediately and the live panel streams progress - no minutes-long
      // blocking POST between the click and the first feedback.
      const r = await apiPost("/api/runs", { pageIds, viewports, state: requestedState, contextTag: "drill", background: true });
      if (r.held) {
        // A5/R7/S22: gated autonomy pauses with a plan diff before running.
        setPendingGate({ plan: r.plan, resume: r.resume });
      } else {
        setRun(r.run);
        if (r.background && r.run?.id) {
          setWatchRunId(r.run.id);
          setWatchStartedAt(r.run.startedAt ?? null);
          onRunViewed(r.run.id);
        }
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
  // viewports and start immediately - unless a run is already in flight
  // (S31: runs are backgrounded now, so this handoff CAN arrive mid-run;
  // the selection is kept but the auto-start is skipped, matching the
  // server's one-run-per-project guard).
  useEffect(() => {
    if (!initialRun || pages.length === 0) return;
    setSelectedPages(new Set(initialRun.pageIds));
    setSelectedViewports(new Set(initialRun.viewports));
    onConsumeInitialRun();
    if (running || watchRunId) {
      setNotice("A run is already in progress - your selection is set; start it when the current run finishes.");
      return;
    }
    startRun(initialRun.pageIds, initialRun.viewports, "default");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot handoff consume
  }, [initialRun, pages.length]);

  // States links prepare (but deliberately do not auto-start) the exact named
  // state coverage. The user lands at meaningful controls instead of a
  // generic Results page that forgets which missing reference they came from.
  useEffect(() => {
    if (!initialSelection || pages.length === 0) return;
    if (pages.some((candidate) => candidate.id === initialSelection.pageId)) {
      setSelectedPages(new Set([initialSelection.pageId]));
      setSelectedViewports(new Set([initialSelection.viewportId]));
      setSelectedState(initialSelection.state);
    }
    onConsumeInitialSelection?.();
  }, [initialSelection, pages.length, onConsumeInitialSelection]);

  const approveGate = async () => {
    if (!pendingGate) return;
    setRunning(true);
    try {
      const r = await apiPost("/api/runs", { ...(pendingGate.resume as Record<string, unknown>), background: true });
      setPendingGate(null);
      setRun(r.run);
      if (r.background && r.run?.id) {
        setWatchRunId(r.run.id);
        setWatchStartedAt(r.run.startedAt ?? null);
        onRunViewed(r.run.id);
      }
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const refreshRun = (r: DrillRun) => {
    setRun(r);
    // Keep the selected history row's verdict/counts in lockstep with review
    // overrides instead of requiring a reload to reflect the new truth.
    setRuns((current) => current.map((summary) => summary.id === r.id ? r : summary));
  };

  const openRun = (id: string) => {
    setDispatchedCard(null);
    return apiGet(`/api/runs/${encodeURIComponent(id)}`)
      .then((response) => {
        setRun(response.run);
        onRunViewed(id);
      })
      .catch((e) => setError(e.message));
  };
  const deleteRun = async (id: string) => {
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      setDeleteArm(null);
      const result = await apiGet("/api/runs");
      const nextRuns = (result.runs ?? []) as DrillRunSummary[];
      setRuns(nextRuns);
      if (run?.id === id) {
        if (nextRuns.length > 0) void openRun(nextRuns[0].id);
        else setRun(null);
      }
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    if (run?.dispatch) setDispatchMode(run.dispatch);
    setNotice(null);
  }, [run?.id]);

  const giveFeedback = async (pageId: string, stepId: string, viewportId: string, note: string) => {
    if (!note.trim()) return false;
    try {
      const r = await apiPost(`/api/runs/${run!.id}/feedback`, { pageId, stepId, viewportId, note: note.trim() });
      refreshRun(r.run);
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    }
  };
  const override = async (pageId: string, stepId: string, viewportId: string, verdict: "passed" | "failed", note = "") => {
    try {
      const r = await apiPost(`/api/runs/${run!.id}/override`, { pageId, stepId, viewportId, verdict, note });
      refreshRun(r.run);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const addObs = async () => {
    if (!obsText.trim()) return;
    try {
      const r = await apiPost(`/api/runs/${run!.id}/observation`, { text: obsText.trim() });
      setObsText("");
      refreshRun(r.run);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const convertObsToStep = async (obsId: string, pageId: string) => {
    try {
      const r = await apiPost(`/api/runs/${run!.id}/observation/${obsId}/convert-step`, { pageId });
      refreshRun(r.run);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const convertObsToFinding = async (obsId: string, pageId: string) => {
    try {
      const r = await apiPost(`/api/runs/${run!.id}/observation/${obsId}/convert-finding`, { pageId });
      refreshRun(r.run);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const triage = async (findingId: string, status: "confirmed" | "dismissed") => {
    try {
      const j = await apiPatch(`/api/runs/${run!.id}/findings/${findingId}`, { status });
      refreshRun(j.run);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const dispatch = async () => {
    if (!run || dispatching) return;
    setDispatching(true);
    setError(null);
    setNotice(null);
    try {
      const j = await apiPost(`/api/runs/${run.id}/dispatch`, { mode: dispatchMode });
      if (j.run) refreshRun(j.run);
      if (j.dispatched) {
        setDispatchedCard(j.card ? { id: j.card.id, url: j.card.url ?? null } : null);
        const cardId = j.card?.id ? ` ${j.card.id}` : "";
        setNotice(`Fix card${cardId} was sent to the Code queue.`);
      } else {
        setNotice(`${j.pending} confirmed finding${j.pending === 1 ? "" : "s"} queued for the next heartbeat.`);
      }
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDispatching(false);
    }
  };

  const issues = run ? splitRunIssues(run) : { productFindings: [], infraErrors: [] };
  const activeFindings = run ? activeProductFindings(run, issues.productFindings) : [];
  const confirmedCount = activeFindings.filter((f) => f.status === "confirmed").length;
  const dispatchableCount = activeFindings.filter((finding) => finding.status === "confirmed" && !finding.card).length;
  // Debrief scope is built from steps.json (carries the human-readable title);
  // when a run predates steps.json we fall back to the index's step items so
  // the scope rail still lists every executed check. Memoised so its reference
  // stays stable across unrelated re-renders - otherwise the reel's scope memo
  // would churn and snap the carousel back to the first frame.
  const debriefSteps: DebriefStep[] = useMemo(() =>
    evidenceStepsJson && evidenceStepsJson.length > 0
      ? evidenceStepsJson
      : (evidenceRows ?? []).map((row) => ({
          pageId: row.pageId ?? "",
          stepId: row.stepId ?? "",
          viewportId: row.viewportId ?? "",
          startMs: row.startMs,
          endMs: row.endMs,
          status: row.status,
          automationRunId: row.automationRunId ?? null
        })),
    [evidenceStepsJson, evidenceRows]
  );
  // The Debrief is the default surface once a run has an evidence index with
  // executable checks; older, index-less runs fall through to Classic.
  const debriefAvailable = !!evidenceIndex && debriefSteps.length > 0;
  const historyPageSize = 6;
  const historyPages = Math.max(1, Math.ceil(runs.length / historyPageSize));
  const visibleRuns = runs.slice(historyPage * historyPageSize, (historyPage + 1) * historyPageSize);
  const infraOccurrenceKeys = new Set(
    issues.infraErrors.flatMap((item) => (item.occurrences ?? []).map((occurrence) =>
      `${occurrence.pageId ?? ""}:${occurrence.stepId ?? ""}:${occurrence.viewportId ?? ""}`
    ))
  );
  const infraPageEntries = run
    ? run.pages.filter((entry) =>
        ["infra-failure", "blocked", "incomplete"].includes(entry.terminal?.kind ?? "") ||
        entry.status === "error" ||
        (!entry.terminal && entry.status === "failed" && !entry.result) ||
        legacyInfrastructureMeta({ kind: "step-fail", text: entry.error ?? entry.result?.error ?? "" }) !== null ||
        infraOccurrenceKeys.has(`${entry.pageId}:${entry.stepId}:${entry.viewportId}`) ||
        infraOccurrenceKeys.has(`${entry.pageId}:${entry.stepId}:`)
      )
    : [];
  const productPageEntries = run
    ? run.pages.filter((entry) => !infraPageEntries.includes(entry))
    : [];
  const displayedInfra = groupInfraErrors([
    ...issues.infraErrors,
    ...infraPageEntries.filter((entry) =>
      !infraOccurrenceKeys.has(`${entry.pageId}:${entry.stepId}:${entry.viewportId}`) &&
      !infraOccurrenceKeys.has(`${entry.pageId}:${entry.stepId}:`)
    ).map((entry, index) => ({
        id: `${entry.pageId}:${entry.stepId}:${index}`,
        pageId: entry.pageId,
        stepId: entry.stepId,
        text: entry.terminal?.message ?? entry.error ?? entry.result?.error ?? "Infrastructure step failed",
        at: run?.startedAt ?? new Date().toISOString(),
        count: 1,
        code: entry.terminal?.code ?? "run-detail-unavailable",
        component: entry.terminal?.component ?? "automations",
        occurrences: [{ pageId: entry.pageId, stepId: entry.stepId, viewportId: entry.viewportId }]
      }))
  ]);
  const infraOccurrenceCount = displayedInfra.reduce((total, item) => total + (item.count ?? 1), 0);
  const circuitSkippedChecks = run?.circuit?.skippedChecks ?? 0;
  const incompleteCoverageCount = run?.circuit?.afterCheck === 0
    ? Math.max(infraOccurrenceCount, circuitSkippedChecks)
    : infraOccurrenceCount + circuitSkippedChecks;
  const selectedPageDefinitions = pages.filter((page) => selectedPages.has(page.id));
  const commonNamedStates = selectedPageDefinitions.length === 0
    ? []
    : selectedPageDefinitions[0].states
        .map((state) => state.id)
        .filter((stateId) =>
          stateId !== "default" &&
          selectedPageDefinitions.every((page) => page.states.some((state) => state.id === stateId))
        );
  const availableStates = ["default", ...commonNamedStates];
  const availableStateKey = availableStates.join("\u0000");
  useEffect(() => {
    // Before /api/pages resolves there is no state catalog to validate
    // against. Resetting during that hydration window would erase a named
    // state handed off from the States view.
    if (pagesLoaded && !availableStates.includes(selectedState)) setSelectedState("default");
    // The key represents the state IDs common to the current page selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableStateKey, pagesLoaded, selectedState]);

  return (
    <div>
      <SectionIntro title="Runs & results">
        Start a QA run, compare past runs by date, then review product findings. Harness failures are grouped separately so a broken dependency never looks like dozens of app defects.
      </SectionIntro>

      <div className="dr-sec card">
        <div className="dr-card-heading">
          <div>
            <b>Start a run</b>
            <p>Select pages and viewports. Gated mode shows the exact plan before anything executes.</p>
          </div>
        </div>
        <div className="dr-rowwrap" role="group" aria-label="Pages to run" style={{ marginBottom: 8 }}>
          {pages.map((p) => (
            <button key={p.id} className={"chip click dr-label-chip" + (selectedPages.has(p.id) ? " ink active" : "")}
              aria-pressed={selectedPages.has(p.id)}
              onClick={() => setSelectedPages((s) => { const n = new Set(s); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}>
              {p.title}
            </button>
          ))}
        </div>
        {selectedPageDefinitions.length > 0 && availableStates.length > 1 && (
          <div className="dr-run-state">
            <label htmlFor="dr-run-state">UI state</label>
            <select id="dr-run-state" value={selectedState} onChange={(event) => setSelectedState(event.target.value)}>
              {availableStates.map((state) => <option key={state} value={state}>{state === "default" ? "Default page state" : state}</option>)}
            </select>
            <span className="dr-help-inline">
              Named states run only checks authored for that condition. With several pages selected, only states shared by every page are offered.
            </span>
          </div>
        )}
        {selectedPageDefinitions.length > 1 && availableStates.length === 1 && (
          <div className="dr-run-state">
            <span className="dr-help-inline">These pages do not share a named state, so this run uses each page’s default checks.</span>
          </div>
        )}
        <div className="dr-rowwrap" role="group" aria-label="Viewports to run" style={{ marginBottom: 8 }}>
          {VIEWPORTS.map((v) => (
            <button key={v.id} className={"chip click" + (selectedViewports.has(v.id) ? " sage active" : "")}
              aria-pressed={selectedViewports.has(v.id)}
              onClick={() => setSelectedViewports((s) => { const n = new Set(s); n.has(v.id) ? n.delete(v.id) : n.add(v.id); return n; })}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="dr-actions dr-run-launch-actions">
          <button className="btn primary" disabled={running || watchRunId !== null} onClick={() => startRun()}>
            {running ? (phase ?? "Starting…") : watchRunId ? "Run in progress…" : "Run selected"}
          </button>
          <AppStatusChip />
        </div>
      </div>

      {watchRunId && (
        <LiveRunPanel runId={watchRunId} startedAt={watchStartedAt} onFinished={onWatchedRunFinished} />
      )}

      <div className="dr-sec card">
        <div className="dr-card-heading">
          <div>
            <b>Run history</b>
            <p>Newest first. “Incomplete” means the harness failed; it does not mean the app failed.</p>
          </div>
          <span className="chip">{runs.length} run{runs.length === 1 ? "" : "s"}</span>
        </div>
        {!runsLoaded ? (
          <div className="dr-empty">Loading run history…</div>
        ) : runs.length === 0 ? (
          <div className="dr-empty">No runs yet. Choose coverage above to create the first one.</div>
        ) : (
          <>
            <div className="dr-tablewrap">
              <table className="dr-table dr-history-table">
                <thead>
                  <tr><th>Date</th><th>Type</th><th>Coverage</th><th>Duration</th><th>Outcome</th><th /></tr>
                </thead>
                <tbody>
                  {visibleRuns.map((summary) => {
                    const split = splitRunIssues(summary);
                    const summaryActiveFindings = activeProductFindings(summary, split.productFindings);
                    const summaryInfraCount = split.infraErrors.reduce((total, item) => total + (item.count ?? 1), 0);
                    const verdict = runVerdict(summary);
                    const coverage = summary.selection?.pageIds.length ?? new Set(summary.pages.map((p) => p.pageId)).size;
                    const plannedChecks = summary.plannedChecks ?? summary.pages.length;
                    const executedChecks = summary.executedChecks ?? summary.pages.length;
                    return (
                      <tr key={summary.id} className={run?.id === summary.id ? "is-selected" : ""}>
                        <td data-label="Date">
                          <b>{formatDate(summary.startedAt)}</b>
                          <span className="mono dr-run-id">{summary.id}</span>
                        </td>
                        <td data-label="Type">
                          {summary.contextTag === "drill-adversarial" ? "Adversarial" : "Standard"}
                          {summary.state !== "default" && <span className="dr-count">State: {summary.state}</span>}
                        </td>
                        <td data-label="Coverage">
                          {coverage} page{coverage === 1 ? "" : "s"} · {executedChecks}/{plannedChecks} check{plannedChecks === 1 ? "" : "s"} executed
                        </td>
                        <td data-label="Duration">{formatDuration(summary.startedAt, summary.endedAt)}</td>
                        <td data-label="Outcome">
                          <span className={`chip ${verdict === "Passed" ? "sage" : verdict === "Findings" ? "alarm" : verdict === "Incomplete" ? "brass" : ""}`}>
                            {verdict}
                          </span>
                          {summaryActiveFindings.length > 0 && <span className="dr-count">{summaryActiveFindings.length} finding{summaryActiveFindings.length === 1 ? "" : "s"}</span>}
                          {summaryInfraCount > 0 && <span className="dr-count">{summaryInfraCount} infra-affected</span>}
                        </td>
                        <td data-label="">
                          <div className="dr-actions">
                            <button className="btn small" onClick={() => {
                              setError(null);
                              setNotice(null);
                              void openRun(summary.id);
                            }}>
                              {run?.id === summary.id ? "Selected" : "View"}
                            </button>
                            {deleteArm === summary.id ? (
                              <>
                                <button className="btn small" style={{ color: "var(--alarm)", borderColor: "var(--alarm)" }} onClick={() => void deleteRun(summary.id)}>Delete</button>
                                <button className="btn small" onClick={() => setDeleteArm(null)}>Keep</button>
                              </>
                            ) : (
                              <button className="dr-xbtn" aria-label={`Delete run ${summary.id}`} title="Delete this run and its results" onClick={() => setDeleteArm(summary.id)}><X size={13} /></button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {historyPages > 1 && (
              <div className="dr-pagination" role="navigation" aria-label="Run history pages">
                <button className="btn small" disabled={historyPage === 0} onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}>Previous</button>
                <span>Page {historyPage + 1} of {historyPages}</span>
                <button className="btn small" disabled={historyPage + 1 >= historyPages} onClick={() => setHistoryPage((p) => Math.min(historyPages - 1, p + 1))}>Next</button>
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <div className="dr-inline-error dr-results-error" role="alert">
          <span>{error}</span>
          <button className="btn small" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {notice && (
        <div className="dr-notice dr-results-notice" role="status">
          <span>{notice}</span>
          <button className="btn small" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {pendingGate && (
          <div className="dr-sec card" role="region" aria-label="Gated run plan" style={{ borderColor: "var(--brass)", borderWidth: 1.5 }}>
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

      {run && run.id !== watchRunId && (() => {
        // While the watched run executes, the live panel IS its detail -
        // rendering the (still-empty) record below it reads as "0 passed,
        // review the infrastructure section" mid-run, which is misleading.
        const showDebrief = debriefAvailable && !classicView;
        return (
          <>
            {debriefAvailable && (
              <div className="dr-db-modeswitch" role="group" aria-label="Run detail view">
                <span className="dr-db-modeswitch-label">View</span>
                <button
                  className={"btn small" + (showDebrief ? " primary" : "")}
                  aria-pressed={showDebrief}
                  onClick={() => setClassicView(false)}
                >
                  <LayoutGrid size={12} /> Debrief
                </button>
                <button
                  className={"btn small" + (!showDebrief ? " primary" : "")}
                  aria-pressed={!showDebrief}
                  onClick={() => setClassicView(true)}
                >
                  Classic view
                </button>
              </div>
            )}
            {showDebrief ? (
              <DebriefView
                run={run}
                pages={pages}
                steps={debriefSteps}
                evidenceIndex={evidenceIndex}
                issues={issues}
                activeFindings={activeFindings}
                confirmedCount={confirmedCount}
                dispatchableCount={dispatchableCount}
                dispatchedCard={dispatchedCard}
                dispatchMode={dispatchMode}
                setDispatchMode={setDispatchMode}
                dispatching={dispatching}
                dispatch={dispatch}
                triage={triage}
              />
            ) : (
              <ClassicRunDetail
                run={run}
                pages={pages}
                evidenceRows={evidenceRows}
                productPageEntries={productPageEntries}
                activeFindings={activeFindings}
                incompleteCoverageCount={incompleteCoverageCount}
                displayedInfra={displayedInfra}
                issues={issues}
                confirmedCount={confirmedCount}
                dispatchableCount={dispatchableCount}
                dispatchedCard={dispatchedCard}
                dispatchMode={dispatchMode}
                setDispatchMode={setDispatchMode}
                dispatching={dispatching}
                obsText={obsText}
                setObsText={setObsText}
                giveFeedback={giveFeedback}
                override={override}
                addObs={addObs}
                convertObsToStep={convertObsToStep}
                convertObsToFinding={convertObsToFinding}
                triage={triage}
                dispatch={dispatch}
              />
            )}
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
  referenceSource?: { runId: string; stepId: string; viewportId: string; at: string };
}

function describeStateMatcher(state: DrillStateFull) {
  const assertion = state.matcher?.assertion;
  if (assertion && typeof assertion === "object") {
    const value = assertion as Record<string, unknown>;
    if (value.kind === "text-contains" && value.text) {
      return `text “${String(value.text)}” is present`;
    }
    if (value.kind === "url-matches" && value.pattern) {
      return `the URL matches “${String(value.pattern)}”`;
    }
    const target = value.testId
      ? `the “${String(value.testId)}” element`
      : value.role
        ? `the ${String(value.role)}${value.name ? ` named “${String(value.name)}”` : ""}`
        : "the selected element";
    if (value.kind === "visible") return `${target} is visible`;
    if (value.kind === "count" && value.value !== undefined) {
      return `${target} count is ${String(value.op ?? "eq")} ${String(value.value)}`;
    }
    if (value.kind === "attribute-equals" && value.attribute) {
      return `${target} has ${String(value.attribute)} = “${String(value.value ?? "")}”`;
    }
    return "a deterministic page check";
  }
  if (state.fingerprint) {
    const signalCount = state.fingerprint.shapeSketch.split(",").filter(Boolean).length;
    return `visual structure around heading “${state.fingerprint.headingText || "(none)"}” (${signalCount} signals)`;
  }
  return "Not configured yet";
}

function StateReferenceImage({
  state,
  pageId,
  scopedSteps,
  onPrepareRun,
  onOpenAuthoring
}: {
  state: DrillStateFull;
  pageId: string;
  scopedSteps: Step[];
  onPrepareRun: (pageId: string, stateId: string, viewportId: string) => void;
  onOpenAuthoring: (pageId: string) => void;
}) {
  const source = state.screenshotPath ? `/api/states/${pageId}/${state.id}/screenshot` : null;
  const imageUrl = useFetchedImage(source, source ? `/api/states/${pageId}/${state.id}/screenshot-status` : null);

  if (imageUrl) {
    return (
      <img
        alt={`${state.label} state reference`}
        src={imageUrl}
        className="dr-state-image"
      />
    );
  }
  if (imageUrl === undefined) {
    return <div className="dr-state-image-missing" role="status">Loading recorded reference…</div>;
  }

  const stale = !!state.screenshotPath;
  const viewportId = scopedSteps.flatMap((step) => step.viewports ?? [])[0] ?? "desktop";
  return (
    <div className="dr-state-image-missing" role="status">
      <span>
        {stale
          ? "The recorded reference image is no longer available. Its source metadata is kept below."
          : "No reference image yet. The first successful named-state run will capture it automatically."}
      </span>
      {scopedSteps.length > 0 ? (
        <button className="btn small" onClick={() => onPrepareRun(pageId, state.id, viewportId)}>
          Prepare reference run
        </button>
      ) : (
        <button className="btn small" onClick={() => onOpenAuthoring(pageId)}>
          Add state checks in Authoring
        </button>
      )}
    </div>
  );
}

function StatesView({
  onViewResults,
  onPrepareRun,
  onOpenAuthoring
}: {
  onViewResults: (runId?: string | null) => void;
  onPrepareRun: (pageId: string, stateId: string, viewportId: string) => void;
  onOpenAuthoring: (pageId: string) => void;
}) {
  const [pages, setPages] = useState<DrillPage[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    apiGet("/api/pages").then((r) => {
      setPages(r.pages);
      if (!pageId && r.pages.length > 0) setPageId(r.pages[0].id);
    }).catch((e) => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only fetch
  useEffect(load, []);

  const page = pages.find((p) => p.id === pageId) ?? null;

  if (error) return <div className="dr-placeholder">{error} <button className="btn small" onClick={() => setError(null)}>dismiss</button></div>;
  if (!page) return <div className="dr-placeholder">No pages yet - plan the Book (Drill Book tab) or add a page in Authoring first.</div>;

  const states: DrillStateFull[] = (page.states as unknown as DrillStateFull[]) ?? [];

  return (
    <div>
      <SectionIntro title="Page states">
        States are recognizable UI conditions such as “empty”, “loading”, or “completed”. The planning agent defines and captures them; you review the reference, recognition rule, and checks that depend on each state.
      </SectionIntro>

      <div className="dr-sec dr-state-toolbar">
        <select aria-label="Page whose states are shown" value={pageId ?? ""} onChange={(e) => setPageId(e.target.value)} style={{ fontSize: 12, padding: "5px 8px", border: "1px solid var(--rule)" }}>
          {pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
        <span className="dr-help-inline">Showing state references for this Book page.</span>
      </div>

      <div className="dr-sec dr-state-explainer">
        <b>Reference images are automatic.</b>
        <span>
          The first successful run of a named state stores its evidence here. There is no separate snapshot step for you to operate while an agent is running.
        </span>
        <button className="btn small" onClick={() => onViewResults(null)}>Open runs</button>
      </div>

      <div className="dr-sec">
        <div className="dr-card-heading">
          <div>
            <b>Named states</b>
            <p>Each state combines a visual reference, a matcher, and the path the agent follows to reach it.</p>
          </div>
          <span className="chip">{states.length}</span>
        </div>
        <div className="dr-state-grid">
          {states.length === 0 && (
            <div className="dr-empty">
              No states have been authored for this page. This is valid for a static page; the planning agent adds states when checks depend on changing UI conditions.
            </div>
          )}
          {states.map((s) => {
            const scopedSteps = page.steps.filter((step) => step.state === s.id);
            return (
            <article key={s.id} className="card dr-state-card">
              <div className="dr-rowwrap" style={{ marginBottom: 6 }}>
                <span className="chip brass active dr-label-chip">{s.label}</span>
              </div>
              <StateReferenceImage
                key={`${pageId}:${s.id}:${s.screenshotPath ?? ""}`}
                state={s}
                pageId={pageId!}
                scopedSteps={scopedSteps}
                onPrepareRun={onPrepareRun}
                onOpenAuthoring={onOpenAuthoring}
              />
              <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
                <b>Recognized by:</b> {describeStateMatcher(s)}
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-2)" }}>
                <b>Agent reaches it:</b> {s.reachPath && s.reachPath.length > 0 ? s.reachPath.map((r) => r.description).join(" → ") : "At page entry"}
              </div>
              <div style={{ fontSize: 10, color: "var(--mute)", marginTop: 4 }}>
                {scopedSteps.length} scoped steps
              </div>
              {s.referenceSource && (
                <button className="dr-state-source" onClick={() => onViewResults(s.referenceSource!.runId)}>
                  View source run · {formatDate(s.referenceSource.at)} · {s.referenceSource.viewportId} · {s.referenceSource.stepId}
                </button>
              )}
            </article>
          )})}
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
  const initialLocation = () => {
    const params = new URLSearchParams(location.search);
    const candidate = params.get("view");
    return {
      view: VIEWS.some((v) => v.id === candidate) ? candidate! : "book",
      pageId: params.get("page"),
      runId: params.get("run")
    };
  };
  const initial = initialLocation();
  const [view, setView] = useState(initial.view);
  const [authorPageId, setAuthorPageId] = useState<string | null>(initial.pageId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initial.runId);
  const [pendingRun, setPendingRun] = useState<{ pageIds: string[]; viewports: string[] } | null>(null);
  const [pendingRunSelection, setPendingRunSelection] = useState<{ pageId: string; state: string; viewportId: string } | null>(null);
  const [projInfo, setProjInfo] = useState<ProjectsInfo | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    apiGet("/api/projects").then((r) => {
      setProjInfo(r);
      // Fresh install / nothing selected: the choice IS the first step, so
      // put the picker front and center rather than a corner dropdown.
      if (!r.selected) setPickerOpen(true);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const onPop = () => {
      const next = initialLocation();
      setView(next.view);
      setAuthorPageId(next.pageId);
      setSelectedRunId(next.runId);
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const navigate = (nextView: string, options: { pageId?: string | null; runId?: string | null } = {}) => {
    const params = new URLSearchParams();
    params.set("view", nextView);
    const nextPage = options.pageId !== undefined ? options.pageId : (nextView === "authoring" ? authorPageId : null);
    const nextRun = options.runId !== undefined ? options.runId : (nextView === "results" ? selectedRunId : null);
    if (nextPage) params.set("page", nextPage);
    if (nextRun) params.set("run", nextRun);
    history.pushState({}, "", `${location.pathname}?${params.toString()}`);
    setView(nextView);
    if (options.pageId !== undefined) setAuthorPageId(options.pageId);
    if (options.runId !== undefined) setSelectedRunId(options.runId);
  };
  const runSelected = (pageIds: string[], viewports: string[]) => {
    setPendingRun({ pageIds, viewports });
    navigate("results");
  };
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % VIEWS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + VIEWS.length) % VIEWS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = VIEWS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextView = VIEWS[nextIndex];
    if (nextView.id !== view) navigate(nextView.id);
    requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus());
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
        <div className="dr-tabs" role="tablist" aria-label="Drill sections">
          {VIEWS.map((v, index) => (
            <button
              key={v.id}
              ref={(node) => { tabRefs.current[index] = node; }}
              role="tab"
              aria-selected={view === v.id}
              tabIndex={view === v.id ? 0 : -1}
              className={"dr-tab" + (view === v.id ? " on" : "")}
              onClick={() => navigate(v.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className="dr-body">
        {view === "book" && <BookView onRunSelected={runSelected} projInfo={projInfo} onOpenPicker={() => setPickerOpen(true)} onGoAuthoring={(pageId) => navigate("authoring", { pageId: pageId ?? null })} />}
        {view === "authoring" && (
          <AuthoringView
            initialPageId={authorPageId}
            onPageChange={(pageId) => {
              setAuthorPageId(pageId);
              const params = new URLSearchParams(location.search);
              params.set("view", "authoring");
              params.set("page", pageId);
              history.replaceState({}, "", `${location.pathname}?${params.toString()}`);
            }}
          />
        )}
        {view === "states" && (
          <StatesView
            onViewResults={(runId) => navigate("results", { runId: runId ?? null })}
            onPrepareRun={(pageId, state, viewportId) => {
              setPendingRunSelection({ pageId, state, viewportId });
              navigate("results", { runId: null });
            }}
            onOpenAuthoring={(pageId) => navigate("authoring", { pageId })}
          />
        )}
        {view === "results" && (
          <ResultsView
            initialRun={pendingRun}
            onConsumeInitialRun={() => setPendingRun(null)}
            initialSelection={pendingRunSelection}
            onConsumeInitialSelection={() => setPendingRunSelection(null)}
            initialRunId={selectedRunId}
            onRunViewed={(runId) => {
              setSelectedRunId(runId);
              const params = new URLSearchParams(location.search);
              params.set("view", "results");
              params.set("run", runId);
              history.replaceState({}, "", `${location.pathname}?${params.toString()}`);
            }}
          />
        )}
      </div>
      {pickerOpen && projInfo && <ProjectPickerDialog info={projInfo} onClose={() => setPickerOpen(false)} />}
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

import { useState } from "react";
import {
  Check, X, Plus, Crosshair, Play, Camera, Smartphone, Tablet, Monitor,
  NotebookPen, AlertTriangle, Wrench, ChevronRight, Eye, FileCode2
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// DRILL - annotated mock v0.5. This artifact IS the working spec and ledger.
// Supersedes drill-design-draft.md. Garrison tokens from src/app/globals.css.
// v0.3: real CSS + media queries (artifact runtime has no Tailwind compiler,
// so arbitrary classes in v0.2 silently failed). Annotations: side column on
// wide screens, bottom sheet on tapped markers for mobile.
// ─────────────────────────────────────────────────────────────────────────────

const T = {
  paper: "#fbf8f1", paper2: "#f4ede0", paper3: "#ece2cc",
  ink: "#18211c", ink2: "#2a342e", mute: "#66695f", mute2: "#7d8077",
  sage: "#2f4a3a", sage2: "#3d6249", sageSoft: "#eaf1e7",
  brass: "#b4862a", brass2: "#d8a82e", brassSoft: "#f6ecd0",
  rule: "#d6cdba", rule2: "#c4b89f",
  alarm: "#9b362d", alarmSoft: "#f7eae6",
  warn: "#b07215",
  ext: "#33506b", extSoft: "#e8eef5"
};

const KINDS = {
  reuse:    { label: "REUSE",    fg: T.sage,  bg: T.sageSoft,  br: T.sage2 },
  new:      { label: "NEW",      fg: T.brass, bg: T.brassSoft, br: T.brass },
  ext:      { label: "EXT",      fg: T.ext,   bg: T.extSoft,   br: T.ext },
  replaces: { label: "REPLACES", fg: T.alarm, bg: T.alarmSoft, br: T.alarm },
  decision: { label: "DECISION", fg: T.ink,   bg: T.paper3,    br: T.rule2 }
};

const A = {
  book: [
    { id: "A1", kind: "new", title: "Drill Book lives in the target app repo",
      body: "drills/drillbook.yml plus drills/pages/*.yml, diffable and PR reviewable. Git diff maps changed files to pages and pre-selects them for the next run.",
      spec: "S11 S12 S13, R6" },
    { id: "A2", kind: "reuse", title: "Store pattern from automations",
      body: "YAML per entity, strict id sanitizing, atomic writes. Same conventions, different root (repo instead of ~/.garrison).",
      src: "fittings/seed/automations/lib/store.mjs" },
    { id: "A3", kind: "new", title: "Full Drill toggle and per-page override",
      body: "Full Drill selects every page. Per page, mode can override to whole-page vision: one exploratory charter per page per state (Q4), instead of step by step.",
      spec: "S15" },
    { id: "A4", kind: "new", title: "Viewport matrix",
      body: "Named presets (desktop, tablet, mobile). A run executes selected steps once per selected viewport. Engine delta: device emulation per run.",
      spec: "S19, delta 3 and 6" },
    { id: "A5", kind: "new", title: "Autonomy per invocation",
      body: "Gated: plan diff shown, run starts after approval. Autonomous: plan applied, run starts, results reported. The gate lives in the duty layer, not in a subagent.",
      spec: "S22, R7" },
    { id: "A6", kind: "new", title: "Testing-only task",
      body: "Creates a Kanban card that enters the roster at the drill duty directly, skipping plan, implement and review. See the Garrison tab.",
      spec: "S27" },
    { id: "A7", kind: "decision", title: "Roadmap 2026-05-06 already settled the shape",
      body: "Testing and Automations are separate faculties. Testing consumes automation-runner. Automations grows progressable steps, feedback, video recording. Drill is that testing faculty, made concrete.",
      src: "docs/GARRISON_ROADMAP.md (Testing and Validation entry)", spec: "S23, R2" },
    { id: "A8", kind: "reuse", title: "Run records stay engine-owned",
      body: "Runs persist under ~/.garrison/automations/runs with SSE streaming. The Book links to them; it does not duplicate them.",
      src: "fittings/seed/automations/lib/engine.mjs" },
    { id: "A9", kind: "new", title: "Global rules feed every planner and reviewer call",
      body: "App-specific truths (citations required, PT-PT copy, no console errors) become standing constraints for step design and UX review.",
      spec: "S1 S12" }
  ],
  authoring: [
    { id: "B1", kind: "reuse", title: "Screencast canvas with input sync",
      body: "The app renders through the browser fitting's per-tab JPEG screencast with mouse, key and touch dispatch. Drill does not iframe the app.",
      src: "fittings/seed/browser-default (port 7084)", spec: "S3, R4" },
    { id: "B2", kind: "ext", title: "Picker: CDP Overlay plus @medv/finder",
      body: "Hover-highlight-snap uses the CDP DOM and Overlay domains through the browser fitting's CDP passthrough, the same mechanism as devtools inspect. @medv/finder (MIT) runs injected to generate short stable selectors, biased to data-testid, role and aria-label.",
      spec: "S17" },
    { id: "B3", kind: "new", title: "Areas: multi-anchor, percentage rects, stable ids",
      body: "Each area stores testId, css, xpath and text anchors, resolved in order with fuzzy fallback (SitePing and W3C Web Annotation pattern). Rects are percentages of the anchor box so badges survive responsive layouts. Id is page#area, referenceable from any page.",
      spec: "S4 S16" },
    { id: "B4", kind: "new", title: "Badges drawn over the canvas, not injected",
      body: "Numbered highlights use element geometry from CDP getBoxModel, drawn in Drill's own layer. The app under test stays unpolluted.",
      spec: "S4, R4" },
    { id: "B5", kind: "new", title: "Step controls",
      body: "Checkbox enables or disables. Cross removes. Plus adds a step to the area or a page-level step. New area via the pick button.",
      spec: "S5 S6 S7" },
    { id: "B6", kind: "reuse", title: "Execution: compile to engine steps",
      body: "Enabled steps compile to navigate, browser and verify steps and run as an ephemeral inline engine run (engine delta 1). Cache hit replays with no model call; miss falls to vision through the Model Router; result written back.",
      src: "fittings/seed/automations/lib/browser-orchestrator.mjs", spec: "R3" },
    { id: "B7", kind: "reuse", title: "Self-healing on failures",
      body: "The fixer proposes one budget-capped patch (insert, replace, skip, pause, abort) and pauses immediately on CAPTCHA, MFA or payment. Fenced to page-repair step types.",
      src: "fittings/seed/automations/lib/fixer.mjs" },
    { id: "B8", kind: "new", title: "Vision graduates to e2e",
      body: "After a vision run, cached actions (already Playwright shaped: selector, role, testId, label, placeholder, text) and cached assertions are emitted as a readable spec block in tests/drills/<page>.spec.ts. The toggle flips to e2e. Judgment assertions that cannot be made deterministic emit as a drillJudge() helper that calls the Model Router inside the spec (Q3), so those steps graduate too. On later e2e failure the healer re-runs that step in vision, repairs and re-emits.",
      src: "locator ladder: fittings/seed/browser-default/scripts/server.mjs", spec: "S8 S9 S10, delta 2" },
    { id: "B9", kind: "new", title: "Vision or e2e chosen sensibly at plan time",
      body: "The Drill planner (same Router-routed pattern as the automations planner) marks a step e2e when deterministic locators and assertions are evident, vision when judgment is needed (citation quality, generative output, canvas).",
      src: "pattern: fittings/seed/automations/lib/planner.mjs + discuss.mjs", spec: "S2 S9" },
    { id: "B10", kind: "new", title: "Cross-page reference chips",
      body: "kb#entry-detail in a step description resolves to that page and area. Tap navigates the plan there. Runner navigation across refs is a later slice.",
      spec: "S16, Q2" },
    { id: "B11", kind: "new", title: "State strip scopes the plan",
      body: "A page has states (default, building, complete). Steps and areas can be scoped to a state. Selecting a state swaps the authoring surface to that state's reference screenshot. Full detail in the States tab.",
      spec: "S24" },
    { id: "B12", kind: "new", title: "Richer deterministic assertions",
      body: "verify grows text contains, count, visible, url matches, attribute equals, so more checks graduate out of vision. Engine delta 5, ships to Ekoa.",
      spec: "S23, delta 5" }
  ],
  states: [
    { id: "C1", kind: "new", title: "States are first-class",
      body: "A page state = id, label, reference screenshot, matcher, reach path. Steps and areas carry an optional state scope. Example: an Ekoa build page differs completely at start, midway and finished.",
      spec: "S24" },
    { id: "C2", kind: "reuse", title: "Fingerprint discriminates states",
      body: "The existing page fingerprint (title hash, heading hash, DOM-shape counts, viewport) already separates structurally different renderings of one URL. It becomes the cheap layer of the state matcher.",
      src: "fittings/seed/automations/lib/fingerprint.mjs" },
    { id: "C3", kind: "reuse", title: "Snapshots come from observe",
      body: "Every vision step already observes the page (screenshot plus fingerprint parts). Drill keeps these as snapshots on the run timeline at no extra cost.",
      src: "browser-default /tabs/:id/observe?screenshot=1" },
    { id: "C4", kind: "new", title: "Promote a snapshot to a named state",
      body: "Human or agent picks a snapshot and names it. Its screenshot becomes an authoring surface: areas can be drawn on it even when the live app is not in that state. Anchors were captured from the live DOM at snapshot time, so they still resolve during runs. Storage: state metadata (matcher, reach path) lives in the repo YAML; screenshot files stay machine-local as plain files with links, viewed in the File Browser, re-capturable on any machine via the reach path (Q8).",
      spec: "S24" },
    { id: "C5", kind: "new", title: "Reach path",
      body: "Ordered step refs that put the page into the state (start a build, wait for progress). Compiled as normal engine steps before scoped steps run. The action cache makes reaching cheap after the first time.",
      spec: "S24, R3" },
    { id: "C6", kind: "new", title: "Matcher ladder",
      body: "Deterministic assertion first, fingerprint similarity second, vision verify last. Same graduation story as steps: vision matches get cached as assertions.",
      spec: "S24, Q7" },
    { id: "C7", kind: "ext", title: "Optional visual regression per state",
      body: "BackstopJS or Lost Pixel per state per viewport as an extra step type. Later slice, not gating.",
      spec: "S19" }
  ],
  results: [
    { id: "D1", kind: "reuse", title: "Live run view over SSE",
      body: "run_step, run_patch, run_pause_for_user and friends stream from the engine. Drill's results surface is a richer skin over the same events and run records.",
      src: "fittings/seed/automations/lib/engine.mjs + dist run viewer" },
    { id: "D2", kind: "reuse", title: "Tier badges",
      body: "cached, vision, recovered come straight from the orchestrator result. They tell you what the run cost and how stable the step is.",
      src: "browser-orchestrator.mjs" },
    { id: "D3", kind: "new", title: "Evidence per step",
      body: "Screenshot on completion attached to the step result (engine delta 7), written as plain files with links under the run record and viewed in the File Browser (artifact store is retired, Q8). Video recording lands in automations the same way. This evidence replaces the walkthrough duty's narrated video.",
      spec: "S25 S26, delta 7" },
    { id: "D4", kind: "new", title: "Feedback on any result, pass or fail",
      body: "A note on any step result, no re-run needed. Stored on the run record, it feeds the next plan revision (rewording, new steps, tighter assertions) the same way improver feedback flows.",
      spec: "S25 S28" },
    { id: "D5", kind: "new", title: "Mark failed: verdict override",
      body: "Human or agent flips a verdict in either direction, with a note. A pass you know is wrong becomes a failed finding even though the test did not catch it, and the next plan revision tightens that step's assertions so the suite catches it next time.",
      spec: "S27 S28" },
    { id: "D6", kind: "reuse", title: "Dispatch rides the Kanban loop",
      body: "Nothing creates cards mid-run. Dispatch happens from the report: confirmed findings become one batch fix card by default (split into separate cards available), via the existing kanban-loop fitting.",
      src: "fittings/seed/kanban-loop", spec: "S29, R10" },
    { id: "D7", kind: "new", title: "UX review findings",
      body: "A distinct pass producing suggestions, not gates. Skill encodes Nielsen's 10 heuristics, WCAG 2.2 quick checks, responsive sanity and the app's global rules. Findings attach to areas, rank by severity, and feed the report like everything else.",
      spec: "S20 S29" },
    { id: "D8", kind: "replaces", title: "Validation phase retired",
      body: "Run verdicts plus human feedback ARE the validation. The separate validation phase on Garrison is removed once drill is in the roster.",
      spec: "S26" },
    { id: "D9", kind: "new", title: "Run-level observations",
      body: "Free-form notes for things no step covers (sources panel flickered during streaming). The agent converts an observation into a draft step in the plan, and into a finding when it is a bug. Recording it never requires a re-run.",
      spec: "S28" },
    { id: "D10", kind: "new", title: "Findings report: triage, then batch fix",
      body: "Failures, flipped verdicts, accepted UX findings and observations pool into the run report as findings: proposed, confirmed or dismissed. Fix all confirmed dispatches one batch fix task carrying the report. Dispatch modes: Manual (the button), Heartbeat (the autonomous flow confirms high-confidence findings itself and picks them up on its next beat), Immediate as opt-in.",
      spec: "S29, R10" }
  ],
  mobile: [
    { id: "E1", kind: "new", title: "FAB toggles the plan overlay",
      body: "Canvas full screen. The floating button opens the plan as a sheet and closes it.",
      spec: "S18" },
    { id: "E2", kind: "new", title: "Pick flow on touch",
      body: "The highlight button closes the sheet, enters pick mode on the canvas (CDP overlay follows touch, snap targets enlarged), and reopens the sheet with the new area ready for steps.",
      spec: "S17 S18" },
    { id: "E3", kind: "new", title: "Drill UI is itself responsive",
      body: "Same PWA posture as voice: usable from the phone against the GCP or Tailscale machine.",
      spec: "S18" },
    { id: "E4", kind: "new", title: "Viewports are the responsive tests",
      body: "The same steps compile per selected viewport. Mobile and tablet failures show as separate results in the matrix.",
      spec: "S19, delta 3 and 6" }
  ],
  garrison: [
    { id: "F1", kind: "new", title: "One duty, two stages, a gate between",
      body: "drill slots after review. Stage 1 plans or updates the plan. The configurable gate sits before stage 2 (run). Gated pauses for approval; autonomous proceeds.",
      spec: "S21 S22, R7" },
    { id: "F2", kind: "replaces", title: "duty-walkthrough retired",
      body: "Walkthrough's narrated video evidence is subsumed by per-step evidence plus automations-grown video recording (roadmap). The scrubbable-evidence job moves into drill results.",
      src: "fittings/seed/duty-walkthrough", spec: "S26" },
    { id: "F3", kind: "replaces", title: "Validation phase retired",
      body: "See D8. Drill run verdicts and feedback are the validation output.",
      spec: "S26" },
    { id: "F4", kind: "new", title: "Testing-only tasks",
      body: "A card created as Test enters the roster at drill directly. Failures spawn Fix cards that go through the normal pipeline. Both human and agent can mark failed.",
      spec: "S27" },
    { id: "F5", kind: "decision", title: "duty-test stays",
      body: "The fast per-change gate (committed test, build, typecheck, lint) is unchanged. Drill is the plan-driven page-level QA pass. R8 carried.",
      src: "fittings/seed/duty-test", spec: "R8" },
    { id: "F6", kind: "new", title: "Engine deltas: the Ekoa payoff",
      body: "1 inline ephemeral runs. 2 spec emission from cache. 3 viewport emulation. 4 step enable flags and tags. 5 richer assertions. 6 run matrices. 7 evidence capture. All general automations features, all portable to Ekoa.",
      spec: "S23" },
    { id: "F7", kind: "reuse", title: "Packaging like automations",
      body: "apm.yml with x-garrison block, own-port plugin shape, provides duty drill plus its UI surface, consumes automation-runner and the browser fitting.",
      src: "fittings/seed/automations/apm.yml" },
    { id: "F8", kind: "replaces", title: "Adversarial pass absorbs duty-adversarial-test",
      body: "Adversarial testing is a second drill run configured in the composition to a different model. Decorrelation rules carried from the skill: the pass is blind (receives only areas and acceptance-level step descriptions, never the emitted specs or cached actions), runs vision-forced with the cache ignored, and writes its own probes. Its findings join the same report.",
      src: "fittings/seed/duty-adversarial-test", spec: "Q6, R12" },
    { id: "F9", kind: "decision", title: "Skill conventions carried into the drill skill",
      body: "From garrison-test and garrison-adversarial-test: policy-read preamble (policy.json is the single authority in a run; standalone proceeds with defaults, never stops); GATE lines and durable gate-status records including which model drove; findings must be reproducible, never an impression (a fail carries the probe or exact commands plus output); deterministic wall first (cheapest checks before any model judgment, so drill orders deterministic steps before vision within a run); loaded-machine waits (generous boot/login waits baked into emitted specs; a pure timeout re-runs once in isolation and fixes the wait, not the verdict); flaky or env failures re-run and never consume the fix budget; never clobber a live dev server.",
      src: "duty-test + duty-adversarial-test SKILL.md", spec: "Q6" }
  ],
  ledger: []
};

const SPECS = [
  ["S1", "Thorough, domain-aware testing (citations from KB, sources, artifact builds, progress info)", "Book, Authoring"],
  ["S2", "Plan explains everything, every step, in detail", "Authoring"],
  ["S3", "App left, plan column right at about a quarter width", "Authoring"],
  ["S4", "Numbered highlighted areas grouping what is tested there", "Authoring"],
  ["S5", "Per-step checkbox to disable and cross to remove", "Authoring"],
  ["S6", "Add steps to an area; highlight new areas", "Authoring"],
  ["S7", "Page-level steps not tied to an area", "Authoring"],
  ["S8", "Companion Playwright suite; per-step vision or e2e toggle", "Authoring"],
  ["S9", "Sensible initial choice of e2e vs vision per step", "Authoring"],
  ["S10", "Vision run emits detailed e2e test and flips the toggle", "Authoring, Results"],
  ["S11", "Drill Book as ledger; suite built progressively", "Book"],
  ["S12", "Overall area: page selection per run, global notes and rules", "Book"],
  ["S13", "Changes update the plan for everything related, toggles set sensibly", "Book, Garrison"],
  ["S14", "Invoked after change and review so the human can approve or edit; multi-page selection", "Garrison"],
  ["S15", "Full Drill toggle; per-page whole-page-vision override", "Book"],
  ["S16", "Cross-page area references with stable page#area ids", "Authoring"],
  ["S17", "Picker like the Claude design selector, sensible snapping, proven OSS", "Authoring, Mobile"],
  ["S18", "Mobile: FAB overlay, highlight button flow", "Mobile"],
  ["S19", "Responsive testing across mobile, tablet, desktop", "Book, Mobile"],
  ["S20", "UI/UX expert review with improvement suggestions", "Results"],
  ["S21", "New Garrison fitting, phase after review and before testing", "Garrison"],
  ["S22", "Configurable autonomy: continue or pause for approval", "Book, Garrison"],
  ["S23", "Complements automations; engine improvements ship to Ekoa", "Garrison"],
  ["S24", "Page states; screenshots from runs become authoring surfaces", "States"],
  ["S25", "Results area with per-step results, run notes and feedback", "Results"],
  ["S26", "Replaces the walkthrough and validation phases", "Garrison, Results"],
  ["S27", "Testing-only tasks; human and agent mark failed and send to fix", "Book, Results, Garrison"],
  ["S28", "Feedback on any result and run-level observations, without re-running", "Results"],
  ["S29", "Findings report: confirm or dismiss, then fix all in one batch; heartbeat pickup", "Results"]
];

const DECISIONS = [
  ["R1", "Name: drill. Ledger: Drill Book. Full regression: Full Drill.", "open for confirmation"],
  ["R2", "Separate fitting executing through the automations engine, not a mode. Confirmed by roadmap 2026-05-06.", "settled"],
  ["R3", "Steps compile to ephemeral inline engine runs tagged drill.", "settled"],
  ["R4", "Display via screencast canvas; picker via CDP; badges drawn in Drill's layer.", "settled"],
  ["R5", "Own-port plugin fitting providing the drill duty and UI surface.", "settled"],
  ["R6", "Plans live in the target app repo; run records stay machine-local.", "open: external apps fallback"],
  ["R7", "Duty after review; plan stage, gate, run stage.", "settled"],
  ["R8", "duty-test stays as the fast per-change gate.", "carried"],
  ["R9", "duty-walkthrough and the validation phase are replaced by drill (supersedes the earlier keep-both leaning for walkthrough).", "carried"],
  ["R10", "Findings pool into a run report with triage; batched dispatch (one batch card by default) replaces immediate card creation. Immediate stays as an opt-in dispatch mode.", "carried"],
  ["R11", "State matcher (Q7): a deterministic assertion passing IS a match. Fingerprint pre-filters only: same route pattern plus equal heading hash, or DOM-shape similarity of 0.85 or higher (Jaccard over tag and role counts). Two states clearing the bar, or none, escalates to vision verify; a vision confirmation writes back a deterministic assertion. Ambiguity never guesses.", "new this round"],
  ["R12", "Adversarial testing = a second drill run with a different model set in the composition, blind to specs and cache, vision-forced. duty-adversarial-test retires; its decorrelation and reproducibility rules carry into the drill skill.", "new this round"],
  ["R13", "Artifact store retired in drill scope: evidence, snapshots and videos are plain files with links, browsed in the File Browser. State metadata in repo YAML; screenshots machine-local, re-capturable via reach path.", "new this round"],
  ["R14", "Testing-only card schema (Q9): the card carries a drill block: { book, select: { pages, steps-or-tags, states }, viewports, autonomy, dispatch }. The run report links back with its report id.", "new this round"]
];

const QUESTIONS = [
  ["Q1", "Third-party app fallback → not needed: apps under test are always git repos cloned locally. R6 settled."],
  ["Q2", "Cross-page refs → descriptions plus navigation chips now; runner click-through later. Settled."],
  ["Q3", "Judgment assertions → emit as a drillJudge() helper through the Router; those steps graduate to e2e too."],
  ["Q4", "Whole-page-vision override → one exploratory charter per page per state."],
  ["Q5", "UX review cadence → on demand plus Full Drill."],
  ["Q6", "Adversarial testing → absorbed: a second drill run with a different model via the composition (R12); skill lessons extracted (F9)."],
  ["Q7", "State matcher thresholds → decided in R11: assertion passing is a match; fingerprint pre-filters at 0.85 shape similarity; ambiguity escalates to vision, never guesses."],
  ["Q8", "Storage → artifact store retired; plain files with links via the File Browser (R13)."],
  ["Q9", "Testing-only card schema → decided in R14: a drill block with book, selection, viewports, autonomy, dispatch."]
];

const CSS = `
.dm-root{background:${T.paper};min-height:100vh;color:${T.ink};padding:12px;
  font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;}
@media(min-width:700px){.dm-root{padding:20px 26px;}}
.dm-root *{box-sizing:border-box;}
.dm-h1{font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;margin:0;}
.dm-h1 span{font-family:ui-sans-serif,system-ui,sans-serif;font-weight:400;font-size:12px;color:${T.mute};}
.hdr{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.legend{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.sub{font-size:11px;color:${T.mute};margin-top:4px;}
.dm-tabs{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid ${T.rule};margin:12px 0 16px;
  -webkit-overflow-scrolling:touch;scrollbar-width:none;}
.dm-tabs::-webkit-scrollbar{display:none;}
.dm-tab{padding:8px 13px;font-size:12.5px;font-weight:600;color:${T.mute};border:0;background:none;
  border-bottom:2px solid transparent;white-space:nowrap;cursor:pointer;font-family:inherit;}
.dm-tab.on{color:${T.ink};border-bottom-color:${T.brass};background:${T.paper2};border-radius:7px 7px 0 0;}
.dm-body{display:flex;flex-direction:column;gap:18px;}
.dm-main{min-width:0;}
.dm-notes{display:none;flex-direction:column;gap:8px;}
.dm-notes.open{display:flex;}
@media(min-width:1100px){
  .dm-body{flex-direction:row;align-items:flex-start;}
  .dm-main{flex:1;}
  .dm-notes,.dm-notes.open{display:flex;width:320px;flex:none;position:sticky;top:10px;
    max-height:calc(100vh - 20px);overflow-y:auto;padding-right:2px;}
  .notes-toggle{display:none;}
}
.note{border-radius:9px;padding:9px 11px;background:${T.paper2};border:1px solid ${T.rule};cursor:pointer;}
.note.on{background:#fff;}
.note-h{display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap;}
.note-t{font-size:11.5px;font-weight:700;color:${T.ink};}
.note-b{font-size:11.5px;line-height:1.45;color:${T.ink2};}
.note-src{margin-top:5px;font-size:10px;color:${T.sage};word-break:break-all;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
.note-spec{margin-top:2px;font-size:10px;color:${T.mute};font-family:ui-monospace,Menlo,monospace;}
.mk{font-family:ui-monospace,Menlo,monospace;font-size:10px;font-weight:700;line-height:15px;
  padding:0 4px;border-radius:4px;cursor:pointer;border:1px solid;vertical-align:2px;margin-left:4px;}
.stamp{font-size:9.5px;font-weight:700;letter-spacing:0.08em;padding:2px 6px;border-radius:4px;
  border:1px solid;white-space:nowrap;display:inline-block;}
.lbl{font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${T.mute};margin:0 0 7px;}
.t12{font-size:12.5px;line-height:1.5;}
.t11{font-size:11px;line-height:1.45;}
.t10{font-size:10px;}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
.chip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-size:11px;
  border:1px solid;white-space:nowrap;cursor:default;}
.chip.click{cursor:pointer;}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;font-size:12px;
  font-weight:600;border:1px solid transparent;cursor:pointer;font-family:inherit;}
.card{background:${T.paper2};border:1px solid ${T.rule};border-radius:10px;padding:11px 13px;}
.rowwrap{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
.sec{margin-bottom:20px;}
.au{display:flex;flex-direction:column;gap:16px;}
@media(min-width:1000px){.au{flex-direction:row;align-items:flex-start;}
  .au-canvas{flex:1;min-width:0;}.au-plan{width:300px;flex:none;}}
.cv{border:1px solid ${T.rule2};border-radius:10px;overflow:hidden;background:${T.ink};}
.cv-bar{display:flex;align-items:center;gap:7px;padding:7px 10px;background:${T.ink2};color:${T.paper2};font-size:10px;}
.cv-url{flex:1;min-width:80px;border-radius:5px;padding:3px 8px;background:${T.ink};color:${T.rule};
  font-family:ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.cv-scroll{overflow-x:auto;}
.cv-inner{min-width:540px;position:relative;height:340px;background:#fff;}
.abox{position:absolute;border:2px dashed ${T.brass};border-radius:3px;pointer-events:none;}
.abadge{position:absolute;top:-11px;left:-11px;width:22px;height:22px;border-radius:50%;background:${T.brass};
  color:${T.paper};font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;
  box-shadow:0 1px 3px rgba(0,0,0,0.3);}
.plan{background:${T.paper2};border:1px solid ${T.rule};border-radius:10px;padding:11px;}
.step{display:flex;gap:8px;padding:8px 6px;border-bottom:1px dashed ${T.rule};align-items:flex-start;}
.step.off{opacity:0.5;background:${T.paper3};border-radius:6px;}
.stepbox{width:15px;height:15px;border-radius:4px;border:1.5px solid ${T.sage2};flex:none;margin-top:1px;
  display:flex;align-items:center;justify-content:center;background:transparent;cursor:pointer;padding:0;}
.stepbox.on{background:${T.sage};color:${T.paper};}
.step-d{font-size:12px;line-height:1.45;color:${T.ink};}
.step-meta{display:flex;align-items:center;gap:6px;margin-top:5px;flex-wrap:wrap;}
.mode{padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;display:inline-flex;
  align-items:center;gap:4px;cursor:pointer;border:1px solid;font-family:inherit;}
.xbtn{background:none;border:0;color:${T.mute2};cursor:pointer;padding:2px;flex:none;}
.area-h{display:flex;align-items:center;gap:8px;margin:14px 0 4px;}
.area-n{width:21px;height:21px;border-radius:50%;background:${T.brass};color:${T.paper};font-size:11px;
  font-weight:700;display:flex;align-items:center;justify-content:center;flex:none;}
.bk-scroll{overflow-x:auto;border:1px solid ${T.rule};border-radius:10px;}
.bk-grid{min-width:680px;}
.bk-row{display:grid;grid-template-columns:28px 1.5fr 1.1fr 0.5fr 0.5fr 0.7fr 0.9fr;gap:10px;
  align-items:center;padding:9px 12px;font-size:12px;}
.bk-head{background:${T.paper3};color:${T.mute};font-size:10px;font-weight:700;
  letter-spacing:0.1em;text-transform:uppercase;}
.grid2{display:grid;grid-template-columns:1fr;gap:12px;}
@media(min-width:820px){.grid2{grid-template-columns:1fr 1fr;}}
.grid3{display:grid;grid-template-columns:1fr;gap:12px;}
@media(min-width:820px){.grid3{grid-template-columns:repeat(3,1fr);}}
.snapr{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;}
.snap{flex:none;width:150px;border:1px solid ${T.rule2};border-radius:9px;overflow:hidden;background:${T.paper};}
.shot{background:repeating-linear-gradient(45deg,${T.paper3},${T.paper3} 6px,${T.paper2} 6px,${T.paper2} 12px);
  display:flex;align-items:center;justify-content:center;color:${T.mute2};}
.phone-wrap{display:flex;flex-direction:column;gap:22px;align-items:center;}
@media(min-width:820px){.phone-wrap{flex-direction:row;align-items:flex-start;}}
.phone{background:${T.ink};border-radius:28px;padding:9px;width:252px;flex:none;}
.phone-scr{border-radius:20px;overflow:hidden;position:relative;height:460px;background:#fff;}
.fab{position:absolute;bottom:14px;right:14px;width:46px;height:46px;border-radius:50%;background:${T.sage};
  color:${T.paper};border:0;display:flex;align-items:center;justify-content:center;cursor:pointer;
  box-shadow:0 3px 10px rgba(24,33,28,0.35);}
.msheet{position:absolute;left:0;right:0;bottom:0;background:${T.paper};border-top:2px solid ${T.rule2};
  border-radius:16px 16px 0 0;padding:11px;height:58%;}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:60;background:${T.paper};border-top:2px solid ${T.rule2};
  border-radius:16px 16px 0 0;box-shadow:0 -8px 28px rgba(24,33,28,0.22);padding:13px 15px 18px;}
@media(min-width:1100px){.sheet{display:none;}}
.res{border-radius:10px;padding:10px 12px;background:${T.paper2};margin-bottom:10px;}
.res-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.ev{width:38px;height:26px;border-radius:5px;background:${T.paper3};border:1px solid ${T.rule2};
  display:flex;align-items:center;justify-content:center;flex:none;}
.fb{flex:1;min-width:200px;font-size:11px;padding:6px 9px;border-radius:7px;background:${T.paper};
  border:1px solid ${T.rule};color:${T.ink2};font-family:inherit;}
.roster{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;}
.rchip{padding:5px 11px;border-radius:7px;background:${T.paper2};border:1px solid ${T.rule};color:${T.ink2};}
.pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1.6;
  white-space:pre;overflow-x:auto;color:${T.ink2};margin:0;}
.led-row{display:flex;gap:9px;padding:5px 0;border-top:1px dashed ${T.rule};font-size:12px;
  color:${T.ink2};align-items:baseline;}
.led-row:first-of-type{border-top:0;}
.led-id{font-family:ui-monospace,Menlo,monospace;font-weight:700;flex:none;width:30px;}
.led-where{font-size:10px;color:${T.mute};}
`;

export default function DrillMock() {
  const [view, setView] = useState("authoring");
  const [sel, setSel] = useState(null);
  const [listOpen, setListOpen] = useState(false);

  const annById = {};
  Object.values(A).forEach((l) => l.forEach((a) => (annById[a.id] = a)));

  const pick = (id) => {
    setSel(id);
    if (typeof document !== "undefined") {
      const el = document.getElementById("note-" + id);
      if (el && window.innerWidth >= 1100) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };

  const Mk = ({ id }) => {
    const a = annById[id];
    const k = KINDS[a ? a.kind : "new"];
    const on = sel === id;
    return (
      <button className="mk" title={a && a.title}
        onClick={(e) => { e.stopPropagation(); pick(id); }}
        style={{ background: on ? k.fg : k.bg, color: on ? T.paper : k.fg, borderColor: k.br }}>
        {id}
      </button>
    );
  };

  const Stamp = ({ kind }) => {
    const k = KINDS[kind];
    return <span className="stamp" style={{ background: k.bg, color: k.fg, borderColor: k.br }}>{k.label}</span>;
  };

  const Chip = ({ children, tone = "paper", onClick, active }) => {
    const tones = {
      paper: { bg: T.paper2, fg: T.ink2, br: T.rule },
      sage: { bg: T.sageSoft, fg: T.sage, br: T.sage2 },
      brass: { bg: T.brassSoft, fg: T.brass, br: T.brass },
      alarm: { bg: T.alarmSoft, fg: T.alarm, br: T.alarm },
      ink: { bg: T.ink, fg: T.paper, br: T.ink }
    };
    const t = tones[tone];
    return (
      <span className={"chip" + (onClick ? " click" : "")} onClick={onClick}
        style={{ background: active ? t.fg : t.bg, color: active ? t.bg : t.fg, borderColor: t.br }}>
        {children}
      </span>
    );
  };

  // ── interactive state ──
  const [steps, setSteps] = useState([
    { id: "s1", area: 1, mode: "vision", on: true, vp: ["d", "m"], state: "default",
      d: "Ask a PT-PT labor law question. Verify the answer cites the knowledge base and every citation opens its source.", ref: "kb#entry-detail" },
    { id: "s2", area: 1, mode: "e2e", on: true, vp: ["d", "t", "m"], state: "default",
      d: "Send is disabled while the composer is empty; Enter submits.", spec: "chat.spec.ts#s2" },
    { id: "s3", area: 2, mode: "vision", on: true, vp: ["d"], state: "default",
      d: "Citation markers [n] in the answer match the sources panel order and count." },
    { id: "s4", area: 2, mode: "e2e", on: true, vp: ["d", "m"], state: "building",
      d: "Streaming indicator visible while generating; gone on complete.", spec: "chat.spec.ts#s4" },
    { id: "s5", area: 3, mode: "e2e", on: false, vp: ["d"], state: "default",
      d: "Each source row deep-links to the matching KB entry.", spec: "chat.spec.ts#s5", ref: "kb#entry-detail" },
    { id: "p1", area: 0, mode: "e2e", on: true, vp: ["d", "t", "m"], state: "default",
      d: "Page loads under 3s; no console errors; no failed requests.", spec: "chat.spec.ts#p1" },
    { id: "p2", area: 0, mode: "vision", on: true, vp: ["m"], state: "default",
      d: "Empty conversation shows guidance, not a blank pane." }
  ]);
  const toggleOn = (id) => setSteps((s) => s.map((x) => x.id === id ? { ...x, on: !x.on } : x));
  const toggleMode = (id) => setSteps((s) => s.map((x) => x.id === id ? { ...x, mode: x.mode === "vision" ? "e2e" : "vision" } : x));
  const removeStep = (id) => setSteps((s) => s.filter((x) => x.id !== id));
  const [stateSel, setStateSel] = useState("default");
  const [pages, setPages] = useState([
    { id: "chat", title: "Chat", path: "/chat", sel: true, mode: "steps", areas: 3, steps: 7, e2e: "4/7", last: "pass" },
    { id: "kb", title: "Knowledge base", path: "/kb", sel: true, mode: "steps", areas: 2, steps: 5, e2e: "5/5", last: "pass" },
    { id: "builder", title: "Artifact builder", path: "/build", sel: true, mode: "whole", areas: 4, steps: 9, e2e: "3/9", last: "fail" },
    { id: "settings", title: "Settings", path: "/settings", sel: false, mode: "steps", areas: 1, steps: 3, e2e: "3/3", last: "pass" }
  ]);
  const [fullDrill, setFullDrill] = useState(false);
  const [autonomy, setAutonomy] = useState("gated");
  const [msheet, setMsheet] = useState(true);

  const Vp = ({ vp }) => (
    <span style={{ display: "inline-flex", gap: 2, color: T.mute, alignItems: "center" }}>
      {vp.includes("d") && <Monitor size={11} />}
      {vp.includes("t") && <Tablet size={11} />}
      {vp.includes("m") && <Smartphone size={11} />}
    </span>
  );

  const StepRow = ({ s }) => (
    <div className={"step" + (s.on ? "" : " off")}>
      <button className={"stepbox" + (s.on ? " on" : "")} onClick={() => toggleOn(s.id)}>
        {s.on && <Check size={10} strokeWidth={3} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="step-d">{s.d} {s.ref && <Chip tone="sage">{s.ref}</Chip>}</div>
        <div className="step-meta">
          <button className="mode" onClick={() => toggleMode(s.id)}
            style={s.mode === "vision"
              ? { background: T.brassSoft, color: T.brass, borderColor: T.brass }
              : { background: T.sageSoft, color: T.sage, borderColor: T.sage2 }}>
            {s.mode === "vision" ? <Eye size={10} /> : <FileCode2 size={10} />}
            {s.mode}
          </button>
          {s.spec && <span className="mono t10" style={{ color: T.mute }}>{s.spec}</span>}
          <Vp vp={s.vp} />
          {s.state !== "default" && <Chip tone="brass">{s.state}</Chip>}
        </div>
      </div>
      <button className="xbtn" onClick={() => removeStep(s.id)} title="Remove step"><X size={14} /></button>
    </div>
  );

  const Box = ({ n, style }) => (
    <div className="abox" style={style}><span className="abadge">{n}</span></div>
  );

  const FakeApp = ({ compact }) => (
    <div style={{ width: "100%", height: "100%", display: "flex", textAlign: "left", background: "#fff", color: "#1d232a", fontSize: compact ? 9 : 11 }}>
      {!compact && (
        <div style={{ width: 96, flex: "none", padding: 8, background: "#f1f4f7", borderRight: "1px solid #e2e8ee" }}>
          <div style={{ fontWeight: 700, color: "#2b4d8f", marginBottom: 8 }}>ekoa</div>
          <div style={{ padding: "4px 6px", borderRadius: 5, background: "#dfe8f5", color: "#2b4d8f", marginBottom: 4 }}>Chat</div>
          <div style={{ padding: "4px 6px" }}>Knowledge</div>
          <div style={{ padding: "4px 6px" }}>Builder</div>
        </div>
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ flex: 1, padding: 10, overflow: "hidden" }}>
          <div style={{ marginLeft: "auto", maxWidth: "80%", borderRadius: 7, padding: "5px 8px", background: "#e8eef8", width: "fit-content", marginBottom: 10 }}>
            As horas extra em dia feriado pagam-se como?
          </div>
          <div style={{ maxWidth: "92%", borderRadius: 7, padding: "6px 9px", lineHeight: 1.5, background: "#f6f7f9", border: "1px solid #e7eaee" }}>
            Em dia feriado, o trabalho presta-se com acréscimo de 50% da retribuição{" "}
            <span style={{ padding: "0 4px", borderRadius: 4, fontWeight: 700, background: "#dfe8f5", color: "#2b4d8f" }}>[1]</span>{" "}
            ou descanso compensatório{" "}
            <span style={{ padding: "0 4px", borderRadius: 4, fontWeight: 700, background: "#dfe8f5", color: "#2b4d8f" }}>[2]</span>.
            <div style={{ marginTop: 5, fontSize: 8, color: "#7a8492" }}>a gerar…</div>
          </div>
        </div>
        <div style={{ padding: 10, borderTop: "1px solid #e7eaee" }}>
          <div style={{ borderRadius: 7, padding: "6px 9px", display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid #cfd7e0", color: "#8a93a0" }}>
            Pergunte qualquer coisa…
            <span style={{ padding: "1px 7px", borderRadius: 4, background: "#2b4d8f", color: "#fff" }}>➤</span>
          </div>
        </div>
      </div>
      {!compact && (
        <div style={{ width: 110, flex: "none", padding: 8, background: "#fafbfc", borderLeft: "1px solid #e7eaee" }}>
          <div style={{ fontWeight: 600, color: "#5a6472", marginBottom: 6 }}>Fontes</div>
          <div style={{ borderRadius: 6, padding: 6, border: "1px solid #e7eaee", marginBottom: 5 }}>1 · CT art. 269</div>
          <div style={{ borderRadius: 6, padding: 6, border: "1px solid #e7eaee" }}>2 · CT art. 229</div>
        </div>
      )}
    </div>
  );

  // ─── views ───

  const BookView = () => (
    <div>
      <div className="sec rowwrap" style={{ justifyContent: "space-between" }}>
        <div>
          <div className="lbl">App</div>
          <div className="rowwrap">
            <b>ekoa</b>
            <span className="mono t11" style={{ color: T.mute }}>http://localhost:3000</span>
            <Mk id="A1" /><Mk id="A2" />
          </div>
        </div>
        <button className="btn" style={{ background: T.sage, color: T.paper }}><Play size={12} /> Run selected</button>
      </div>

      <div className="sec rowwrap">
        <Chip tone={fullDrill ? "ink" : "paper"} onClick={() => setFullDrill(!fullDrill)} active={fullDrill}>
          Full Drill {fullDrill ? "on" : "off"}
        </Chip><Mk id="A3" />
        <Chip tone="sage" active><Monitor size={11} /> desktop</Chip>
        <Chip tone="sage" active><Tablet size={11} /> tablet</Chip>
        <Chip tone="sage"><Smartphone size={11} /> mobile</Chip>
        <Mk id="A4" />
        <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}
          style={{ fontSize: 11, padding: "5px 8px", borderRadius: 7, background: T.paper2, border: "1px solid " + T.rule, color: T.ink, fontFamily: "inherit" }}>
          <option value="gated">Gated: approve plan before running</option>
          <option value="auto">Autonomous: plan, run, report</option>
        </select>
        <Mk id="A5" />
      </div>

      <div className="sec">
        <div className="lbl">Global rules and notes <Mk id="A9" /></div>
        <div className="card t12" style={{ color: T.ink2 }}>
          Every knowledge answer must show citations that resolve to KB sources. Formal surfaces in PT-PT.
          No console errors on any page. Long operations always show progress. Artifacts must open after build.
        </div>
      </div>

      <div className="sec bk-scroll">
        <div className="bk-grid">
          <div className="bk-row bk-head">
            <span /><span>Page</span><span>Mode</span><span>Areas</span><span>Steps</span><span>Suite</span><span>Last run</span>
          </div>
          {pages.map((p) => (
            <div key={p.id} className="bk-row"
              style={{ borderTop: "1px solid " + T.rule, background: (fullDrill || p.sel) ? T.paper : T.paper2 }}>
              <button className={"stepbox" + ((fullDrill || p.sel) ? " on" : "")}
                onClick={() => setPages((ps) => ps.map((x) => x.id === p.id ? { ...x, sel: !x.sel } : x))}>
                {(fullDrill || p.sel) && <Check size={10} strokeWidth={3} />}
              </button>
              <span><b>{p.title}</b> <span className="mono t10" style={{ color: T.mute2 }}>{p.path}</span></span>
              <span className="t11">{p.mode === "steps" ? "Step by step" : <span style={{ color: T.brass, fontWeight: 600 }}>Whole page vision</span>}</span>
              <span>{p.areas}</span>
              <span>{p.steps}</span>
              <span className="mono t11" style={{ color: T.sage }}>{p.e2e} e2e</span>
              <span>{p.last === "pass"
                ? <Chip tone="sage"><Check size={10} /> pass</Chip>
                : <Chip tone="alarm"><AlertTriangle size={10} /> fail</Chip>}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rowwrap">
        <button className="btn" style={{ background: T.brassSoft, color: T.brass, borderColor: T.brass }}>
          <Plus size={12} /> New testing task
        </button>
        <Mk id="A6" />
        <span className="t11" style={{ color: T.mute }}>
          Runs land in the engine's run records <Mk id="A8" /> · shape pre-settled on the roadmap <Mk id="A7" />
        </span>
      </div>
    </div>
  );

  const AuthoringView = () => {
    const areas = [
      { n: 1, label: "Composer", anchor: "testId: chat-composer" },
      { n: 2, label: "Answer and citations", anchor: "role: article" },
      { n: 3, label: "Sources panel", anchor: "testId: sources-panel" }
    ];
    return (
      <div className="au">
        <div className="au-canvas">
          <div className="lbl">App under test <Mk id="B1" /><Mk id="B2" /><Mk id="B4" /></div>
          <div className="cv">
            <div className="cv-bar">
              <span style={{ width: 8, height: 8, borderRadius: 4, background: T.alarm }} />
              <span style={{ width: 8, height: 8, borderRadius: 4, background: T.brass2 }} />
              <span style={{ width: 8, height: 8, borderRadius: 4, background: T.sage2 }} />
              <span className="cv-url">localhost:3000/chat</span>
              <span className="mono" style={{ color: T.rule2 }}>LOW·MED·HIGH</span>
              <Crosshair size={13} style={{ color: T.brass2 }} />
            </div>
            <div className="cv-scroll">
              <div className="cv-inner">
                <FakeApp />
                <Box n={1} style={{ left: "22%", right: "23%", bottom: 8, height: 36 }} />
                <Box n={2} style={{ left: "22%", right: "25%", top: 62, height: 84 }} />
                <Box n={3} style={{ right: 6, top: 8, width: 106, bottom: 8 }} />
              </div>
            </div>
          </div>
          <div className="t11 rowwrap" style={{ color: T.mute, marginTop: 8 }}>
            <Crosshair size={12} style={{ color: T.brass }} />
            Pick mode: hover snaps to sensible elements (devtools-style), click captures multi-anchors <Mk id="B3" />
          </div>
        </div>

        <div className="au-plan plan">
          <div className="rowwrap" style={{ marginBottom: 10 }}>
            <NotebookPen size={13} style={{ color: T.sage }} />
            <b className="t12">Drill: Chat</b>
            <span style={{ marginLeft: "auto" }}><Mk id="B5" /><Mk id="B6" /></span>
          </div>

          <div className="lbl">State <Mk id="B11" /></div>
          <div className="rowwrap" style={{ marginBottom: 12 }}>
            {["default", "building", "complete"].map((st) => (
              <Chip key={st} tone="brass" active={stateSel === st} onClick={() => setStateSel(st)}>{st}</Chip>
            ))}
            <Camera size={13} style={{ color: T.mute }} />
          </div>

          <div className="lbl">Page steps <Mk id="B12" /></div>
          {steps.filter((s) => s.area === 0).map((s) => <StepRow key={s.id} s={s} />)}

          {areas.map((a) => (
            <div key={a.n}>
              <div className="area-h">
                <span className="area-n">{a.n}</span>
                <b className="t12">{a.label}</b>
                <span className="mono t10" style={{ color: T.mute2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.anchor}</span>
                <button className="xbtn" style={{ marginLeft: "auto", color: T.sage }} title="Add step"><Plus size={14} /></button>
              </div>
              {steps.filter((s) => s.area === a.n).map((s) => <StepRow key={s.id} s={s} />)}
            </div>
          ))}

          <div className="rowwrap" style={{ marginTop: 12 }}>
            <button className="btn" style={{ flex: 1, justifyContent: "center", background: T.brassSoft, color: T.brass, borderColor: T.brass }}>
              <Crosshair size={11} /> Highlight new area
            </button>
            <button className="btn" style={{ background: T.sageSoft, color: T.sage, borderColor: T.sage2 }}>
              <Plus size={11} /> Page step
            </button>
          </div>
          <div className="t10" style={{ color: T.mute, marginTop: 10, lineHeight: 1.6 }}>
            vision graduates to e2e <Mk id="B8" /> · planner picks the mode <Mk id="B9" /> ·
            failures self-heal <Mk id="B7" /> · refs jump across pages <Mk id="B10" />
          </div>
        </div>
      </div>
    );
  };

  const StatesView = () => (
    <div>
      <div className="sec">
        <div className="lbl">Snapshots from runs <Mk id="C3" /> <Mk id="C4" /></div>
        <div className="snapr">
          {[["12:01:14", "idle", "fp a91f"], ["12:01:52", "build 8%", "fp 3c22"], ["12:03:10", "build 64%", "fp 3c22"], ["12:04:41", "done", "fp 77d0"]].map(([t, l, f], i) => (
            <div key={i} className="snap">
              <div className="shot" style={{ height: 64 }}><Camera size={14} /></div>
              <div className="t10" style={{ padding: "5px 7px", display: "flex", justifyContent: "space-between", background: T.paper2, color: T.ink2 }}>
                <span>{t} · {l}</span><span className="mono" style={{ color: T.mute2 }}>{f}</span>
              </div>
              <button className="btn" style={{ width: "100%", justifyContent: "center", borderRadius: 0, padding: 5, fontSize: 10, background: T.brassSoft, color: T.brass }}>
                Promote to state
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="grid3 sec">
        {[
          { name: "default", match: "url /build + heading 'New build'", reach: "(entry)", scoped: "2 areas · 3 steps", mk: null },
          { name: "building", match: "fp 3c22 ±shape · progressbar visible", reach: "s-start-build → wait progress>0", scoped: "3 areas · 4 steps", mk: ["C1", "C2", "C5"] },
          { name: "complete", match: "assert: 'Build complete' visible", reach: "building → wait complete (≤120s)", scoped: "2 areas · 3 steps", mk: ["C6"] }
        ].map((st) => (
          <div key={st.name} className="card">
            <div className="rowwrap" style={{ marginBottom: 8 }}>
              <Chip tone="brass" active>{st.name}</Chip>
              {st.mk && st.mk.map((m) => <Mk key={m} id={m} />)}
            </div>
            <div className="shot t10" style={{ height: 56, borderRadius: 7, marginBottom: 8 }}>
              reference screenshot · annotate areas here
            </div>
            <div className="t11" style={{ color: T.ink2 }}><b>Matcher:</b> {st.match}</div>
            <div className="t11" style={{ color: T.ink2 }}><b>Reach:</b> <span className="mono t10">{st.reach}</span></div>
            <div className="t11" style={{ color: T.mute, marginTop: 4 }}>{st.scoped}</div>
          </div>
        ))}
      </div>
      <div className="t11" style={{ color: T.mute }}>
        Optional later: visual regression per state per viewport <Mk id="C7" />
      </div>
    </div>
  );

  const ResultsView = () => (
    <div>
      <div className="rowwrap sec">
        <span className="mono t11" style={{ color: T.mute }}>run 01KX2… · Chat</span>
        <Chip tone="sage"><Monitor size={10} /> desktop</Chip>
        <Chip tone="sage"><Smartphone size={10} /> mobile</Chip>
        <Mk id="D1" />
        <span className="t10" style={{ marginLeft: "auto", color: T.mute }}>
          tiers: <b style={{ color: T.sage }}>cached</b> · <b style={{ color: T.brass }}>vision</b> · <b style={{ color: T.warn }}>recovered</b> <Mk id="D2" />
        </span>
      </div>

      {[
        { id: "p1", tier: "cached", ok: true, dur: "1.9s", d: "Loads under 3s; no console errors; no failed requests.", mk: "D3" },
        { id: "s1", tier: "vision", ok: true, dur: "14.2s", d: "Law question answered with KB citations and resolving sources.",
          note: "Emitted chat.spec.ts#s1 · toggle flipped to e2e",
          user: "Sources rendered ~6s after the answer finished; feels broken. Flag if over 3s.", flagged: true },
        { id: "s3", tier: "vision", ok: false, dur: "11.8s", d: "Citation markers match sources order.",
          fail: "Marker [2] points to CT art. 269; sources row 2 shows art. 229.",
          user: "Confirmed: mapping bug between marker index and source row." },
        { id: "s4", tier: "recovered", ok: true, dur: "6.1s", d: "Streaming indicator during generation.", note: "Cached selector stale, healed and re-cached." }
      ].map((r) => (
        <div key={r.id} className="res" style={{ border: "1px solid " + (r.ok && !r.flagged ? T.rule : T.alarm) }}>
          <div className="res-h">
            {r.ok ? <Check size={14} style={{ color: T.sage }} /> : <AlertTriangle size={14} style={{ color: T.alarm }} />}
            <span className="mono t11" style={{ color: T.mute }}>{r.id}</span>
            <span className="t12" style={{ flex: "1 1 200px" }}>{r.d}</span>
            <Chip tone={r.tier === "cached" ? "sage" : r.tier === "vision" ? "brass" : "paper"}>{r.tier}</Chip>
            <span className="mono t10" style={{ color: T.mute2 }}>{r.dur}</span>
            <span className="ev"><Camera size={11} style={{ color: T.mute }} /></span>
            {r.mk && <Mk id={r.mk} />}
          </div>
          {r.note && <div className="t11" style={{ color: T.sage, marginTop: 5 }}>{r.note}</div>}
          {r.fail && <div className="t11" style={{ color: T.alarm, marginTop: 6 }}>{r.fail}</div>}
          {r.user && (
            <div className="rowwrap" style={{ marginTop: 7 }}>
              <input className="fb" readOnly value={r.user} />
              <Mk id="D4" />
              {r.flagged && (
                <>
                  <button className="btn" style={{ background: T.alarmSoft, color: T.alarm, borderColor: T.alarm, padding: "4px 9px", fontSize: 10 }}>
                    Mark failed
                  </button>
                  <Mk id="D5" />
                  <Chip tone="alarm">→ finding</Chip>
                </>
              )}
              {r.fail && <Chip tone="alarm">→ finding</Chip>}
            </div>
          )}
        </div>
      ))}

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="rowwrap" style={{ marginBottom: 8 }}>
          <b className="t12">Observations</b>
          <Mk id="D9" />
          <span className="t10" style={{ color: T.mute }}>things no step covers, no re-run needed</span>
        </div>
        <div className="rowwrap t11" style={{ color: T.ink2 }}>
          <span style={{ flex: "1 1 220px" }}>Sources panel flickered twice while the answer streamed.</span>
          <Chip tone="sage">→ draft step s6 added</Chip>
          <Chip tone="alarm">→ finding</Chip>
        </div>
        <div className="rowwrap" style={{ marginTop: 8 }}>
          <input className="fb" readOnly placeholder="Add an observation…" value="" />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="rowwrap" style={{ marginBottom: 8 }}>
          <b className="t12">UX review</b>
          <Mk id="D7" /><Mk id="D8" />
        </div>
        {[
          ["warn", "Composer focus ring fails contrast on paper background (WCAG 1.4.11).", "area 1"],
          ["note", "Sources panel disappears on tablet with no affordance to reopen (Nielsen: visibility of system status).", "area 3"]
        ].map(([sev, txt, at], i) => (
          <div key={i} className="rowwrap t11" style={{ padding: "6px 0", borderTop: i ? "1px dashed " + T.rule : "none", color: T.ink2 }}>
            <Chip tone={sev === "warn" ? "alarm" : "brass"}>{sev}</Chip>
            <span style={{ flex: "1 1 200px" }}>{txt}</span>
            <span className="mono t10" style={{ color: T.mute2 }}>{at}</span>
            <button className="btn" style={{ background: T.sageSoft, color: T.sage, borderColor: T.sage2, padding: "4px 9px", fontSize: 10 }}>
              Confirm → report
            </button>
          </div>
        ))}
      </div>

      <div className="card" style={{ border: "1.5px solid " + T.sage2 }}>
        <div className="rowwrap" style={{ marginBottom: 8 }}>
          <b className="t12">Run report · findings</b>
          <Mk id="D10" /><Mk id="D6" />
        </div>
        {[
          ["s3 citation mapping bug", "confirmed"],
          ["s1 sources render latency (flipped by you)", "confirmed"],
          ["obs: sources panel flicker during streaming", "confirmed"],
          ["ux: focus ring contrast (WCAG 1.4.11)", "confirmed"],
          ["ux: tablet sources panel affordance", "dismissed"]
        ].map(([txt, st], i) => (
          <div key={i} className="rowwrap t11" style={{ padding: "5px 0", borderTop: i ? "1px dashed " + T.rule : "none", color: T.ink2 }}>
            <span style={{ flex: "1 1 220px", textDecoration: st === "dismissed" ? "line-through" : "none" }}>{txt}</span>
            <Chip tone={st === "confirmed" ? "sage" : "paper"} active={st === "confirmed"}>{st}</Chip>
            <Chip tone="paper">dismiss</Chip>
          </div>
        ))}
        <div className="rowwrap" style={{ marginTop: 10 }}>
          <select style={{ fontSize: 11, padding: "5px 8px", borderRadius: 7, background: T.paper, border: "1px solid " + T.rule, color: T.ink, fontFamily: "inherit" }}>
            <option>Dispatch: Manual</option>
            <option>Dispatch: Heartbeat (autonomous)</option>
            <option>Dispatch: Immediate</option>
          </select>
          <button className="btn" style={{ background: T.ink, color: T.paper }}>
            <Wrench size={12} /> Fix all confirmed (4)
          </button>
          <span className="t10" style={{ color: T.mute }}>one batch card carrying the report · split available</span>
        </div>
      </div>
    </div>
  );

  const MobileView = () => (
    <div className="phone-wrap">
      <div className="phone">
        <div className="phone-scr">
          <FakeApp compact />
          <Box n={1} style={{ left: "8%", right: "8%", bottom: 10, height: 30 }} />
          {msheet && (
            <div className="msheet">
              <div className="rowwrap" style={{ marginBottom: 8 }}>
                <b className="t11">Drill: Chat</b>
                <button className="btn" onClick={() => setMsheet(false)}
                  style={{ marginLeft: "auto", padding: "3px 8px", fontSize: 10, background: T.brassSoft, color: T.brass, borderColor: T.brass }}>
                  <Crosshair size={10} /> Highlight
                </button>
                <button className="xbtn" onClick={() => setMsheet(false)}><X size={14} /></button>
              </div>
              {steps.slice(0, 3).map((s) => (
                <div key={s.id} className="t10" style={{ display: "flex", gap: 6, color: T.ink2, marginBottom: 6, lineHeight: 1.45 }}>
                  <Check size={10} style={{ color: T.sage, flex: "none", marginTop: 2 }} /> {s.d.slice(0, 62)}…
                </div>
              ))}
            </div>
          )}
          {!msheet && (
            <button className="fab" onClick={() => setMsheet(true)}><NotebookPen size={18} /></button>
          )}
        </div>
      </div>
      <div className="t12" style={{ flex: 1, minWidth: 220, color: T.ink2, lineHeight: 1.7 }}>
        <p style={{ marginTop: 0 }}>FAB opens and closes the plan sheet <Mk id="E1" />. Try it: close the sheet and the FAB appears.</p>
        <p>Highlight closes the sheet, picks on the canvas with enlarged snap targets, and reopens with the new area ready <Mk id="E2" />.</p>
        <p>The Drill UI is a PWA like voice, usable from the phone against the dev machine <Mk id="E3" />.</p>
        <p style={{ marginBottom: 0 }}>Responsive testing is the viewport matrix itself: same steps per viewport, separate verdicts <Mk id="E4" />.</p>
      </div>
    </div>
  );

  const GarrisonView = () => (
    <div>
      <div className="sec">
        <div className="lbl">Duty roster</div>
        <div className="roster">
          {["Plan", "Implement", "Review"].map((d) => <span key={d} className="rchip">{d}</span>)}
          <ChevronRight size={13} style={{ color: T.mute2 }} />
          <span className="rchip" style={{ background: T.sageSoft, border: "1.5px solid " + T.sage, color: T.sage, fontWeight: 700 }}>
            Drill: plan ▸ <span style={{ color: T.brass }}>gate</span> ▸ run
          </span>
          <Mk id="F1" />
          <ChevronRight size={13} style={{ color: T.mute2 }} />
          <span className="rchip">Done</span>
        </div>
        <div className="roster" style={{ marginTop: 8 }}>
          <span className="rchip" style={{ textDecoration: "line-through", background: T.alarmSoft, color: T.alarm, border: "1px dashed " + T.alarm }}>Walkthrough</span>
          <Mk id="F2" />
          <span className="rchip" style={{ textDecoration: "line-through", background: T.alarmSoft, color: T.alarm, border: "1px dashed " + T.alarm }}>Validation</span>
          <Mk id="F3" />
          <span className="rchip" style={{ textDecoration: "line-through", background: T.alarmSoft, color: T.alarm, border: "1px dashed " + T.alarm }}>Adversarial test</span>
          <Mk id="F8" />
          <span className="rchip" style={{ color: T.mute }}>duty-test stays <Mk id="F5" /> · skill lessons carried <Mk id="F9" /></span>
        </div>
      </div>

      <div className="sec">
        <div className="lbl">Testing-only task <Mk id="F4" /></div>
        <div className="roster" style={{ fontSize: 11 }}>
          <span className="rchip" style={{ background: T.brassSoft, borderColor: T.brass, color: T.brass }}>Card: "Test: KB citations regression"</span>
          <ChevronRight size={12} style={{ color: T.mute2 }} />
          <span className="rchip" style={{ background: T.sageSoft, borderColor: T.sage2, color: T.sage }}>enters at Drill</span>
          <ChevronRight size={12} style={{ color: T.mute2 }} />
          <span className="rchip">run</span>
          <ChevronRight size={12} style={{ color: T.mute2 }} />
          <span className="rchip" style={{ background: T.alarmSoft, borderColor: T.alarm, color: T.alarm }}>fail → Fix card</span>
          <ChevronRight size={12} style={{ color: T.mute2 }} />
          <span className="rchip">normal pipeline</span>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="t12" style={{ fontWeight: 700, marginBottom: 6 }}>Fitting shape <Mk id="F7" /></div>
          <pre className="pre">{`name: drill
x-garrison:
  faculty: building
  own_port: true          # like automations
  component_shape: plugin
  provides:
    - kind: duty
      name: drill
  consumes:
    - kind: automation-runner   # the engine
    - kind: browser (surfaces)  # canvas + CDP`}</pre>
        </div>
        <div className="card">
          <div className="t12" style={{ fontWeight: 700, marginBottom: 6 }}>Engine deltas → Ekoa <Mk id="F6" /> <Mk id="A7" /></div>
          <ol className="t11" style={{ color: T.ink2, paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
            <li>Inline ephemeral runs (drill context)</li>
            <li>Spec emission from the action cache</li>
            <li>Viewport and device emulation per run</li>
            <li>Step enable flags and tags</li>
            <li>Richer deterministic assertions</li>
            <li>Run matrices across viewports</li>
            <li>Per-step evidence capture, and video, as plain files with links</li>
          </ol>
        </div>
      </div>
    </div>
  );

  const LedgerView = () => (
    <div>
      <div className="t11 sec" style={{ color: T.mute }}>
        This mock supersedes drill-design-draft.md. Carried and superseded: R8 carried (duty-test stays);
        the earlier keep-walkthrough leaning is superseded by R9; the research recommendation to embed
        Midscene or Stagehand is superseded by reusing Garrison's own vision stack;
        v0.4: per-row immediate Send to fix superseded by the findings report (R10);\n        v0.5: Q1-Q9 all resolved (R11-R14), artifact-store references replaced by files plus File Browser, duty-adversarial-test absorbed as the blind adversarial pass.
      </div>
      <div className="sec">
        <div className="lbl">Spec inventory S1..S27</div>
        <div className="card" style={{ padding: "4px 12px" }}>
          {SPECS.map(([id, txt, where]) => (
            <div key={id} className="led-row">
              <span className="led-id" style={{ color: T.sage }}>{id}</span>
              <span style={{ flex: 1 }}>{txt} <span className="led-where">· {where}</span></span>
            </div>
          ))}
        </div>
      </div>
      <div className="sec">
        <div className="lbl">Decisions R1..R9</div>
        <div className="card" style={{ padding: "4px 12px" }}>
          {DECISIONS.map(([id, txt, st]) => (
            <div key={id} className="led-row">
              <span className="led-id" style={{ color: T.brass }}>{id}</span>
              <span style={{ flex: 1 }}>{txt} <span className="led-where" style={{ color: st.startsWith("open") || st.startsWith("new") ? T.warn : T.mute }}>· {st}</span></span>
            </div>
          ))}
        </div>
      </div>
      <div className="sec">
        <div className="lbl">Questions · all resolved this round</div>
        <div className="card" style={{ padding: "4px 12px" }}>
          {QUESTIONS.map(([id, txt]) => (
            <div key={id} className="led-row">
              <span className="led-id" style={{ color: T.alarm }}>{id}</span>
              <span style={{ flex: 1 }}>{txt}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const VIEWS = {
    book: ["Drill Book", BookView],
    authoring: ["Authoring", AuthoringView],
    states: ["States", StatesView],
    results: ["Run & results", ResultsView],
    mobile: ["Mobile", MobileView],
    garrison: ["Garrison", GarrisonView],
    ledger: ["Ledger", LedgerView]
  };
  const Current = VIEWS[view][1];
  const notes = A[view] || [];
  const selAnn = sel ? annById[sel] : null;

  return (
    <div className="dm-root">
      <style>{CSS}</style>

      <div className="hdr">
        <h1 className="dm-h1">DRILL <span>annotated mock · ledger v0.5</span></h1>
        <div className="legend">
          {Object.keys(KINDS).map((k) => <Stamp key={k} kind={k} />)}
        </div>
        {notes.length > 0 && (
          <button className="btn notes-toggle" onClick={() => setListOpen(!listOpen)}
            style={{ marginLeft: "auto", background: listOpen ? T.ink : T.paper2, color: listOpen ? T.paper : T.ink2, borderColor: T.rule2, padding: "5px 10px", fontSize: 11 }}>
            Annotations ({notes.length})
          </button>
        )}
      </div>
      <div className="sub">Tap any [tag] to open its annotation. Interactive elements preview real behavior.</div>

      <div className="dm-tabs">
        {Object.entries(VIEWS).map(([k, [label]]) => (
          <button key={k} className={"dm-tab" + (view === k ? " on" : "")}
            onClick={() => { setView(k); setSel(null); }}>
            {label}
          </button>
        ))}
      </div>

      <div className="dm-body">
        <div className="dm-main"><Current /></div>

        {notes.length > 0 && (
          <div className={"dm-notes" + (listOpen ? " open" : "")}>
            <div className="lbl" style={{ margin: 0 }}>Annotations · {VIEWS[view][0]}</div>
            {notes.map((a) => {
              const k = KINDS[a.kind];
              const on = sel === a.id;
              return (
                <div key={a.id} id={"note-" + a.id} className={"note" + (on ? " on" : "")}
                  onClick={() => setSel(a.id)}
                  style={on ? { borderColor: k.br, boxShadow: "0 0 0 2px " + k.bg } : undefined}>
                  <div className="note-h">
                    <span className="mono t10" style={{ fontWeight: 700, color: k.fg }}>{a.id}</span>
                    <Stamp kind={a.kind} />
                    <span className="note-t">{a.title}</span>
                  </div>
                  <div className="note-b">{a.body}</div>
                  {a.src && <div className="note-src">{a.src}</div>}
                  {a.spec && <div className="note-spec">{a.spec}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selAnn && (
        <div className="sheet">
          <div className="note-h">
            <span className="mono t10" style={{ fontWeight: 700, color: KINDS[selAnn.kind].fg }}>{selAnn.id}</span>
            <Stamp kind={selAnn.kind} />
            <span className="note-t">{selAnn.title}</span>
            <button className="xbtn" style={{ marginLeft: "auto" }} onClick={() => setSel(null)}><X size={16} /></button>
          </div>
          <div className="note-b">{selAnn.body}</div>
          {selAnn.src && <div className="note-src">{selAnn.src}</div>}
          {selAnn.spec && <div className="note-spec">{selAnn.spec}</div>}
        </div>
      )}
    </div>
  );
}

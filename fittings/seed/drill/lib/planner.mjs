// Agent-driven Drill Book planning for direct runs: when a project has no
// Book yet (or a feature landed), a headless Claude Code session in the
// project root authors/updates drills/drillbook.yml + drills/pages/*.yml on
// its own judgment - pages, areas, steps (vision vs e2e), and states, the
// same stage-1 "Plan" the garrison-drill duty runs card-side. The Authoring
// UI stays the manual OVERRIDE surface; it is never the required entry path.
//
// Same job discipline as app-runner.mjs: one job per project root at a time,
// in-memory, registered before any await; transcript streams to
// <garrison-home>/drill/plan/<project>-<hash>-<ts>.log; sentinel contract on
// the FINAL line (DRILL_PLAN_OK=<pages> / DRILL_PLAN_FAILED=<reason>, last
// one printed wins). The sentinel is never trusted blind: an OK needs page
// files on disk AND (unless the agent claims OK=0, "already covered") a real
// change under drills/ since the job started (verify-step discipline - a
// pre-existing Book must not vouch for a no-op agent). Each job also writes
// a pid record under <garrison-home>/drill/plan/jobs/ so a restarted server
// can reap an orphaned agent instead of double-spawning into the same repo.
// No model/effort pins - the agent session inherits the user's defaults.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findRunSkill } from "./projects.mjs";
import { listPages, getPage } from "./store.mjs";
import { drillHomeDir } from "./runs-store.mjs";
import * as explore from "./explore.mjs";
import { applyPlanIntegrity, capturePlanBaseline } from "./plan-integrity.mjs";

const jobs = new Map(); // root -> job

function logDir() {
  return path.join(drillHomeDir(), "plan");
}

// Basename + full-root hash, same reasoning as app-runner: distinct roots
// sharing a basename must never share a log file.
function safeName(root) {
  const base = path.basename(root).replace(/[^A-Za-z0-9_-]/g, "") || "project";
  return `${base}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

// A hostile/broken env value must degrade to the default, not to a NaN
// deadline that never trips (a hung agent would stay "planning" forever).
//
// 2h default. It was 30min back when planning was a reading exercise, and even
// then a live 15min run on a mid-sized monorepo was killed still working. A
// plan now DRIVES the app - opens every page, clicks through its menus and
// dialogs, and validates each deterministic assertion against the live page
// before writing it - which is minutes per page, not seconds. Killing that at
// 30 minutes throws away a mostly-authored Book and, worse, teaches the next
// run to plan shallowly. The cost of a too-long timeout is a hung agent noticed
// late; the cost of a too-short one is paid on every full plan.
function defaultTimeoutMs() {
  const t = Number(process.env.DRILL_PLAN_TIMEOUT_MS);
  return Number.isFinite(t) && t > 0 ? t : 7200000;
}

// ── orphan pid records ──────────────────────────────────────────────────────
// The job Map dies with the server process, but the spawned agent does not:
// it reparents and keeps authoring the repo. The pid record is the durable
// trace that lets the next server process reap it - without this, the UI's
// "retry" after a restart double-spawns two agents concurrently rewriting
// the same drills/ tree.

function jobRecordPath(root) {
  return path.join(logDir(), "jobs", `${safeName(root)}.json`);
}

async function writeJobRecord(job) {
  const file = jobRecordPath(job.root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pid: job.agentPid, root: job.root, startedAt: job.startedAt, logFile: job.logFile }), "utf8");
}

function clearJobRecord(root) {
  return fs.unlink(jobRecordPath(root)).catch(() => {});
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A record from before the last machine boot cannot name a live agent (pids
// do not survive reboot) - never signal a recycled pid.
function recordNamesLiveAgent(rec) {
  const bootTime = Date.now() - os.uptime() * 1000;
  return !!rec.pid && Date.parse(rec.startedAt) > bootTime && pidAlive(rec.pid);
}

// Called once at server boot: kill any plan agent a previous server process
// left running, then clear the records. Returns the reaped records.
export async function reapOrphanPlanAgents() {
  const dir = path.join(logDir(), "jobs");
  let entries;
  try { entries = await fs.readdir(dir); } catch { return []; }
  const reaped = [];
  for (const f of entries.filter((x) => x.endsWith(".json"))) {
    const file = path.join(dir, f);
    try {
      const rec = JSON.parse(await fs.readFile(file, "utf8"));
      if (recordNamesLiveAgent(rec)) {
        try { process.kill(rec.pid, "SIGKILL"); reaped.push(rec); } catch { /* raced its exit */ }
      }
    } catch { /* unreadable record - just clear it */ }
    await fs.unlink(file).catch(() => {});
  }
  return reaped;
}

// ── plan prompt ─────────────────────────────────────────────────────────────
// The Book format spec the agent writes against - kept next to the code that
// parses it (store.mjs/compile.mjs) so drift is a one-file diff. Steps get no
// fabricated `assertion` (graduation sets it later, B8) and ids are filename-
// safe (store.safeId rejects anything else).
// The exploration contract handed to the plan agent. Written as concrete curl
// calls because the agent has a shell and no MCP surface into Drill - and
// because a vague "probe the app when useful" is exactly what produced Books
// authored entirely from source, with no assertions and criteria the rendered
// page could not answer.
function exploreSection(drillBaseUrl, root) {
  const q = (o) => JSON.stringify(JSON.stringify({ root, ...o }));
  return [
    `LOOK AT THE APP. This is not optional and it is not a formality - it is how you decide what is worth`,
    `checking and how you write a check that can actually be answered. Drill drives a real browser for you`,
    `and every open/act/observe reply names a screenshot file: READ that file with the Read tool. Your own eyes are the`,
    `vision here; nothing behind these endpoints calls a model.`,
    ``,
    `  # go to a page (path resolves against the Book's app.url; viewport: desktop|tablet|mobile)`,
    `  curl -sS -X POST ${drillBaseUrl}/api/explore/open -H 'content-type: application/json' \\`,
    `    -d ${q({ path: "/some/route" })}`,
    ``,
    `  # click/type/etc, then see the page it produced`,
    `  curl -sS -X POST ${drillBaseUrl}/api/explore/act -H 'content-type: application/json' \\`,
    `    -d ${q({ action: { kind: "click", role: "button", name: "Save" } })}`,
    ``,
    `  # explicitly re-observe the current page without inventing a hover or shell sleep`,
    `  curl -sS -X POST ${drillBaseUrl}/api/explore/observe -H 'content-type: application/json' -d ${q({})}`,
    ``,
    `  # ask whether a candidate assertion is TRUE of the page right now`,
    `  curl -sS -X POST ${drillBaseUrl}/api/explore/assert -H 'content-type: application/json' \\`,
    `    -d ${q({ assertion: { kind: "visible", role: "button", name: "Save" } })}`,
    ``,
    `  # when you are completely finished exploring`,
    `  curl -sS -X POST ${drillBaseUrl}/api/explore/close -H 'content-type: application/json' -d ${q({})}`,
    ``,
    `open/act/observe return: observationId, url, title, heading, screenshot (a .jpg or image path - Read it),`,
    `elements (role+name pairs), consoleErrors, quiet (bounded DOM/network inactivity, NOT proof that`,
    `the page is semantically ready), network`,
    `(sanitised requests since navigation), and browserContext. These are a RECEIPT for the exact route,`,
    `viewport, browser context and time you actually saw. persistentProfile and tab/navigation ages`,
    `describe continuity only; they do NOT prove that an auth token or other app state is fresh. act takes ONE resolved`,
    `action: {kind: click|fill|select|check|hover|press, plus a locator - role+name, testId, label,`,
    `placeholder, or selector - and value for fill/select/press}.`,
    ``,
    `Do not fake settling with sleep, a no-op hover, or repeated screenshots until one tells the story you`,
    `expected. The observation endpoint already performs the bounded DOM/network inactivity check. A screenshot of a loader`,
    `proves only that the loader was visible in that finite observation; it does NOT prove that a request`,
    `hung, that the API was healthy, or that the page "never resolves". Use the response's quiet + network`,
    `fields. Re-open the route to take an independent sample. Describe a finite deadline miss with its real`,
    `conditions, never as "forever", "indefinitely", or "never". A curl to an API is a different client,`,
    `auth context and request path and cannot corroborate what the browser received.`,
    ``,
    `Work page by page: open it, read the screenshot, then USE it - click the menus, open the dialogs,`,
    `submit the forms, try the empty and error paths. You cannot plan a page you have only read the source`,
    `of. If the app needs a login, log in through act (fill, fill, click) before exploring anything else.`,
    ``,
    `Author each page's file right after you finish exploring that page, not all of them at the end. A`,
    `plan that runs long is then still a plan: N complete pages on disk, rather than nothing.`
  ];
}

function planPrompt(root, { brief, runSkill, drillBaseUrl }) {
  const goal = brief
    ? [
        `Mode: UPDATE. A change landed and the Drill Book must cover it. The change brief:`,
        ``,
        `${brief}`,
        ``,
        `Update the Book for this change: add/update the pages, areas, steps, and states it touches.`,
        `Preserve everything else - existing page files, step ids, manual edits, and the Book's`,
        `settings (autonomy, viewports, fullDrill, globalRules) stay unless the change invalidates them.`,
        `While you are in a page file, ALSO retro-fit \`actions\` onto any EXISTING step whose`,
        `description asserts a behaviour but carries no actions - those checks are currently judged`,
        `against an untouched page and cannot prove what they claim. Adding the missing actions is a`,
        `correction, not a rewrite: leave the id, description and every other field alone.`
      ]
    : [
        `Mode: FULL PLAN. Author the Drill Book for the ENTIRE project on your best judgment - the works:`,
        `An ABSENT drills/ directory means author a fresh Book, and nothing else. Do not restore one from`,
        `git (no checkout, no revert, no reading it out of a past commit): a Book is removed deliberately,`,
        `because it was authored under rules that no longer hold, and resurrecting it re-imports exactly`,
        `the mistakes the removal was meant to clear. Missing is an instruction, not damage.`,
        `every real user-facing page, what matters on it, how to verify it (functionality, UX quality,`,
        `visual polish, responsive behavior), and the page states worth pinning (logged out, empty,`,
        `populated, error). If a Book already exists, extend and correct it - never discard manual work.`,
        `If the app is login-gated (its pages are unreachable without a session), you MUST author the`,
        `Book's auth block with real test credentials - otherwise every check just lands on the login`,
        `screen and the whole run fails for one auth reason.`
      ];
  return [
    `You are Drill's planning stage: author the page-level visual QA plan (the Drill Book) for the app in this repo.`,
    `Project root: ${root}`,
    ``,
    `Do NOT take a repo planning lock or declare intent through any coordination tool, and do not wait on`,
    `one. You are a scoped worker: you write drills/*.yml and nothing else, so you cannot collide with the`,
    `code work those locks exist to serialise. Taking one costs real time and can strand the next plan -`,
    `Drill kills this session on cancel or timeout, which leaves the lease held with nobody to release it,`,
    `and the following plan then sits waiting out a dead agent's lock instead of exploring.`,
    ``,
    ...goal,
    ``,
    `How to work:`,
    `1. Get the ROUTE LIST from the router - the set of pages a USER visits, not API routes or build`,
    `   artifacts. That is all the codebase is for here, and it is minutes of work: list the route files,`,
    `   note which need auth, move on. Do NOT audit the code, read the test suite, or work through the`,
    `   project's docs and findings; you are planning what to CHECK on each page, and that is decided by`,
    `   looking at the page, not by reading about it. Time spent reading is time not spent exploring, and`,
    `   the exploring is what makes the plan worth anything.`,
    runSkill
      ? `2. The app must be SERVING before you can explore it. If it is not, start it through the "${runSkill}" skill (.claude/skills/${runSkill}/SKILL.md - start long-running processes detached with output to a log file).`
      : `2. The app must be SERVING before you can explore it. There is no run-* skill in this repo, so if it is not already serving, say so via DRILL_PLAN_FAILED rather than authoring a blind plan.`,
    ``,
    ...exploreSection(drillBaseUrl, root),
    ``,
    `3. Write the plan as YAML files in THIS repo (create the directories if missing):`,
    `   - drills/drillbook.yml - the Book`,
    `   - drills/pages/<pageId>.yml - one file per page`,
    ``,
    `drills/drillbook.yml fields:`,
    `  app: { name: <app name>, url: <base URL the app serves on, from the run skill/dev config, e.g. http://localhost:3000 - if the real URL cannot be determined from the code or run skill, leave url: '' and Drill adopts the true URL when it starts the app through the run skill> }`,
    `  fullDrill: true | false      (keep the existing value; default true for a fresh Book)`,
    `  autonomy: gated | auto       (keep existing; default gated)`,
    `  viewports: [desktop]         (add tablet/mobile ONLY when the app clearly targets them)`,
    `  globalRules: <KEEP the pre-plan value byte-for-byte. For a fresh Book write "". Planner sessions`,
    `               cannot prove arbitrary app-wide prose from route observations, so the integrity gate`,
    `               rejects additions and rewrites; only deletion-only cleanup of polluted legacy clauses`,
    `               is accepted. Current defects belong in report-only output, never global rules.>`,
    `  dispatch: manual             (keep existing)`,
    `  auth: <OMIT unless the app requires login to reach its real pages - otherwise EVERY check just sees the login screen and fails>`,
    `    loginPath: </login>              (the login route, resolved against app.url; omit if login is at the app root)`,
    `    steps:                           (ordered login actions, each a concrete instruction an agent executes on the login page)`,
    `      - fill the "Email" field with <the test email>`,
    `      - fill the "Password" field with <the test password>`,
    `      - click the "Sign in" button`,
    `    success: <a visible signal that proves login worked, e.g. "the app sidebar is visible and no login form remains" - lets the runner cheaply re-check the cached session instead of re-logging-in every run>`,
    `    cacheMinutes: 720                (optional; proactively re-run the full login flow once the cached session is older than this)`,
    `    (Use REAL working TEST credentials - they are committed with the Book and only ever run against the local/test app, never production. Discover them from the repo: seed/fixture users, .env.example, test setup, or the run skill. If you cannot find working test credentials, still author loginPath+steps+success with placeholders and note it - a login flow the user can fill in beats no auth at all.)`,
    `  pages: [{ id, title, path, mode: steps, selected: true }]   (the ledger: one entry per page FILE, and each entry's id MUST equal that file's id - same charset rule as below)`,
    ``,
    `drills/pages/<pageId>.yml fields (EVERY step field below is REQUIRED on every step EXCEPT \`actions\`, which is optional in general but MANDATORY for behavioural checks - see below; a step missing a required field may be skipped or misrouted by the runner):`,
    `  id: <pageId>                 (MUST match the filename and use only [A-Za-z0-9_-])`,
    `  title: <human title>`,
    `  path: </route/path>          (resolved against app.url)`,
    `  mode: steps`,
    `  areas:                       (keep EXACTLY what the page file already has - human-picked on the live screencast, never remove or rewrite them; for a NEW page write areas: [] and use area: 0 steps)`,
    `  steps:                       (the heart of the plan - be thorough, cover the page)`,
    `    - id: <slug, unique in the page, [A-Za-z0-9_-]>`,
    `      area: 0                  (0 = page-level; only reference an area number that already exists)`,
    `      mode: vision | e2e       (set by the routing rule in HOW EACH CHECK IS ANSWERED, below)`,
    `      enabled: true`,
    `      viewports: <copy the Book's viewports list here, unless the step is genuinely specific to one viewport>`,
    `      state: default           (READ THIS TWICE. A normal Run executes ONLY state: default steps; a state-scoped step runs`,
    `                                nowhere except a run that explicitly targets that state. So a page whose every step carries`,
    `                                a named state executes ZERO checks and is silently dead coverage. The DEFAULT state of a`,
    `                                page is however it looks when you navigate straight to it - for a login route that IS the`,
    `                                logged-out form, even if a leftover session happened to redirect you the first time you`,
    `                                looked. Environmental setup (log in, log out, seed a record) belongs in the Book's auth`,
    `                                block or in the check's own actions, NEVER in a state that the normal run skips. Name a`,
    `                                state only for a MINORITY of checks describing a condition the page can also be seen`,
    `                                without - an error banner, a populated list against an empty one. If you catch yourself`,
    `                                giving every step on a page the same named state, that state is the page's default: write`,
    `                                state: default.)`,
    `      description: <the check, written as a concrete acceptance criterion an agent verifies on the page AFTER this step's actions have run. If the criterion is about what HAPPENS when the user interacts - clicks, presses, types, submits, hovers, drags, scrolls - you MUST also author \`actions\` below; the description alone never makes the interaction happen.>`,
    `      authoringObservation:       (OPTIONAL; bounded provenance for what you actually observed,`,
    `                                  separate from the timeless acceptance criterion in description)`,
    `        kind: snapshot`,
    `        receipts: [<observationId returned by open/act/observe>]`,
    `      (snapshot accepts open/observe/act receipts, but Drill does not yet persist or replay the exact`,
    `       ordered locator/value sequence needed to attest an interaction. Keep interaction findings report-only.)`,
    `      (A receipt must come from THIS plan, the same route+viewport, and a screenshot you Read. The`,
    `       integrity gate quarantines a new empirical claim without one and restores an unsupported rewrite`,
    `       of an existing check. Drill does not yet issue the multi-sample/correlated evidence needed for`,
    `       timeout or data-mismatch provenance: keep those report-only, not Book facts. Independent curl`,
    `       output is not browser evidence. Keep dates, "Observed at authoring time", diagnoses and current defect`,
    `       prose OUT of description; the plan session and this structured field carry provenance.)`,
    `      actions: []              (OPTIONAL, ordered - the interactions performed on the page BEFORE this check is judged. Same vocabulary as the Book's auth.steps and a state's reachPath: one plain-English instruction per entry, e.g. "click the \"Anexar\" button", "type \"hello\" into the composer", "press Shift+Enter". Entries are bare strings, or { id: <slug>, description: <action> } for a stable id.)`,
    `      (REQUIRED whenever the description asserts a BEHAVIOUR rather than a static fact about the page as it first loads. WHY THIS MATTERS: without actions the runner only navigates and looks, so a behavioural check is judged against an untouched page - it then passes or fails on evidence that cannot show the behaviour either way, which is a WRONG verdict, and a passing one gets committed as a spec that never performs the behaviour. A behavioural description with no actions is a mis-authored check.)`,
    `      (Keep actions minimal and page-local. If reaching the state takes more than a few actions, or several checks need the same setup, author a state with a reachPath instead and scope those steps to it.)`,
    `      tags: []`,
    `      judgment: true | false   (true when the check needs ONGOING model judgment even after graduation - subjective quality, generative output)`,
    `      assertion: <OMIT unless this is a LANE A check - see below>`,
    `      assertionSource: authored  (write this whenever you write an assertion, and only then)`,
    ``,
    `HOW EACH CHECK IS ANSWERED - route every check into exactly one of three lanes.`,
    `Every check you leave in lane B or C costs a model call per run, forever. Lane A costs nothing after`,
    `you write it. So prefer lane A wherever the criterion honestly fits, and never force one that does not.`,
    ``,
    `LANE A - deterministic, no model at run time. A static fact about the page as it LOADS: an element is`,
    `  present/absent, a count, visible text, the URL. Author it as:`,
    `      mode: e2e`,
    `      assertion: { ... }         (one of the five kinds below)`,
    `      assertionSource: authored`,
    `  You MUST validate it first: navigate to the page with /api/explore/open, then POST the exact`,
    `  assertion to /api/explore/assert and confirm passed:true. That endpoint is the same evaluator the`,
    `  run uses, so a passing answer means the check will pass. If it comes back false, your assertion is`,
    `  wrong - fix it or drop it. NEVER write an assertion you did not see return passed:true.`,
    `  Drill records that exact passed assertion against the current route+viewport. After the session it`,
    `  mechanically marks every new or semantically changed assertion assertionSource: authored; if no`,
    `  matching receipt exists it removes the unproven assertion and safely falls the check back to vision.`,
    `  Until Drill can bind and replay an exact setup/action sequence, only assertions on the untouched`,
    `  default state (no step actions) are eligible for this shortcut; stateful or behavioural checks stay vision.`,
    `  The five kinds (nothing else is valid):`,
    `      { kind: visible,           role|testId|label|placeholder|selector, name?: <accessible name> }`,
    `      { kind: count,             role|testId|selector, name?, op: eq|gte|lte|gt|lt, value: <n> }`,
    `      { kind: text-contains,     text: <substring of the title, main heading, or any element name> }`,
    `      { kind: url-matches,       pattern: <substring>, mode?: regex }`,
    `      { kind: attribute-equals,  role|testId|selector, name?, attribute: <attr>, value: <expected> }`,
    ``,
    `LANE B - behavioural: the criterion is about what HAPPENS when the user interacts. Author \`actions\``,
    `  (plain English, above) and NO assertion, mode: vision. The first run drives your actions through a`,
    `  model once, records the concrete Playwright it resolved, and pins it - every later run replays that`,
    `  deterministically. So lane B costs the model once, not forever. Do not try to pre-resolve it here.`,
    ``,
    `LANE C - judgment: the criterion is genuinely subjective (visual polish, tone, whether generated`,
    `  content reads correctly). mode: vision, judgment: true, no assertion. This one always costs a model`,
    `  call, by design. Use it only where a machine truly cannot answer.`,
    ``,
    `A check can be lane A even on a page that needed interaction to REACH - reaching is what states and`,
    `reachPath are for. Lane B is for criteria whose SUBJECT is the interaction.`,
    ``,
    `One honest exception: a criterion whose acceptable outcome is a DISJUNCTION ("the page settles into`,
    `either the empty state or a list of entries") cannot be written as any single assertion, and is not`,
    `subjective either. Leave it mode: vision with no assertion and no judgment - vision answers it, and`,
    `the first passing run graduates it to whichever alternative actually held. Do not force such a check`,
    `into lane A by picking one branch; that turns a legitimate either/or into a check that fails whenever`,
    `the other, equally correct, outcome occurs.`,
    `  states:                      (only for pages with meaningfully distinct states)`,
    `    - id: <slug>`,
    `      label: <human label>`,
    `      reachPath: [{ id: <slug>, description: <one natural-language action an agent executes to move toward the state, e.g. "log in as the demo user"> }]`,
    `      (reachPath moves the PAGE into a named state SHARED by many steps; a step's own \`actions\` are the one-off interactions a SINGLE check needs. When a step is state-scoped, its actions run after the reach path.)`,
    ``,
    `Do not add or rewrite globalRules. Route receipts are not predicate-specific evidence for arbitrary`,
    `app-wide prose, so the integrity gate restores the pre-plan value even if you sampled several pages.`,
    `Only deletion-only cleanup of a polluted legacy clause is accepted. One stale browser context, one screenshot, a health counter, or a`,
    `separate curl never proves that every authenticated request or every page is broken. Do not mutate app`,
    `source or backend data to manufacture a plan; if the environment blocks exploration, keep the normative`,
    `coverage you can support and report the blocker. Removing a pre-plan page/step or deselecting coverage`,
    `is allowed to remain on disk but is always flagged needs-attention, so an unattended plan-then-run stops.`,
    ``,
    `Write valid YAML; after writing, re-read every file you wrote and confirm it parses. Keep descriptions self-contained - the run agent sees the description and the page, nothing else.`,
    ``,
    `This is a ONE-SHOT session: there is no later turn. Do not schedule a wakeup, defer work, or end your`,
    `turn to wait for anything - when you stop, the session is over and whatever you had not written is`,
    `lost. If something genuinely blocks you, finish what you can, then print the failure line below.`,
    ``,
    `Final line contract (exactly one of these, as the LAST line you print):`,
    `- Success: DRILL_PLAN_OK=<number of page files you authored or updated>`,
    `- Already covered (you verified the Book and changed NOTHING): DRILL_PLAN_OK=0`,
    `- Failure: DRILL_PLAN_FAILED=<one-line reason>`
  ].join("\n");
}

// Final-line contract: when both sentinels appear (an early failure the agent
// then recovered from, or the reverse), the one printed LAST wins.
function parseSentinel(logText) {
  let ok = null, okIdx = -1, failed = null, failIdx = -1;
  for (const m of logText.matchAll(/^DRILL_PLAN_OK=(\S+)\s*$/gm)) { ok = m[1]; okIdx = m.index; }
  for (const m of logText.matchAll(/^DRILL_PLAN_FAILED=(.+)$/gm)) { failed = m[1].trim(); failIdx = m.index; }
  if (ok !== null && failed !== null) {
    if (okIdx > failIdx) failed = null;
    else ok = null;
  }
  return { ok, failed };
}

// Dead coverage, found on the first real plan: every check the agent authored
// for the login page carried `state: logged-out`, because a leftover session
// had redirected it on the way in and it decided the form was a special
// condition. A normal run executes ONLY default-state checks, so that page was
// worth exactly zero checks - and nothing anywhere said so. The page listed ten
// checks in the Book, the Authoring list showed an empty page, and a run would
// have reported it as covered.
//
// The prompt now explains the rule, but a rule the model can misapply silently
// needs a gate as well as an explanation. These are warnings, not failures: the
// rest of a long plan is real work and must not be thrown away over one page.
export async function deadCoverageWarnings(root) {
  const warnings = [];
  for (const meta of await listPages(root).catch(() => [])) {
    const page = await getPage(meta.id, root).catch(() => null);
    const steps = (page?.steps ?? []).filter((s) => s.enabled !== false);
    if (!steps.length) {
      warnings.push(`page "${meta.id}" has no enabled checks`);
      continue;
    }
    if (!steps.some((s) => (s.state ?? "default") === "default")) {
      const states = [...new Set(steps.map((s) => s.state))].join(", ");
      warnings.push(
        `page "${meta.id}" runs NOTHING on a normal run: all ${steps.length} checks are scoped to ${states}. ` +
        `A page's default state is how it looks when you navigate straight to it - re-scope these to state: default.`
      );
    }
  }
  return warnings;
}

// Exported so the server can serve a job's log tail directly - the error
// strings elsewhere in this app already point the user at "the plan log";
// this is what finally lets that be a real link instead of a dead end.
export async function logTail(file, bytes = 64000) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.length > bytes ? text.slice(-bytes) : text;
  } catch {
    return "";
  }
}

// ── disk-evidence snapshot ──────────────────────────────────────────────────
// mtime+size of every file under drills/, taken before the agent spawns. An
// OK sentinel claiming n>0 authored pages must be backed by at least one
// changed/added/removed file - a pre-existing Book satisfying the pages>0
// check is NOT evidence the agent did anything (the UPDATE-mode no-op hole).

async function snapshotDrills(root) {
  const out = new Map();
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try { const s = await fs.stat(p); out.set(p, `${s.mtimeMs}:${s.size}`); } catch { /* raced a delete */ }
      }
    }
  }
  await walk(path.join(root, "drills"));
  return out;
}

async function drillsChangedSince(root, before) {
  const after = await snapshotDrills(root);
  if (after.size !== before.size) return true;
  for (const [file, sig] of after) {
    if (before.get(file) !== sig) return true;
  }
  return false;
}

export function publicPlanJob(job) {
  if (!job) return null;
  // proc (the live ChildProcess), snapshot (a Map), and the parsed pre-plan
  // baseline never belong in the wire payload. The baseline may contain Book
  // auth actions as well as every acceptance criterion; it exists solely for
  // the post-agent integrity comparison.
  const { proc, snapshot, baseline, ...rest } = job;
  return rest;
}

export function getPlanJob(root) {
  return jobs.get(root) ?? null;
}

export function inFlightPlanConflict(existing, brief) {
  if (!existing || existing.status !== "planning") return false;
  const requested = typeof brief === "string" ? brief.trim() : "";
  if (!requested) return false;
  const active = typeof existing.brief === "string" ? existing.brief.trim() : "";
  return requested !== active;
}

// Kick (or return the already-running) plan job for `root`. Resolution
// happens in a detached poll loop; callers watch GET /api/plan/status.
export async function startPlan({ root, brief = null, timeoutMs = defaultTimeoutMs(), drillBaseUrl = "http://127.0.0.1:7096" }) {
  const existing = jobs.get(root);
  if (existing && existing.status === "planning") {
    if (inFlightPlanConflict(existing, brief)) {
      throw new Error("a different plan is already running for this project - wait for it to finish before starting this update");
    }
    return existing;
  }

  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
  // A pinned session id (accepted by `-p`, not banned by the headless-purge
  // policy) is what lets progress be derived from the session's OWN
  // transcript JSONL - see planProgress - without adding any banned flag
  // (--output-format stream-json) to the model-call surface.
  const sessionId = randomUUID();
  // Registered BEFORE any await: two concurrent kicks for the same root must
  // not both pass the in-flight guard and spawn two agent sessions.
  const job = {
    root, mode: brief ? "update" : "full", brief, status: "planning",
    startedAt, endedAt: null, deadlineAt, canceledAt: null, sessionId, logFile: null, error: null,
    pages: null, noop: false, needsAttention: false, warnings: [], integrity: null,
    agentPid: null, agentExited: null, proc: null, snapshot: null, baseline: null
  };
  jobs.set(root, job);
  const finish = (status, patch = {}) => {
    Object.assign(job, patch, { status, endedAt: new Date().toISOString() });
    clearJobRecord(root);
    // The plan session owns the exploration tab; a plan that ends any way at
    // all (done, failed, timed out, killed) must not leave a driven browser
    // tab behind for the next one to inherit mid-flow.
    explore.closeExplore({ root }).catch(() => {});
  };

  let logStream;
  try {
    // If a pid record survived (a previous server process died mid-plan and
    // the boot reap has not run for this root), reap that agent NOW - never
    // let two sessions author the same drills/ tree concurrently.
    try {
      const rec = JSON.parse(await fs.readFile(jobRecordPath(root), "utf8"));
      if (recordNamesLiveAgent(rec)) { try { process.kill(rec.pid, "SIGKILL"); } catch { /* raced its exit */ } }
      await clearJobRecord(root);
    } catch { /* no record - the normal case */ }

    // Both snapshots are taken before the child exists. `snapshot` is the
    // pre-guard filesystem proof used by the OK-sentinel discipline; `baseline`
    // is parsed private state used only after that decision to establish
    // assertion/observation provenance.
    [job.snapshot, job.baseline] = await Promise.all([
      snapshotDrills(root),
      capturePlanBaseline(root)
    ]);
    await fs.mkdir(logDir(), { recursive: true });
    job.logFile = path.join(logDir(), `${safeName(root)}-${Date.now()}.log`);
    await fs.writeFile(job.logFile, `[drill plan] ${startedAt} mode=${job.mode} root=${root} session=${sessionId}\n`, "utf8");
    logStream = await fs.open(job.logFile, "a");
  } catch (err) {
    // Must not leave the placeholder stuck in "planning" - it would block
    // every future kick for this root.
    finish("failed", { error: err.message });
    return job;
  }
  const closeLog = () => logStream.close().catch(() => {});

  // A cancel can land in the window between registering the job and actually
  // spawning (the awaits above) - never spawn an agent for a job that is no
  // longer "planning" by the time setup finished.
  if (job.status !== "planning") {
    closeLog();
    return job;
  }

  const bin = process.env.DRILL_AGENT_CMD || "claude";
  const proc = spawn(bin, [
    "-p", planPrompt(root, { brief, runSkill: findRunSkill(root), drillBaseUrl }),
    "--permission-mode", "bypassPermissions",
    "--session-id", sessionId
  ], {
    cwd: root,
    stdio: ["ignore", logStream.fd, logStream.fd],
    env: process.env
  });
  job.proc = proc;
  job.agentPid = proc.pid;
  // 'error' (e.g. binary not on PATH) never fires 'exit', so both handlers
  // close the log handle (close is idempotent-guarded by the catch). A
  // signal death passes code=null - record it as "signal:<name>" so the poll
  // loop's exited check still trips (an OOM-killed agent must fail fast, not
  // sit "planning" until the deadline while blocking every re-kick).
  proc.on("error", (err) => { closeLog(); finish("failed", { error: `${bin}: ${err.message}` }); });
  proc.on("exit", (code, signal) => { job.agentExited = code ?? `signal:${signal}`; closeLog(); });
  // The record must be durable BEFORE the kick response goes out: a server
  // that dies right after spawning (crash, OOM, restart) with the write
  // still queued leaves an unreapable orphan - the double-spawn this record
  // exists to prevent. A record-write failure still must not kill the plan.
  await writeJobRecord(job).catch(() => {});

  const deadline = Date.now() + timeoutMs;
  (async () => {
    while (job.status === "planning") {
      // Sentinels are judged ONLY after the agent exits. The contract is
      // "the LAST line you print" and a -p session exits right after it -
      // parsing mid-run would race an early FAILED line the agent then
      // recovers from (or a half-flushed OK) into a wrong terminal state.
      // The exit flag is captured BEFORE the read, so the log is complete
      // when parsed and last-sentinel-wins is deterministic. Costs at most
      // one 2s poll of extra latency after exit.
      const exitedAtRead = job.agentExited;
      if (exitedAtRead !== null) {
        const sentinel = parseSentinel(await logTail(job.logFile));
        if (sentinel.failed) {
          finish("failed", { error: sentinel.failed });
        } else if (sentinel.ok) {
          // Verify-step discipline: the sentinel claims a Book exists -
          // check the disk (pinned root) before believing it. OK=0 is the
          // agent's explicit "already covered, changed nothing" claim; any
          // other OK must be backed by an actual change under drills/.
          const pages = await listPages(root).catch(() => []);
          const claimedNoop = Number(sentinel.ok) === 0;
          if (pages.length === 0) {
            finish("failed", { error: "agent reported DRILL_PLAN_OK but no readable page files exist under drills/pages/ (see log)" });
          } else if (!claimedNoop && !(await drillsChangedSince(root, job.snapshot))) {
            finish("failed", { error: `agent reported DRILL_PLAN_OK=${sentinel.ok} but nothing under drills/ changed (see log)` });
          } else {
            // IMPORTANT: integrity may itself rewrite page YAML (mark an
            // assertion authored, downgrade one to vision, quarantine a new
            // unsupported finding). It runs only AFTER the independent
            // filesystem-change decision above so its own writes can never
            // vouch for a lying DRILL_PLAN_OK sentinel.
            const integrity = await applyPlanIntegrity({
              root,
              baseline: job.baseline,
              startedAt: job.startedAt,
              evidence: {
                getObservation: (id) => explore.getExploreObservation?.(root, id) ?? null,
                listObservations: () => explore.listExploreObservations?.(root) ?? [],
                hasPassedAssertion: (assertion, constraints) =>
                  explore.hasPassedExploreAssertion?.(root, assertion, constraints) ?? false
              }
            });
            finish("done", {
              pages: pages.length,
              noop: claimedNoop,
              needsAttention: integrity.needsAttention,
              integrity: {
                quarantined: integrity.quarantined,
                restoredSteps: integrity.restoredSteps,
                downgradedAssertions: integrity.downgradedAssertions,
                globalRulesRestored: integrity.globalRulesRestored,
                globalRulesEvidenceRoutes: integrity.globalRulesEvidenceRoutes,
                removedCoverage: integrity.removedCoverage,
                provenanceRepairs: integrity.provenanceRepairs,
                bookConfigRepairs: integrity.bookConfigRepairs,
                bookConfigReviews: integrity.bookConfigReviews
              },
              warnings: [
                ...integrity.warnings,
                ...await deadCoverageWarnings(root).catch(() => [])
              ]
            });
          }
        } else {
          finish("failed", { error: `agent session ended (exit ${exitedAtRead}) without printing a DRILL_PLAN_OK/DRILL_PLAN_FAILED line (see log)` });
        }
        break;
      }
      if (Date.now() > deadline) {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        finish("failed", { error: `planning did not finish within ${Math.round(timeoutMs / 1000)}s (see log)` });
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })().catch((err) => finish("failed", { error: err.message }));

  return job;
}

// ── cancel ───────────────────────────────────────────────────────────────
// A distinct terminal status, never "failed" - a user-requested stop is not
// an error, and the UI/API must say so honestly. Unlike the deadline timeout
// (which also SIGKILLs), this is reachable at any point in a live plan, so a
// pre-spawn race (see the guard in startPlan) is the only other place a plan
// job can end without ever running an agent.
export async function cancelPlan(root) {
  const job = jobs.get(root);
  if (!job || job.status !== "planning") return { canceled: false, job: publicPlanJob(job) };
  try { job.proc?.kill("SIGKILL"); } catch { /* already gone */ }
  Object.assign(job, { status: "canceled", error: null, canceledAt: new Date().toISOString(), endedAt: new Date().toISOString() });
  await clearJobRecord(root);
  await explore.closeExplore({ root }).catch(() => {});
  return { canceled: true, job: publicPlanJob(job) };
}

// ── progress ─────────────────────────────────────────────────────────────
// Durable, on-disk evidence of whether a running plan is alive or hung - a
// healthy 11-minute plan and a genuine hang were otherwise indistinguishable
// (the dogfood bug this exists to close). Every field degrades to null/0
// rather than throwing: progress is a nice-to-have overlay on the job, never
// a reason the status route itself can fail.

function transcriptProjectsDir() {
  return process.env.DRILL_PLAN_TRANSCRIPT_DIR
    || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

// The CLI slugs cwd into the transcript directory name; rather than
// reimplementing that rule, glob one level down for the pinned session id -
// exactly one project directory holds any given session's transcript.
export async function findPlanTranscriptFile(sessionId) {
  const base = transcriptProjectsDir();
  let dirs;
  try { dirs = await fs.readdir(base, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const candidate = path.join(base, d.name, `${sessionId}.jsonl`);
    try { await fs.access(candidate); return candidate; } catch { /* not here */ }
  }
  return null;
}

// A short human-readable description of the most recent transcript event -
// the latest assistant tool_use (rendered as "<ToolName>: <input hint>") or
// assistant text. Tolerates a half-written last line (the transcript is
// being appended to live) by scanning backward and skipping parse failures.
function summarizeLastActivity(tailText) {
  const lines = tailText.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let evt;
    try { evt = JSON.parse(lines[i]); } catch { continue; }
    const content = evt?.message?.content;
    if (!Array.isArray(content)) continue;
    const toolUse = content.find((b) => b?.type === "tool_use");
    if (toolUse) {
      const input = toolUse.input ?? {};
      const hint = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? "";
      return hint ? `${toolUse.name}: ${String(hint).slice(0, 120)}` : String(toolUse.name);
    }
    const text = content.find((b) => b?.type === "text")?.text;
    if (text) return String(text).trim().slice(0, 160) || null;
  }
  return null;
}

export async function planProgress(job) {
  const out = {
    transcriptBytes: 0, transcriptEvents: 0, lastActivityAt: null, lastActivity: null,
    drillsFilesChanged: 0, pagesAuthored: 0
  };
  if (!job) return out;
  try {
    const pages = await listPages(job.root);
    out.pagesAuthored = pages.length;
  } catch { /* no readable pages yet - stays 0 */ }
  try {
    if (job.snapshot) {
      const after = await snapshotDrills(job.root);
      let changed = 0;
      for (const [file, sig] of after) if (job.snapshot.get(file) !== sig) changed++; // added or modified
      for (const file of job.snapshot.keys()) if (!after.has(file)) changed++; // removed
      out.drillsFilesChanged = changed;
    }
  } catch { /* best-effort */ }
  try {
    const file = job.sessionId && await findPlanTranscriptFile(job.sessionId);
    if (file) {
      const stat = await fs.stat(file);
      out.transcriptBytes = stat.size;
      out.lastActivityAt = stat.mtime.toISOString();
      const tail = await logTail(file, 32000);
      out.transcriptEvents = tail.split("\n").filter(Boolean).length;
      out.lastActivity = summarizeLastActivity(tail);
    }
  } catch { /* transcript absent/unreadable - progress stays at defaults */ }
  return out;
}

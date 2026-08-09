// Thin client over the kanban-loop own-port server's REST surface. Same-origin:
// the UI is served by that server, so all paths are relative.

export interface DispatchError {
  at: string;
  reason: string;
  listId: string;
  message: string;
}

// Per-turn routing attribution (the gateway's `done` event surfaces which
// runtime/model/tier actually served a routed phase turn; null for legacy non-routed turns). Stamped
// on a `routed` event by the engine and surfaced on the card front as `lastRoute`.
// Every field is nullable — attribution is best-effort, never load-bearing.
export interface RouteStamp {
  targetId: string | null;
  runtime: string | null;
  provider: string | null;
  model: string | null;
  /** Policy-requested reasoning effort. */
  effort?: string | null;
  /** True/false only when the serving runtime reported application truth. */
  effortApplied?: boolean | null;
  tier: string | null;
  phase?: string | null;
  // Pass-through of the gateway's turnAttribution block: WHO served the turn and
  // where. `account` is tri-state — absent means the gateway reported nothing (no
  // badge), null means the machine login (a real answer worth rendering).
  duty?: string | null;
  level?: number | null;
  skill?: string | null;
  via?: string | null;
  account?: string | null;
  accountSource?: string | null;
  project?: string | null;
  /** Which pinned dimensions the turn actually honoured. */
  overridesApplied?: string[] | null;
  /** Which it REFUSED, and why — e.g. a project that is not a repo under the dev root. */
  overridesRejected?: { field: string; reason: string }[] | null;
}

// One entry on a card's execution timeline (the Activity feed). `kind` drives the
// icon + accent: created | moved | recovered | dispatch | routed | parked | deferred |
// failed | inference. `detail` is the long form (e.g. the operative's full reply on a
// parked event). `route` is present on a `routed` event when the turn routed (runtime/
// model attribution shown in the Activity timeline).
export interface CardEvent {
  at: string;
  kind: string;
  message: string;
  detail?: string | null;
  route?: RouteStamp | null;
}

// The wait a card sits under while an earlier overlapping run stabilises/finishes
// (set by the engine at plan completion; cleared on release or a manual Start
// override). `until` names the release point the UI shows in the callout.
export interface WaitingOn {
  cardId: string;
  cardTitle?: string | null;
  grade: string;
  reason: string;
  until: string;
  thenTo?: string;
  rerun?: boolean;
  since?: string;
}

// The Drill handoff stamped on a card by "Send to Drill". `state` walks
// planning → running → passed | failed | error; the rest fills in as Drill learns it.
export interface DrillStamp {
  // `partial` = nothing failed, but some checks came back unproven — the change
  // is NOT fully verified, and must never render as a clean pass.
  state: "planning" | "running" | "passed" | "partial" | "failed" | "error";
  at: string;
  jobId?: string | null;
  runId?: string | null;
  runUrl?: string | null;
  jobUrl?: string | null;
  drillUrl?: string | null;
  findings?: number | null;
  checks?: number | null;
  failed?: number | null;
  unproven?: number | null;
  error?: string | null;
}

// The card's LATEST commit fence (S2, Q5) — the board shows the most recent one as a
// subtle chip; the full chain is not projected.
export interface FenceSummary {
  phase: string | null;
  sha: string | null;
  at: string | null;
}

// The abandonment prepared-revert descriptor (S2, Q7), thinned for the UI: its state,
// the commit COUNT, up to 20 short shas (for the detail's commit list), the
// conflictRisk count, and when it was prepared. A revert is only confirmable while
// state === "prepared"; "applied"/"conflict" are terminal states shown as a tag.
export interface PreparedRevertSummary {
  state: "prepared" | "applied" | "conflict" | string;
  commits: number;
  commitShas: string[];
  conflictRisk: number;
  preparedAt: string | null;
}

// Task ownership is independent of the execution work kind. Personal cards may
// still carry a real project and use any agent rail; unscoped means no project has
// been assigned yet.
export type CardScope = "personal" | "project" | "unscoped";

export interface CardSchedule {
  kind: "once" | "cron";
  action: "notify" | "run";
  at?: string;
  cron?: string;
  timezone: string;
  enabled: boolean;
  targetList: string;
  nextAt: string | null;
  lastAt: string | null;
  lastError?: string | null;
  snoozedUntil?: string | null;
  cutoverPending?: boolean;
  desiredEnabled?: boolean;
}

export interface DispatchRunProvenance {
  runId: string;
  machine: string;
  workerId?: string | null;
  phase?: string | null;
  state: "done" | "failed" | "cancelled" | string;
  claimedAt?: string | null;
  completedAt?: string | null;
  logIndex?: number | null;
  sessionId?: string | null;
  logCursor?: number | null;
  evidenceManifest?: Array<{ name: string; bytes: number; sha256: string }>;
}

export interface CardSummary {
  id: string;
  title: string;
  project: string | null;
  scope: CardScope;
  list: string;
  status: string;
  iterations: number;
  goalMode: boolean;
  rev: number;
  runId: string | null;
  runDir: string | null;
  sliceId: string | null;
  sessionIds: string[];
  briefPath: string | null;
  videoUrl: string | null;
  // S4 (D2/D17): run-policy fields — the work kind naming the card's rail, the
  // per-card phase toggle map (false = OFF, rendered dimmed, never hidden), the
  // tier, and who registered the run.
  flow?: string | null;
  phases?: Record<string, boolean> | null;
  tier?: string | null;
  /** RUN-SPEC-V1: what the user explicitly chose for this run. Absent/null on a
   *  fully-automatic card, which is every card by default. */
  routing?: CardRouting | null;
  origin?: string | null;
  placement?: { target: string; not_before?: string | null } | null;
  dispatch?: {
    machine: string;
    workerId?: string | null;
    runId?: string | null;
    phase?: string | null;
    state: "claimed" | "running" | "cancelling" | "done" | "failed" | string;
    claimedAt?: string | null;
    heartbeatAt?: string | null;
    releasedAt?: string | null;
    sessionId?: string | null;
    cancellation?: {
      state: "requested" | "timeout" | "acknowledged" | string;
      requestedAt?: string | null;
      deadlineAt?: string | null;
      acknowledgedAt?: string | null;
      detail?: string | null;
    } | null;
  } | null;
  /** Immutable provenance for every settled remote phase. Unlike `dispatch`,
   * these entries survive the next claim and keep completed Watch streams reachable. */
  dispatchRuns?: DispatchRunProvenance[];
  // D19: a quick card is a trivial-plan task the gateway ran inline and
  // auto-advanced to Done. The Done column groups quick cards under a collapsed
  // "quick tasks" strip.
  quick?: boolean;
  // The last dispatch failure: set on a transport defer or a gateway-unreachable
  // auto-dispatch; null after a successful run. The UI shows a badge + Retry.
  lastDispatchError: DispatchError | null;
  // Why a card is parked in the needs-attention column, and the list it came from.
  attentionReason: string | null;
  parkedFrom: string | null;
  // Coordination (GARRISON-FLOW-V2 S1): when this card is deferred behind an
  // overlapping same-project run, waitingOn names the blocker + why + the release
  // point; stabilityAt marks its own first-review stability; blocking lists the
  // cards waiting on THIS one (so a blocker can show "blocks N"). The UI renders a
  // waiting callout + chips in amber, distinct from the parked red.
  waitingOn?: WaitingOn | null;
  stabilityAt?: string | null;
  planCompletedAt?: string | null;
  blocking?: string[];
  // Coordination (GARRISON-FLOW-V2 S2): the latest commit fence (a subtle sha chip on
  // the card front) and the abandonment prepared-revert descriptor (the parked
  // revert-confirm block + the detail's commit list). Both null on a card with no
  // fences / no abandonment.
  fences?: FenceSummary | null;
  preparedRevert?: PreparedRevertSummary | null;
  // The card's Drill handoff (Send to Drill on a done card): its live state and,
  // once the run finishes, the verdict + a link into the Drill run. Null on a card
  // that was never sent.
  drill?: DrillStamp | null;
  // ── execution visibility ──────────────────────────────────────────────────
  // A short task description (card front tooltip + operative context); the operative's
  // last reply snippet (what it actually said); the most-recent timeline event + count
  // (the card front "last:" line; the full feed is on the detail); when the current run
  // started (drives the live elapsed timer); the live log tail for a running card; and
  // the no-project inference state (running | done | none | skipped | failed | null).
  description?: string;
  lastReply?: string | null;
  lastEvent?: CardEvent | null;
  // Per-phase runtime/model attribution for the card front: the most recent routed
  // event's route stamp, or null when no turn has routed yet / a legacy non-routed runtime. The board
  // renders a small "<phase> @ <model>" chip from it.
  lastRoute?: RouteStamp | null;
  // What the card WILL run on, resolved from its (duty, level) + current phase
  // against the runner-projected model. Present before and during a run, when
  // lastRoute is still null. Rendered dashed — expected, never a claim about
  // what actually served a turn.
  expectedRoute?: RouteStamp | null;
  eventCount?: number;
  runningSince?: string | null;
  liveTail?: string | null;
  inferState?: string | null;
  // A clarity-gated card starts the interactive Discuss duty when moved there.
  clarity?: string | null;
  // S3c: a mid-run revisit steering directive is pending (unapplied) on this card.
  steeringPending?: boolean;
  // D15 (S4a): the card's resolved leaf phase lists, in visit order (null on a legacy
  // / non-duty card). The Feedback sheet offers these as the phases to send a card
  // back to; without one it falls back to the board's agent lists.
  sequence?: string[] | null;
  // Card scheduling: held until this instant; what happens when it arrives
  // (notify | run); whether the due reminder already fired.
  scheduledFor?: string | null;
  scheduleAction?: "notify" | "run" | null;
  scheduleNotifiedAt?: string | null;
  schedule?: CardSchedule | null;
  scheduleTemplateId?: string | null;
  scheduleSystemKey?: string | null;
  occurrenceKey?: string | null;
  occurrenceAt?: string | null;
  systemKey?: string | null;
  morningBriefDelivery?: {
    completedAt?: string | null;
    calendar?: { status: string; detail?: string | null };
    web?: { status: string; detail?: string | null; threadId?: string | null };
    omi?: { status: string; detail?: string | null; threadId?: string | null };
  } | null;
  // Within-list ordering: explicit position (drag-reorder) or null = created order.
  position?: number | null;
  // Checklist progress for the card-front chip (full items on the detail).
  checklistTotal?: number;
  checklistDone?: number;
  created?: string | null;
  updated: string | null;
}

// One checklist item on a card. Whole-array replace on PATCH.
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  doneAt?: string | null;
}

export interface CardImportSourceList {
  id: string;
  title: string;
  archived?: boolean;
  count?: number;
  archivedCount?: number;
}

export interface CardImportPreview {
  preview: true;
  count: number;
  targetList: string;
  warnings: string[];
  sourceFormat: "garrison" | "trello";
  sourceName: string;
  sourceLists: CardImportSourceList[];
  excludedArchived?: number;
}

export interface CardImportResult {
  imported: number;
  targetList: string;
  warnings: string[];
  cards: CardSummary[];
  sourceFormat: "garrison" | "trello";
  sourceName: string;
}

// GET /board/runtime — channel discovery + gateway status for the board UI.
export interface BoardRuntime {
  webChannelEmbedId: string | null;
  webChannelUrl: string | null;
  gatewayBaseUrl: string | null;
  noGateway: boolean;
  /** Absolute kanban-store cards dir, so Discuss can hand the web channel an absolute,
   *  card-owned brief path (<cardsAbsDir>/<cardId>/brief.md). */
  cardsAbsDir?: string | null;
}

export interface ListView {
  id: string;
  title: string;
  order: number;
  kind: string;
  trigger: string;
  interactive: boolean;
  // D15: a list maps to a PHASE NAME and nothing else — skill/taskType/tier/mode
  // resolve from the compiled Orchestrator policy, never per list.
  phase?: string | null;
  terminal: boolean;
  notifyOnEntry: boolean;
  system?: boolean;
  validNext: string[];
  cards: CardSummary[];
}

export interface BoardView {
  version: number;
  lists: ListView[];
  cards: CardSummary[];
}

export interface ArtifactRef {
  kind: "serve" | "href" | "missing";
  /** The opaque ref token (e.g. "brief", "plan", "log:1") — used to PUT edits back. */
  ref?: string;
  path?: string;
  url?: string;
  href?: string;
  exists?: boolean;
  sessionId?: string;
  n?: number;
  // Evidence entries carry the file name + whether it's an image (rendered inline).
  name?: string;
  image?: boolean;
}

export interface CardLinks {
  plan: ArtifactRef | null;
  brief: ArtifactRef | null;
  gateMarkers: ArtifactRef | null;
  gates: ArtifactRef[];
  evidenceIndex: ArtifactRef | null;
  // The always-on evidence bundle (screenshots + an evidence.md log) the pipeline
  // produces even when the heavy video is skipped. Images render inline; the rest links.
  evidence: ArtifactRef[];
  sessions: ArtifactRef[];
  video: ArtifactRef | null;
  logs: ArtifactRef[];
}

// The full list config (GET /lists) — like ListView but WITHOUT the cards and
// WITH the full execute/router prompt bodies, which the board view omits. This is
// what the list-config editor reads + PATCHes.
export interface ListConfig {
  id: string;
  title: string;
  order: number;
  kind: string;
  trigger: string;
  // The cron a scheduler-beat list fires on (null for other triggers). Configured in
  // the list-config Schedule builder; only meaningful when trigger === "scheduler-beat".
  beatCron: string | null;
  interactive: boolean;
  terminal: boolean;
  system?: boolean;
  // D15: skill/taskType/tier/mode are GONE — a list maps to a phase name and
  // nothing else; resolution lives in the compiled Orchestrator policy.
  phase?: string | null;
  executePrompt: string;
  routerPrompt: string;
  validNext: string[];
}

// The board's GET /policy passthrough (D17): enough of the compiled policy to
// offer work kinds + per-card phase toggles at card creation.
export interface PolicyView {
  flows: Record<string, { phasePlan: string; description?: string }>;
  phasePlans: Record<string, { phases: Array<string | { id: string; on?: boolean }>; evidence?: string }>;
  defaultFlow: string | null;
  phases: string[];
  phaseSkills: { bindings: Record<string, string>; overrides: Record<string, Record<string, string>> };
}

/**
 * The card's explicit run spec (RUN-SPEC-V1). Structurally the same `TurnRouting`
 * pin the Web Channel sends, so both surfaces decide a run in one vocabulary.
 *
 * Every field is OPTIONAL and absent means AUTOMATIC — the orchestrator decides.
 * That is the default for every card; the controls exist to opt OUT of it.
 */
export interface CardRouting {
  /** A composition target id — picks runtime + provider + model coherently. */
  target?: string;
  /** Free-text model id, overlaid on the resolved target. */
  model?: string;
  effort?: string;
  duty?: string;
  level?: number;
  /** Dev-root child NAME (not a path) — the turn's cwd. */
  project?: string;
  account?: string;
  tier?: string;
  flow?: string;
  /** Comma-separated phase ids turned OFF for this run. */
  phasesOff?: string;
}

/** The gateway's routing vocabulary, proxied by the board. `sources.gateway: false`
 *  means the operative is down: the menus are empty for a REASON, and the UI says
 *  which rather than drawing dropdowns that would refuse everything. */
export interface RouteOptionsView {
  targets: { id: string; runtime?: string | null; provider?: string | null; model?: string | null; effort?: string | null }[];
  duties: { id: string; title?: string | null; levels?: { n: number; description?: string | null }[] | null }[];
  efforts: string[];
  accounts: { name: string; platform?: string | null }[];
  tiers: string[];
  flows: { id: string; description?: string | null; phases?: string[] | null }[];
  defaultFlow: string | null;
  projects: string[];
  sources: { gateway: boolean };
}

export interface ListsView {
  version: number;
  rev: number;
  lists: ListConfig[];
}

// The fields PATCH /lists/:listId accepts. All optional — only the keys present
// are applied. A manual list may only set title + validNext (the server rejects
// the rest with a 400).
export interface ListConfigPatch {
  title?: string;
  executePrompt?: string;
  routerPrompt?: string;
  validNext?: string[];
  trigger?: string;
  beatCron?: string | null;
  rev?: number; // board-level optimistic-concurrency token from GET /lists
}

// GET /projects — the dev-root repos for the New Card project picker (dev-env parity).
export interface ProjectsView {
  devRoot: string;
  projects: { name: string; path: string }[];
}

// GET /skills — the skills installed under ~/.claude/skills, for the list-config skill field.
export interface SkillsView {
  skills: { name: string; description: string }[];
}

export interface DecisionRun {
  mode?: string;
  model?: string;
  effort?: string;
  provider?: string;
  tier?: string;
  role?: string;
}

export interface CardDetail {
  card: CardSummary;
  links: CardLinks;
  decisionLog: DecisionRun[];
  // The full execution timeline, newest-first (the Activity feed).
  events?: CardEvent[];
  // Card attachments, two sources in one list: card-owned uploads
  // (uploaded: true, deletable, served by artifact ref) and the legacy
  // ClaudeChat description-block files (derived, read-only).
  attachments?: { i?: number; name: string; image: boolean; url: string; uploaded?: boolean }[];
  // The full checklist items (the summary carries only the counts).
  checklist?: ChecklistItem[];
}

async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) }
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      // API failures may expose a stable machine code in `error` while giving
      // the operator actionable context in `message`. Prefer that context, but
      // retain compatibility with older endpoints that only return `error`.
      if (typeof body?.message === "string" && body.message.trim()) msg = body.message;
      else if (typeof body?.error === "string" && body.error.trim()) msg = body.error;
    } catch { /* keep status */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export interface MachineOption {
  name: string;
  label: string;
  connected: boolean;
  pending?: boolean;
  isHost: boolean;
  bridge?: "connected" | "offline";
  worker?: {
    state: "ready" | "busy" | "degraded" | "offline";
    ready: boolean;
    stale?: boolean;
    detail?: string | null;
    error?: string | null;
    runtimes?: string[];
    currentCardId?: string | null;
    workerVersion?: string | null;
    protocolVersion?: string | null;
  };
}
export interface RemoteRuntimeRequirement {
  key: string;
  targetId: string;
  runtime: string;
  provider: string | null;
  model?: string | null;
  duty: string;
  level: number;
  phase: string;
}
export interface MachinesView {
  machines: MachineOption[];
  outpostsAvailable: boolean;
  reason?: string;
  defaultRuntime?: RemoteRuntimeRequirement | null;
}

export interface LoadoutEditorValue {
  id: string;
  repo_remote: string;
  default_branch: string;
  apm_manifest_path?: string;
  setup_commands: string[];
  env_vars: string[];
  verify_command: string;
  projects_root_override?: string;
}

export interface LoadoutReadiness {
  project: string;
  ready: boolean;
  status: "ready" | "missing" | "missing-vault-values" | "vault-locked" | "invalid" | "unavailable" | "unknown-project";
  detail: string;
  missing?: string[];
  editor?: LoadoutEditorValue;
}

export const api = {
  board: () => jfetch<BoardView>("/board"),
  runtime: () => jfetch<BoardRuntime>("/board/runtime"),
  lists: () => jfetch<ListsView>("/lists"),
  patchList: (id: string, body: ListConfigPatch) =>
    jfetch<{ list: ListConfig; rev: number }>(`/lists/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  exportBoardUrl: () => "/cards/export?download=1",
  exportListUrl: (id: string) => `/cards/export?list=${encodeURIComponent(id)}&download=1`,
  importCards: (body: {
    bundle: unknown;
    targetList?: string;
    preview?: boolean;
    sourceList?: string | null;
    includeArchived?: boolean;
  }) => jfetch<CardImportPreview | CardImportResult>("/cards/import", {
    method: "POST",
    body: JSON.stringify(body)
  }),
  card: (id: string) => jfetch<CardDetail>(`/cards/${encodeURIComponent(id)}`),
  projects: () => jfetch<ProjectsView>("/projects"),
  skills: () => jfetch<SkillsView>("/skills"),
  // Title is optional — the server infers it from the description when blank.
  // flow + phases (D17): the policy phase plan this run follows and the
  // per-card toggle map (false = OFF, recorded off, never silent).
  // `routing` is the card's explicit run spec (RUN-SPEC-V1) — the SAME TurnRouting
  // pin the Web Channel's rail produces. Every field is optional and an absent one
  // means automatic, which is the default for every card.
  // `placement` (brief D6) is WHERE the card runs: { target: "host" } (the
  // default) or a paired machine name. Absent means host, so an untouched picker
  // sends nothing at all.
  create: (body: { title?: string; description?: string; project?: string; scope?: CardScope; targetList?: string; goalMode?: boolean; flow?: string; phases?: Record<string, boolean>; routing?: CardRouting; continues?: string; placement?: { target: string; not_before?: string }; schedule?: CardSchedule | Omit<CardSchedule, "nextAt" | "lastAt">; scheduledFor?: string; scheduleAction?: "notify" | "run"; checklist?: ChecklistItem[] }) =>
    jfetch<{ card: CardSummary }>("/cards", { method: "POST", body: JSON.stringify(body) }),
  // Card scheduling: push the schedule out (or set one from now). The server
  // re-arms the due reminder; action defaults to the card's current one.
  snooze: (id: string, body: { minutes?: number; until?: string; action?: "notify" | "run" }) =>
    jfetch<{ card: CardSummary }>(`/cards/${encodeURIComponent(id)}/snooze`, {
      method: "POST",
      body: JSON.stringify(body)
    }),
  runScheduleNow: (id: string) =>
    jfetch<{ card: CardSummary; occurrence: boolean; created: boolean }>(`/cards/${encodeURIComponent(id)}/run-now`, {
      method: "POST"
    }),
  // Card-owned attachment upload (JSON base64, 10 MB cap). The file lands under
  // cards/<id>/attachments/ and is folded into the operative's dispatch prompt.
  uploadAttachment: (id: string, filename: string, contentBase64: string) =>
    jfetch<{ name: string; bytes: number; url: string }>(`/cards/${encodeURIComponent(id)}/attachments`, {
      method: "POST",
      body: JSON.stringify({ filename, content_base64: contentBase64 })
    }),
  deleteAttachment: (id: string, name: string) =>
    jfetch<{ ok: boolean; removed: string }>(
      `/cards/${encodeURIComponent(id)}/attachments?name=${encodeURIComponent(name)}`,
      { method: "DELETE" }
    ),
  // Column drag: persist the full column order (operator-owned, survives the
  // duty reconcile). `rev` is the board-level CAS token from GET /lists.
  reorderLists: (order: string[], rev?: number) =>
    jfetch<{ ok: boolean; order: string[] }>("/lists/reorder", {
      method: "POST",
      body: JSON.stringify({ order, ...(Number.isInteger(rev) ? { rev } : {}) })
    }),
  // Create a new column = create a composition-local duty (proxied to the
  // shell, which writes apm.yml, reprojects, and reconciles the board live).
  createList: (body: { title: string; id?: string; description?: string; target?: string; effort?: string }) =>
    jfetch<{ ok: boolean; dutyId?: string; reconciled?: boolean; error?: string }>("/lists", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  // Remove a column = deselect (and, when composition-local and unreferenced,
  // delete) its duty. Cards on the list are parked to Needs attention.
  deleteList: (id: string) =>
    jfetch<{ ok: boolean; dutyId?: string; reconciled?: boolean; reconcile?: { movedToAttention?: string[] } }>(
      `/lists/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),
  // GET /machines — the placement picker's vocabulary: the host plus every paired
  // outpost and whether it is connected right now. Degrades to host-only with a
  // `reason` when the outpost daemon is unreachable, so the picker is never an
  // unexplained empty menu.
  machines: () => jfetch<MachinesView>("/machines"),
  loadoutReadiness: (project: string) =>
    jfetch<LoadoutReadiness>(`/loadouts/${encodeURIComponent(project)}`),
  saveLoadout: (project: string, body: LoadoutEditorValue) =>
    jfetch<{ loadout: LoadoutEditorValue }>(`/loadouts/${encodeURIComponent(project)}`, {
      method: "POST",
      body: JSON.stringify(body)
    }),
  // GET /policy — the compiled Orchestrator policy passthrough (work kinds,
  // phase plans, bindings) for the card-create UI. 404 → no policy compiled.
  policy: () => jfetch<PolicyView>("/policy"),
  // GET /route-options — the board's same-origin proxy of the gateway's routing
  // vocabulary. The ONE source for every run-spec dropdown, so the form can never
  // offer a value the gateway would refuse.
  routeOptions: () => jfetch<RouteOptionsView>("/route-options"),
  patch: (id: string, body: Record<string, unknown>) =>
    jfetch<{ card: CardSummary }>(`/cards/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  del: (id: string) =>
    jfetch<{ ok: boolean; deleted: string; removed: string[] }>(`/cards/${encodeURIComponent(id)}`, {
      method: "DELETE"
    }),
  start: (id: string) =>
    jfetch<{ card: CardSummary; advanced?: string; outcome?: unknown }>(
      `/cards/${encodeURIComponent(id)}/start`,
      { method: "POST" }
    ),
  // Panic is a card-bound interrupt, not a move and not steering. The server asks
  // the gateway to stop only a turn that proves it contains this card; the engine
  // then parks the interrupted card(s) without accepting partial verdicts.
  panic: (id: string) =>
    jfetch<{
      ok: boolean;
      stopped: boolean;
      lane: string | null;
      affectedCardIds: string[];
      sharedBatch: boolean;
      message: string;
    }>(`/cards/${encodeURIComponent(id)}/panic`, { method: "POST" }),
  // Abandon a card: build a PREPARED (not applied) revert of its trailer-attributed
  // commits and park it in needs-attention. Human-only on the server.
  abandon: (id: string) =>
    jfetch<{ card: CardSummary; preparedRevert: PreparedRevertSummary | null }>(
      `/cards/${encodeURIComponent(id)}/abandon`,
      { method: "POST" }
    ),
  // Apply a card's prepared revert — an EXPLICIT confirm the server also requires
  // ({ confirm: true }); never auto-applied. Returns the descriptor's new state.
  revert: (id: string) =>
    jfetch<{ card: CardSummary; preparedRevert: PreparedRevertSummary | null; reverted?: string[] }>(
      `/cards/${encodeURIComponent(id)}/revert`,
      { method: "POST", body: JSON.stringify({ confirm: true }) }
    ),
  // Send a done card's change to Drill: it plans the checks for that change, runs
  // them, and notifies every way it can when the verdict is in. A second press
  // while a job is in flight joins it (started:false) rather than starting a rival.
  sendToDrill: (id: string) =>
    jfetch<{ card: CardSummary; job: { id: string; state: string } | null; started: boolean }>(
      `/cards/${encodeURIComponent(id)}/drill`,
      { method: "POST" }
    ),
  // Send feedback to a card (steering). `absorb` folds the message into the card's
  // context without moving it; `revisit` also re-stages the SAME card back to an
  // earlier phase (`revisitDuty`) so it runs through the pipeline again carrying the
  // feedback — the "it forgot part of the feature, send it back" path. `acknowledge`
  // just records a note. Same wire contract the web-channel steering uses.
  steer: (id: string, body: { message: string; action: "absorb" | "revisit" | "acknowledge"; revisitDuty?: string; reason?: string }) =>
    jfetch<{ ok: boolean; action: string; revisitDuty: string | null; applied: boolean }>(
      `/cards/${encodeURIComponent(id)}/steer`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  inferProject: (id: string) =>
    jfetch<{ card: CardSummary; inferring?: boolean; note?: string }>(
      `/cards/${encodeURIComponent(id)}/infer-project`,
      { method: "POST" }
    ),
  watchUrl: (id: string) => `/cards/${encodeURIComponent(id)}/watch`,
  artifactUrl: (ref: ArtifactRef | null) =>
    ref ? (ref.kind === "href" ? ref.href ?? null : ref.url ?? null) : null
};

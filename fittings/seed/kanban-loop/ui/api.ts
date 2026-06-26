// Thin client over the kanban-loop own-port server's REST surface. Same-origin:
// the UI is served by that server, so all paths are relative.

export interface DispatchError {
  at: string;
  reason: string;
  listId: string;
  message: string;
}

// One entry on a card's execution timeline (the Activity feed). `kind` drives the
// icon + accent: created | moved | recovered | dispatch | routed | parked | deferred |
// failed | inference. `detail` is the long form (e.g. the operative's full reply on a
// parked event).
export interface CardEvent {
  at: string;
  kind: string;
  message: string;
  detail?: string | null;
}

export interface CardSummary {
  id: string;
  title: string;
  project: string | null;
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
  // The last dispatch failure: set on a transport defer or a gateway-unreachable
  // auto-dispatch; null after a successful run. The UI shows a badge + Retry.
  lastDispatchError: DispatchError | null;
  // Why a card is parked in the needs-attention column, and the list it came from.
  attentionReason: string | null;
  parkedFrom: string | null;
  // ── execution visibility ──────────────────────────────────────────────────
  // A short task description (card front tooltip + operative context); the operative's
  // last reply snippet (what it actually said); the most-recent timeline event + count
  // (the card front "last:" line; the full feed is on the detail); when the current run
  // started (drives the live elapsed timer); the live log tail for a running card; and
  // the no-project inference state (running | done | none | skipped | failed | null).
  description?: string;
  lastReply?: string | null;
  lastEvent?: CardEvent | null;
  eventCount?: number;
  runningSince?: string | null;
  liveTail?: string | null;
  inferState?: string | null;
  updated: string | null;
}

// GET /board/runtime — channel discovery + gateway status for the board UI.
export interface BoardRuntime {
  webChannelEmbedId: string | null;
  webChannelUrl: string | null;
  gatewayBaseUrl: string | null;
  noGateway: boolean;
}

export interface ListView {
  id: string;
  title: string;
  order: number;
  kind: string;
  trigger: string;
  interactive: boolean;
  skill: string | null;
  taskType: string | null;
  tier: string | null;
  mode: string | null;
  terminal: boolean;
  notifyOnEntry: boolean;
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
  skill: string | null;
  executePrompt: string;
  routerPrompt: string;
  mode: string | null;
  // taskType/tier are no longer edited in the UI — a card routes through the
  // orchestrator, which classifies the tier itself. Kept on the type for back-compat
  // with the server payload (the fields persist but are inert).
  taskType: string | null;
  tier: string | null;
  validNext: string[];
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
  skill?: string | null;
  executePrompt?: string;
  routerPrompt?: string;
  validNext?: string[];
  trigger?: string;
  beatCron?: string | null;
  mode?: string | null;
  taskType?: string | null;
  tier?: string | null;
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
      if (body?.error) msg = body.error;
    } catch { /* keep status */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
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
  card: (id: string) => jfetch<CardDetail>(`/cards/${encodeURIComponent(id)}`),
  projects: () => jfetch<ProjectsView>("/projects"),
  skills: () => jfetch<SkillsView>("/skills"),
  // Title is optional — the server infers it from the description when blank.
  create: (body: { title?: string; description?: string; project?: string; goalMode?: boolean }) =>
    jfetch<{ card: CardSummary }>("/cards", { method: "POST", body: JSON.stringify(body) }),
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
  inferProject: (id: string) =>
    jfetch<{ card: CardSummary; inferring?: boolean; note?: string }>(
      `/cards/${encodeURIComponent(id)}/infer-project`,
      { method: "POST" }
    ),
  watchUrl: (id: string) => `/cards/${encodeURIComponent(id)}/watch`,
  artifactUrl: (ref: ArtifactRef | null) =>
    ref ? (ref.kind === "href" ? ref.href ?? null : ref.url ?? null) : null
};

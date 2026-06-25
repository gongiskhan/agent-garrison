// Thin client over the kanban-loop own-port server's REST surface. Same-origin:
// the UI is served by that server, so all paths are relative.

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
  updated: string | null;
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
}

export interface CardLinks {
  plan: ArtifactRef | null;
  brief: ArtifactRef | null;
  gateMarkers: ArtifactRef | null;
  evidenceIndex: ArtifactRef | null;
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
  interactive: boolean;
  terminal: boolean;
  skill: string | null;
  executePrompt: string;
  routerPrompt: string;
  mode: string | null;
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
  mode?: string | null;
  taskType?: string | null;
  tier?: string | null;
  rev?: number; // board-level optimistic-concurrency token from GET /lists
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
  lists: () => jfetch<ListsView>("/lists"),
  patchList: (id: string, body: ListConfigPatch) =>
    jfetch<{ list: ListConfig; rev: number }>(`/lists/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  card: (id: string) => jfetch<CardDetail>(`/cards/${encodeURIComponent(id)}`),
  create: (body: { title: string; description?: string; project?: string; goalMode?: boolean }) =>
    jfetch<{ card: CardSummary }>("/cards", { method: "POST", body: JSON.stringify(body) }),
  patch: (id: string, body: Record<string, unknown>) =>
    jfetch<{ card: CardSummary }>(`/cards/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body)
    }),
  start: (id: string) =>
    jfetch<{ card: CardSummary; advanced?: string; outcome?: unknown }>(
      `/cards/${encodeURIComponent(id)}/start`,
      { method: "POST" }
    ),
  watchUrl: (id: string) => `/cards/${encodeURIComponent(id)}/watch`,
  artifactUrl: (ref: ArtifactRef | null) =>
    ref ? (ref.kind === "href" ? ref.href ?? null : ref.url ?? null) : null
};

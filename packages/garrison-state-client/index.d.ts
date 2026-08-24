// Hand-written types for @garrison/state-client (the .mjs is the truth).

export class StateUnavailableError extends Error {
  url: string;
  cause: unknown;
  since: string;
}

export class StateApiError extends Error {
  status: number;
  body: { error?: string; detail?: string; [k: string]: unknown };
}

export interface StateConfig {
  url: string;
  token: string;
  node: string | null;
}

export function discoverStateConfig(options?: {
  env?: Record<string, string | undefined>;
  readFileSync?: (path: string, enc: string) => string;
}): StateConfig;

export interface NodeInfo {
  name: string;
  tokenPrefix: string;
  accentColor: string;
  tailnetHost: string | null;
  tailnetIp: string | null;
  platform: string | null;
  capabilities: string[];
  schemaVersion: number | null;
  clientVersion: string | null;
  activeComposition: string | null;
  status: "active" | "behind" | "retired";
  health: Record<string, unknown>;
  registeredAt: string;
  lastSeenAt: string | null;
  rev: number;
}

export interface ChangeRow {
  seq: number;
  at: string;
  entity: string;
  entityId: string;
  op: string;
  node: string;
  summary: Record<string, unknown>;
}

export interface LeaseGrant {
  granted: boolean;
  fence?: number;
  holderToken?: string;
  expiresAt?: string;
  holder?: string;
  meta?: Record<string, unknown>;
  reentry?: boolean;
}

export interface SessionInfo {
  id: string;
  homeNode: string;
  cardId: string | null;
  threadId: string | null;
  compositionId: string | null;
  runtime: string | null;
  model: string | null;
  account: string | null;
  cwd: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  lastSeenAt: string;
  controlUrl: string | null;
  body: Record<string, unknown>;
  rev: number;
}

export interface RenderedEnv {
  content: string;
  resolved: { name: string; source: string | null; found: boolean }[];
  missing: string[];
}

export class StateClient {
  constructor(options: {
    url: string;
    token: string;
    node?: string | null;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  });
  url: string;
  node: string | null;

  request(method: string, path: string, options?: {
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
    retry?: boolean;
  }): Promise<any>;

  health(): Promise<{ ok: boolean; schemaVersion: number; serviceVersion: string }>;
  hello(input: {
    clientVersion?: string;
    minSchema?: number;
    maxSchema?: number;
    capabilities?: string[];
    localTime?: string;
    health?: Record<string, unknown>;
    activeComposition?: string;
    tailnetHost?: string;
    tailnetIp?: string;
    platform?: string;
  }): Promise<{ node: string; behind: boolean; schemaVersion: number; serviceVersion: string; meshId: string; serverTime: string }>;
  changes(since: number, options?: { wait?: number }): Promise<{ changes: ChangeRow[]; seq: number }>;

  listNodes(): Promise<NodeInfo[]>;
  getNode(name: string): Promise<NodeInfo>;

  getConfig(namespace: string, scope: string): Promise<{ namespace: string; scope: string; body: any; bodySha: string; rev: number; updatedAt: string; updatedBy: string } | null>;
  listConfig(prefix?: string): Promise<{ namespace: string; scope: string; rev: number; updatedAt: string; updatedBy: string }[]>;
  putConfig(namespace: string, scope: string, body: unknown, precondition: { ifMatchRev?: number; baselineSha?: string | null }): Promise<{ rev: number; bodySha: string }>;

  acquireLease(input: { key: string; holder?: string; holderToken?: string; ttlMs?: number; meta?: Record<string, unknown> }): Promise<LeaseGrant>;
  renewLease(input: { key: string; holderToken: string; ttlMs?: number }): Promise<{ renewed: boolean; expiresAt: string }>;
  releaseLease(input: { key: string; holderToken: string }): Promise<{ released: boolean }>;
  getLease(key: string): Promise<{ key: string; holder: string; acquiredAt: string; expiresAt: string; fence: number; meta: Record<string, unknown>; expired: boolean } | null>;

  appendEvent(input: { kind: string; subjectType?: string; subjectId?: string; originId?: string; payload?: Record<string, unknown> }): Promise<{ seq: number }>;
  listEvents(params?: { originId?: string; kind?: string; sinceSeq?: number; limit?: number }): Promise<any[]>;
  putOrigin(originId: string, input: { transport: string; address?: string; homeNode?: string; body?: Record<string, unknown> }): Promise<{ originId: string }>;
  getOrigin(originId: string): Promise<any | null>;
  createNotification(input: { originId?: string; kind: string; body?: Record<string, unknown>; node?: string; eventSeq?: number }): Promise<{ id: string; node: string }>;
  pendingNotifications(): Promise<any[]>;
  markDelivered(id: string, legs?: Record<string, unknown>): Promise<{ delivered: boolean }>;

  upsertSession(id: string, input: Partial<SessionInfo> & { status?: string; body?: Record<string, unknown> }): Promise<SessionInfo>;
  getSession(id: string): Promise<SessionInfo | null>;
  listSessions(params?: { node?: string; status?: string; activeOnly?: boolean; cwd?: string }): Promise<SessionInfo[]>;

  resolveSecrets(keys: string[]): Promise<{ values: Record<string, string>; missing: string[] }>;
  loadoutEnv(project: string): Promise<RenderedEnv & { loadout: any }>;
  compositionEnv(compositionId: string, mode?: "all"): Promise<{ content: string; keys: number }>;
  putSecret(key: string, value: string): Promise<{ key: string }>;
  deleteSecret(key: string): Promise<{ removed: boolean }>;
  listSecretKeys(): Promise<{ key: string; updatedAt: string; updatedBy: string; rev: number }[]>;
  putGrant(node: string, pattern: string): Promise<{ node: string; pattern: string }>;
  listGrants(): Promise<{ node: string; pattern: string }[]>;

  createCard(card: Record<string, unknown> & { id: string; list: string }): Promise<any>;
  getCard(id: string): Promise<any | null>;
  listCards(params?: { list?: string; placement?: string; scheduledBefore?: string; system?: string; includeDeleted?: boolean }): Promise<any[]>;
  patchCard(id: string, patch: Record<string, unknown>, precondition: { ifMatchRev: number; fence?: number }): Promise<any>;
  deleteCard(id: string, precondition: { ifMatchRev: number }): Promise<{ deleted: boolean }>;
  putCardDoc(cardId: string, name: string, body: string): Promise<{ cardId: string; name: string }>;
  getCardDoc(cardId: string, name: string): Promise<{ cardId: string; name: string; body: string; rev: number } | null>;
  listCardDocs(cardId: string): Promise<any[]>;
  putCardAttachment(cardId: string, name: string, meta: { bytes?: number; sha256?: string }): Promise<{ cardId: string; name: string }>;

  listCompositions(): Promise<any[]>;
  getComposition(id: string): Promise<any | null>;
  putComposition(id: string, manifestYaml: string, precondition: { ifMatchRev: number }): Promise<{ id: string; rev: number }>;
  getCompositionFile(id: string, relPath: string): Promise<{ body: string; rev: number } | null>;
  putCompositionFile(id: string, relPath: string, body: string): Promise<{ compositionId: string; path: string }>;

  listSchedulerJobs(target?: string): Promise<any[]>;
  putSchedulerJob(id: string, job: { cron: string; target: string; spec: Record<string, unknown>; description?: string; enabled?: boolean; type?: string }, precondition: { ifMatchRev: number }): Promise<{ id: string; rev: number }>;
  deleteSchedulerJob(id: string, precondition: { ifMatchRev: number }): Promise<{ deleted: boolean }>;
  recordSchedulerRun(input: { jobId: string; occurrence: string; endedAt?: string; exit?: number }): Promise<{ recorded: boolean; phase: "started" | "ended" }>;
  listSchedulerRuns(jobId?: string): Promise<any[]>;

  appendPlan(input: { repoKey: string; session: string; payload?: Record<string, unknown> }): Promise<{ seq: number }>;
  listPlans(repoKey?: string, limit?: number): Promise<any[]>;
  declareIntent(input: { repoKey: string; session: string; area?: string; files?: string[]; reason: string }): Promise<{ seq: number }>;
  releaseIntents(input: { repoKey?: string; session?: string; seqs?: number[] }): Promise<{ released: number }>;
  listIntents(repoKey?: string, options?: { all?: boolean }): Promise<any[]>;

  appendFeedback(input: { id?: string; kind?: string; area?: string; sessionId?: string; payload?: Record<string, unknown>; legacyKey?: string }): Promise<{ id: string; seq: number }>;
  listFeedback(params?: { sinceSeq?: number; limit?: number; includeTombstoned?: boolean }): Promise<any[]>;
  tombstoneFeedback(target: string, reason?: string): Promise<{ seq: number }>;
  listFeedbackTombstones(limit?: number): Promise<{ seq: number; target: string; at: string; node: string; reason: string | null }[]>;

  appendPaymasterUsage(input: { account: string; platform?: string; tokens?: Record<string, unknown>; headers?: Record<string, unknown> }): Promise<{ ok: boolean }>;
  listPaymasterUsage(params?: { account?: string; since?: string; limit?: number }): Promise<any[]>;
}

export function createStateClient(options?: {
  env?: Record<string, string | undefined>;
  readFileSync?: (path: string, enc: string) => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): StateClient;

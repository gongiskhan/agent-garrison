// GARRISON STATE CLIENT — the one client for the state service.
//
// Three delivery routes, one source:
//   1. src/lib/state-client.ts wraps this as a workspace dep (Next app).
//   2. Fittings get a GENERATED copy at lib/state-client.mjs via
//      scripts/sync-state-client.mjs; tests/state-client-drift.test.ts asserts
//      every copy is byte-identical. Edit HERE, never the copies.
//   3. The browser NEVER gets one — no state token in a browser, ever. A
//      "use client" module posts to its own node's Next route instead.
//
// L3 is ERROR CLARITY, not self-heal: the service is not startable from a
// peer, and there is no offline mode by design. One retry on a connection
// error (covers a service restart mid-request), then a typed
// StateUnavailableError. No cache, no write queue, no optimistic apply —
// stale reads and replayed writes are worse than a clear stop.
//
// Discovery: GARRISON_STATE_URL + GARRISON_STATE_TOKEN env (projected by the
// runner into fittings and sessions), else $GARRISON_HOME/state.json written
// at node install. NO third fallback and NO default URL — a default would be
// a port literal, and an unresolvable state service must be a loud error.

export class StateUnavailableError extends Error {
  constructor(url, cause) {
    super(`state service unreachable at ${url}: ${cause?.message ?? cause}`);
    this.name = "StateUnavailableError";
    this.url = url;
    this.cause = cause;
    this.since = new Date().toISOString();
  }
}

export class StateApiError extends Error {
  constructor(status, body) {
    super(`state api ${status}: ${body?.error ?? "error"}${body?.detail ? ` — ${body.detail}` : ""}`);
    this.name = "StateApiError";
    this.status = status;
    this.body = body ?? {};
  }
}

export function discoverStateConfig({ env = process.env, readFileSync } = {}) {
  const url = env.GARRISON_STATE_URL?.trim();
  const token = env.GARRISON_STATE_TOKEN?.trim();
  if (url && token) return { url: url.replace(/\/+$/, ""), token, node: env.GARRISON_NODE_NAME?.trim() || null };
  const home = env.GARRISON_HOME?.trim();
  if (home && readFileSync) {
    try {
      const parsed = JSON.parse(readFileSync(`${home}/state.json`, "utf8"));
      if (parsed?.url && parsed?.token) {
        return { url: String(parsed.url).replace(/\/+$/, ""), token: String(parsed.token), node: parsed.node ?? null };
      }
    } catch {
      // fall through to the loud error below
    }
  }
  throw new StateUnavailableError(
    url ?? "(unconfigured)",
    new Error("GARRISON_STATE_URL/GARRISON_STATE_TOKEN are unset and $GARRISON_HOME/state.json is unreadable — this node is not enrolled in the mesh")
  );
}

export class StateClient {
  constructor({ url, token, node, fetchImpl, timeoutMs = 5000 } = {}) {
    if (!url || !token) throw new Error("StateClient requires url and token — use discoverStateConfig()");
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.node = node ?? null;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { body, headers, timeoutMs, retry = true } = {}) {
    const url = `${this.url}${path}`;
    const opts = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(headers ?? {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs)
    };
    let res;
    try {
      res = await this.fetchImpl(url, opts);
    } catch (err) {
      // EXACTLY ONE retry on a connection-level error — covers a service
      // restart mid-request; a backoff ladder would turn an outage into
      // latency and hide the real state.
      if (retry) return this.request(method, path, { body, headers, timeoutMs, retry: false });
      throw new StateUnavailableError(this.url, err);
    }
    let parsed;
    const text = await res.text();
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new StateApiError(res.status, { error: "non-json", detail: text.slice(0, 200) });
    }
    if (!res.ok) throw new StateApiError(res.status, parsed);
    return parsed;
  }

  // ── handshake / feed ──
  health() { return this.request("GET", "/v1/health"); }
  hello(input) { return this.request("POST", "/v1/hello", { body: input }); }
  changes(since, { wait = 25 } = {}) {
    return this.request("GET", `/v1/changes?since=${since}&wait=${wait}`, { timeoutMs: (wait + 5) * 1000 });
  }

  // ── nodes ──
  listNodes() { return this.request("GET", "/v1/nodes").then((r) => r.nodes); }
  getNode(name) { return this.request("GET", `/v1/nodes/${encodeURIComponent(name)}`); }

  // ── config docs ── (writes take an EXPLICIT precondition — no overwrite overload)
  getConfig(namespace, scope) {
    return this.request("GET", `/v1/config/${encodeURIComponent(namespace)}/${encodeURIComponent(scope)}`).catch((err) => {
      if (err instanceof StateApiError && err.status === 404) return null;
      throw err;
    });
  }
  listConfig(prefix) {
    const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
    return this.request("GET", `/v1/config${q}`).then((r) => r.docs);
  }
  putConfig(namespace, scope, body, { ifMatchRev, baselineSha }) {
    const headers = {};
    if (baselineSha !== undefined) headers["x-baseline-sha"] = baselineSha === null ? "" : String(baselineSha);
    else headers["if-match"] = String(ifMatchRev);
    return this.request("PUT", `/v1/config/${encodeURIComponent(namespace)}/${encodeURIComponent(scope)}`, { body, headers });
  }

  // ── leases ──
  acquireLease(input) { return this.request("POST", "/v1/leases/acquire", { body: input }); }
  renewLease(input) { return this.request("POST", "/v1/leases/renew", { body: input }); }
  releaseLease(input) { return this.request("POST", "/v1/leases/release", { body: input }); }
  getLease(key) { return this.request("GET", `/v1/leases/${encodeURIComponent(key)}`).then((r) => r.lease); }

  // ── events / origins / notifications ──
  appendEvent(input) { return this.request("POST", "/v1/events", { body: input }); }
  listEvents(params = {}) {
    const q = new URLSearchParams();
    if (params.originId) q.set("origin", params.originId);
    if (params.kind) q.set("kind", params.kind);
    if (params.sinceSeq) q.set("since_seq", String(params.sinceSeq));
    if (params.limit) q.set("limit", String(params.limit));
    return this.request("GET", `/v1/events?${q}`).then((r) => r.events);
  }
  putOrigin(originId, input) { return this.request("PUT", `/v1/origins/${encodeURIComponent(originId)}`, { body: input }); }
  getOrigin(originId) {
    return this.request("GET", `/v1/origins/${encodeURIComponent(originId)}`).catch((err) => {
      if (err instanceof StateApiError && err.status === 404) return null;
      throw err;
    });
  }
  createNotification(input) { return this.request("POST", "/v1/notifications", { body: input }); }
  pendingNotifications() { return this.request("GET", "/v1/notifications/pending").then((r) => r.notifications); }
  markDelivered(id, legs) { return this.request("POST", `/v1/notifications/${encodeURIComponent(id)}/delivered`, { body: { legs } }); }

  // ── sessions ──
  upsertSession(id, input) { return this.request("PUT", `/v1/sessions/${encodeURIComponent(id)}`, { body: input }); }
  getSession(id) {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}`).catch((err) => {
      if (err instanceof StateApiError && err.status === 404) return null;
      throw err;
    });
  }
  listSessions(params = {}) {
    const q = new URLSearchParams();
    if (params.node) q.set("node", params.node);
    if (params.status) q.set("status", params.status);
    if (params.activeOnly) q.set("active", "1");
    if (params.cwd) q.set("cwd", params.cwd);
    return this.request("GET", `/v1/sessions?${q}`).then((r) => r.sessions);
  }

  // ── secrets ──
  resolveSecrets(keys) { return this.request("POST", "/v1/secrets/resolve", { body: { keys } }); }
  loadoutEnv(project) { return this.request("POST", "/v1/secrets/loadout-env", { body: { project } }); }
  compositionEnv(compositionId, mode = "all") {
    return this.request("POST", "/v1/secrets/composition-env", { body: { compositionId, mode } });
  }
  putSecret(key, value) { return this.request("PUT", `/v1/secrets/${encodeURIComponent(key)}`, { body: { value } }); }
  deleteSecret(key) { return this.request("DELETE", `/v1/secrets/${encodeURIComponent(key)}`); }
  listSecretKeys() { return this.request("GET", "/v1/secrets").then((r) => r.keys); }
  putGrant(node, pattern) { return this.request("POST", "/v1/secrets/grants", { body: { node, pattern } }); }
  listGrants() { return this.request("GET", "/v1/secrets/grants").then((r) => r.grants); }

  // ── cards ──
  createCard(card) { return this.request("POST", "/v1/cards", { body: card }); }
  getCard(id) {
    return this.request("GET", `/v1/cards/${encodeURIComponent(id)}`).catch((err) => {
      if (err instanceof StateApiError && err.status === 404) return null;
      throw err;
    });
  }
  listCards(params = {}) {
    const q = new URLSearchParams();
    if (params.list) q.set("list", params.list);
    if (params.placement) q.set("placement", params.placement);
    if (params.scheduledBefore) q.set("scheduled_before", params.scheduledBefore);
    if (params.system) q.set("system", params.system);
    if (params.includeDeleted) q.set("deleted", "1");
    if (params.frozen !== undefined) q.set("frozen", String(params.frozen));
    return this.request("GET", `/v1/cards?${q}`).then((r) => r.cards);
  }
  patchCard(id, patch, { ifMatchRev, fence } = {}) {
    const headers = { "if-match": String(ifMatchRev) };
    if (fence !== undefined) headers["x-fence"] = String(fence);
    return this.request("PATCH", `/v1/cards/${encodeURIComponent(id)}`, { body: patch, headers });
  }
  deleteCard(id, { ifMatchRev }) {
    return this.request("DELETE", `/v1/cards/${encodeURIComponent(id)}`, { headers: { "if-match": String(ifMatchRev) } });
  }
  putCardDoc(cardId, name, body) {
    return this.request("PUT", `/v1/cards/${encodeURIComponent(cardId)}/docs/${encodeURIComponent(name)}`, { body: { body } });
  }
  getCardDoc(cardId, name) {
    return this.request("GET", `/v1/cards/${encodeURIComponent(cardId)}/docs/${encodeURIComponent(name)}`).catch((err) => {
      if (err instanceof StateApiError && err.status === 404) return null;
      throw err;
    });
  }
  listCardDocs(cardId) { return this.request("GET", `/v1/cards/${encodeURIComponent(cardId)}/docs`).then((r) => r.docs); }
  putCardAttachment(cardId, name, meta) {
    return this.request("PUT", `/v1/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(name)}`, { body: meta });
  }

  // ── compositions ──
  listCompositions() { return this.request("GET", "/v1/compositions").then((r) => r.compositions); }
  getComposition(id) {
    return this.request("GET", `/v1/compositions/${encodeURIComponent(id)}`).catch((err) => {
      if (err instanceof StateApiError && err.status === 404) return null;
      throw err;
    });
  }
  putComposition(id, manifestYaml, { ifMatchRev }) {
    return this.request("PUT", `/v1/compositions/${encodeURIComponent(id)}`, {
      body: { manifestYaml },
      headers: { "if-match": String(ifMatchRev) }
    });
  }
  getCompositionFile(id, relPath) {
    return this.request("GET", `/v1/compositions/${encodeURIComponent(id)}/files/${relPath.split("/").map(encodeURIComponent).join("/")}`).catch((err) => {
      if (err instanceof StateApiError && err.status === 404) return null;
      throw err;
    });
  }
  putCompositionFile(id, relPath, body) {
    return this.request("PUT", `/v1/compositions/${encodeURIComponent(id)}/files/${relPath.split("/").map(encodeURIComponent).join("/")}`, { body: { body } });
  }

  // ── scheduler ──
  listSchedulerJobs(target) {
    const q = target ? `?target=${encodeURIComponent(target)}` : "";
    return this.request("GET", `/v1/scheduler/jobs${q}`).then((r) => r.jobs);
  }
  putSchedulerJob(id, job, { ifMatchRev }) {
    return this.request("PUT", `/v1/scheduler/jobs/${encodeURIComponent(id)}`, { body: job, headers: { "if-match": String(ifMatchRev) } });
  }
  deleteSchedulerJob(id, { ifMatchRev }) {
    return this.request("DELETE", `/v1/scheduler/jobs/${encodeURIComponent(id)}`, { headers: { "if-match": String(ifMatchRev) } });
  }
  recordSchedulerRun(input) { return this.request("POST", "/v1/scheduler/runs", { body: input }); }
  listSchedulerRuns(jobId) {
    const q = jobId ? `?job=${encodeURIComponent(jobId)}` : "";
    return this.request("GET", `/v1/scheduler/runs${q}`).then((r) => r.runs);
  }

  // ── coordination ──
  appendPlan(input) { return this.request("POST", "/v1/coord/plans", { body: input }); }
  listPlans(repoKey, limit) {
    const q = new URLSearchParams();
    if (repoKey) q.set("repo", repoKey);
    if (limit) q.set("limit", String(limit));
    return this.request("GET", `/v1/coord/plans?${q}`).then((r) => r.plans);
  }
  declareIntent(input) { return this.request("POST", "/v1/coord/intents", { body: input }); }
  releaseIntents(input) { return this.request("POST", "/v1/coord/intents/release", { body: input }); }
  listIntents(repoKey, { all = false } = {}) {
    const q = new URLSearchParams();
    if (repoKey) q.set("repo", repoKey);
    if (all) q.set("all", "1");
    return this.request("GET", `/v1/coord/intents?${q}`).then((r) => r.intents);
  }

  // ── feedback ──
  appendFeedback(input) { return this.request("POST", "/v1/feedback", { body: input }); }
  listFeedback(params = {}) {
    const q = new URLSearchParams();
    if (params.sinceSeq) q.set("since_seq", String(params.sinceSeq));
    if (params.limit) q.set("limit", String(params.limit));
    if (params.includeTombstoned) q.set("tombstoned", "1");
    return this.request("GET", `/v1/feedback?${q}`).then((r) => r.feedback);
  }
  tombstoneFeedback(target, reason) { return this.request("POST", "/v1/feedback/tombstones", { body: { target, reason } }); }
  listFeedbackTombstones(limit) {
    const q = limit ? `?limit=${limit}` : "";
    return this.request("GET", `/v1/feedback/tombstones${q}`).then((r) => r.tombstones);
  }

  // ── paymaster ──
  appendPaymasterUsage(input) { return this.request("POST", "/v1/paymaster/usage", { body: input }); }
  listPaymasterUsage(params = {}) {
    const q = new URLSearchParams();
    if (params.account) q.set("account", params.account);
    if (params.since) q.set("since", params.since);
    if (params.limit) q.set("limit", String(params.limit));
    return this.request("GET", `/v1/paymaster/usage?${q}`).then((r) => r.usage);
  }
}

// Node-side convenience: discover + construct in one call. Throws loudly when
// the node is not enrolled; there is deliberately no silent fallback.
export function createStateClient(options = {}) {
  const { readFileSync } = options;
  const config = discoverStateConfig({ env: options.env ?? process.env, readFileSync });
  return new StateClient({ ...config, ...options });
}

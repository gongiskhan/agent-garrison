// Domain operations for the state service. Every write runs inside a
// better-sqlite3 transaction (synchronous, so genuinely atomic w.r.t.
// concurrent HTTP handlers) and appends to `changes` in the same transaction.
//
// Error convention: throw StoreError(status, error, detail, extra) — the
// server maps it to an HTTP response {error, detail, ...extra}. A CAS
// mismatch is 409 carrying current state so a client can merge without a
// second round trip.

import crypto from "node:crypto";
import { appendChange } from "./lib/changes.mjs";
import { seal, unseal, sha256Hex } from "./crypto.mjs";
import { compositionPathAllowed } from "./lib/transferable-path.mjs";
import { renderProjectEnv, renderAllSecretsEnv } from "./lib/env-render.mjs";

export class StoreError extends Error {
  constructor(status, error, detail, extra = {}) {
    super(detail || error);
    this.status = status;
    this.body = { error, detail, ...extra };
  }
}

const now = () => new Date().toISOString();

const RESERVED_NODE_NAMES = new Set(["host", "any", "all", "global"]);
const NODE_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ── nodes ───────────────────────────────────────────────────────────────────

export function registerNode(db, { name, accentColor, platform, tailnetHost, tailnetIp }) {
  if (!NODE_NAME_RE.test(name ?? "")) {
    throw new StoreError(422, "invalid-node-name", `node name must match ${NODE_NAME_RE}`);
  }
  if (RESERVED_NODE_NAMES.has(name)) {
    throw new StoreError(422, "reserved-node-name", `"${name}" is reserved and can never name a node`);
  }
  const token = crypto.randomBytes(24).toString("hex");
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT name FROM nodes WHERE name=?").get(name);
    db.prepare(
      `INSERT INTO nodes(name, token_hash, token_prefix, accent_color, platform, tailnet_host, tailnet_ip, registered_at)
       VALUES (@name, @hash, @prefix, @accent, @platform, @host, @ip, @at)
       ON CONFLICT(name) DO UPDATE SET token_hash=excluded.token_hash, token_prefix=excluded.token_prefix,
         accent_color=COALESCE(NULLIF(excluded.accent_color,''), nodes.accent_color),
         platform=COALESCE(excluded.platform, nodes.platform),
         tailnet_host=COALESCE(excluded.tailnet_host, nodes.tailnet_host),
         tailnet_ip=COALESCE(excluded.tailnet_ip, nodes.tailnet_ip),
         rev=nodes.rev+1`
    ).run({
      name,
      hash: sha256Hex(token),
      prefix: token.slice(0, 8),
      accent: accentColor ?? "",
      platform: platform ?? null,
      host: tailnetHost ?? null,
      ip: tailnetIp ?? null,
      at: now()
    });
    appendChange(db, {
      entity: "node",
      entityId: name,
      op: existing ? "token-rotated" : "registered",
      node: name
    });
  });
  tx();
  return { name, token };
}

export function authenticateToken(db, token) {
  if (!token) return null;
  const hash = sha256Hex(token);
  const row = db
    .prepare(
      "SELECT name, status, schema_version, accent_color, tailnet_host FROM nodes WHERE token_hash = ?"
    )
    .get(hash);
  return row ?? null;
}

export function listNodes(db) {
  return db
    .prepare(
      `SELECT name, token_prefix, accent_color, tailnet_host, tailnet_ip, platform,
              capabilities_json, schema_version, client_version, active_composition,
              status, health_json, registered_at, last_seen_at, rev
       FROM nodes ORDER BY name`
    )
    .all()
    .map((r) => ({
      name: r.name,
      tokenPrefix: r.token_prefix,
      accentColor: r.accent_color,
      tailnetHost: r.tailnet_host,
      tailnetIp: r.tailnet_ip,
      platform: r.platform,
      capabilities: parseJson(r.capabilities_json, []),
      schemaVersion: r.schema_version,
      clientVersion: r.client_version,
      activeComposition: r.active_composition,
      status: r.status,
      health: parseJson(r.health_json, {}),
      registeredAt: r.registered_at,
      lastSeenAt: r.last_seen_at,
      rev: r.rev
    }));
}

export function hello(db, authNode, input, serverSchemaVersion) {
  const { clientVersion, minSchema, maxSchema, capabilities, localTime, health, activeComposition, tailnetHost, tailnetIp, platform, accentColor } = input ?? {};
  if (localTime) {
    const skew = Math.abs(Date.parse(localTime) - Date.now());
    if (Number.isFinite(skew) && skew > 120_000) {
      throw new StoreError(
        409,
        "clock-skew",
        `node clock is ${Math.round(skew / 1000)}s from the service clock — every TTL, lease and schedule here is wall-clock; fix the clock before joining`,
        { serverTime: now() }
      );
    }
  }
  const lo = Number.isFinite(minSchema) ? minSchema : serverSchemaVersion;
  const hi = Number.isFinite(maxSchema) ? maxSchema : serverSchemaVersion;
  const behind = serverSchemaVersion < lo || serverSchemaVersion > hi;
  const tx = db.transaction(() => {
    const prior = db.prepare("SELECT status FROM nodes WHERE name=?").get(authNode.name);
    db.prepare(
      `UPDATE nodes SET last_seen_at=@at, client_version=@cv, schema_version=@sv,
        capabilities_json=@caps, health_json=@health, status=@status,
        active_composition=COALESCE(@comp, active_composition),
        tailnet_host=COALESCE(@th, tailnet_host), tailnet_ip=COALESCE(@ti, tailnet_ip),
        platform=COALESCE(@pf, platform),
        accent_color=COALESCE(NULLIF(@accent,''), accent_color)
       WHERE name=@name`
    ).run({
      at: now(),
      cv: clientVersion ?? null,
      sv: hi,
      caps: JSON.stringify(capabilities ?? []),
      health: JSON.stringify(health ?? {}),
      status: behind ? "behind" : "active",
      comp: activeComposition ?? null,
      th: tailnetHost ?? null,
      ti: tailnetIp ?? null,
      pf: platform ?? null,
      accent: accentColor ?? null,
      name: authNode.name
    });
    if (behind && prior?.status !== "behind") {
      appendChange(db, { entity: "node", entityId: authNode.name, op: "behind", node: authNode.name });
      insertEventTx(db, authNode.name, {
        kind: "node.behind",
        subjectType: "node",
        subjectId: authNode.name,
        payload: { minSchema: lo, maxSchema: hi, serverSchemaVersion }
      });
    } else if (!behind && prior?.status === "behind") {
      appendChange(db, { entity: "node", entityId: authNode.name, op: "recovered", node: authNode.name });
    }
  });
  tx();
  return { behind };
}

// ── config docs ─────────────────────────────────────────────────────────────

const SCOPE_RE = /^(global|node:[a-z][a-z0-9-]{1,31}|composition:[A-Za-z0-9._-]+)$/;

export function getConfigDoc(db, namespace, scope) {
  const row = db
    .prepare("SELECT body_json, body_sha, rev, updated_at, updated_by FROM config_docs WHERE namespace=? AND scope=?")
    .get(namespace, scope);
  if (!row) return null;
  return {
    namespace,
    scope,
    body: parseJson(row.body_json, null),
    bodySha: row.body_sha,
    rev: row.rev,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  };
}

export function listConfigDocs(db, namespacePrefix) {
  const rows = namespacePrefix
    ? db.prepare("SELECT namespace, scope, rev, updated_at, updated_by FROM config_docs WHERE namespace LIKE ? ORDER BY namespace, scope").all(`${namespacePrefix}%`)
    : db.prepare("SELECT namespace, scope, rev, updated_at, updated_by FROM config_docs ORDER BY namespace, scope").all();
  return rows.map((r) => ({ namespace: r.namespace, scope: r.scope, rev: r.rev, updatedAt: r.updated_at, updatedBy: r.updated_by }));
}

export function putConfigDoc(db, authNode, { namespace, scope, body, ifMatchRev, baselineSha }) {
  if (!namespace || typeof namespace !== "string") throw new StoreError(422, "invalid-namespace", "namespace required");
  if (!SCOPE_RE.test(scope ?? "")) throw new StoreError(422, "invalid-scope", `scope must be global | node:<name> | composition:<id>`);
  const bodyJson = JSON.stringify(body ?? null);
  const bodySha = sha256Hex(bodyJson);
  let result;
  const tx = db.transaction(() => {
    const current = db.prepare("SELECT body_json, body_sha, rev FROM config_docs WHERE namespace=? AND scope=?").get(namespace, scope);
    if (baselineSha !== undefined) {
      const currentSha = current?.body_sha ?? null;
      if (baselineSha !== currentSha) {
        throw new StoreError(409, "conflict", "baseline sha does not match the stored document", {
          rev: current?.rev ?? 0,
          bodySha: currentSha,
          body: current ? parseJson(current.body_json, null) : null
        });
      }
    } else {
      const expected = Number(ifMatchRev);
      if (!Number.isFinite(expected)) {
        throw new StoreError(428, "precondition-required", "If-Match rev (or X-Baseline-Sha) is required for config writes");
      }
      const currentRev = current?.rev ?? 0;
      if (expected !== currentRev) {
        throw new StoreError(409, "conflict", "rev does not match the stored document", {
          rev: currentRev,
          body: current ? parseJson(current.body_json, null) : null
        });
      }
    }
    const rev = (current?.rev ?? 0) + 1;
    db.prepare(
      `INSERT INTO config_docs(namespace, scope, body_json, body_sha, rev, updated_at, updated_by)
       VALUES (@ns, @scope, @body, @sha, @rev, @at, @by)
       ON CONFLICT(namespace, scope) DO UPDATE SET body_json=excluded.body_json, body_sha=excluded.body_sha,
         rev=excluded.rev, updated_at=excluded.updated_at, updated_by=excluded.updated_by`
    ).run({ ns: namespace, scope, body: bodyJson, sha: bodySha, rev, at: now(), by: authNode.name });
    db.prepare(
      "INSERT INTO config_doc_history(namespace, scope, rev, body_json, updated_at, updated_by) VALUES (?,?,?,?,?,?)"
    ).run(namespace, scope, rev, bodyJson, now(), authNode.name);
    db.prepare(
      `DELETE FROM config_doc_history WHERE namespace=? AND scope=? AND rev <= (
         SELECT rev FROM config_doc_history WHERE namespace=? AND scope=? ORDER BY rev DESC LIMIT 1 OFFSET 50)`
    ).run(namespace, scope, namespace, scope);
    appendChange(db, { entity: "config", entityId: `${namespace}/${scope}`, op: "put", node: authNode.name });
    result = { rev, bodySha };
  });
  tx();
  return result;
}

// ── leases ──────────────────────────────────────────────────────────────────

export function acquireLease(db, authNode, { key, holder, holderToken, ttlMs, meta }) {
  if (!key) throw new StoreError(422, "invalid-lease", "key required");
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : 15 * 60_000;
  const h = holder ?? authNode.name;
  const token = holderToken ?? crypto.randomBytes(8).toString("hex");
  const at = now();
  const expires = new Date(Date.now() + ttl).toISOString();
  let out;
  const tx = db.transaction(() => {
    const current = db.prepare("SELECT * FROM leases WHERE key=?").get(key);
    if (current && current.holder === h && current.holder_token === token) {
      // Re-entry by the same holder: renew, KEEP the fence.
      db.prepare("UPDATE leases SET expires_at=?, meta_json=? WHERE key=?").run(expires, JSON.stringify(meta ?? parseJson(current.meta_json, {})), key);
      out = { granted: true, fence: current.fence, holderToken: token, expiresAt: expires, reentry: true };
      return;
    }
    if (current && current.expires_at > at) {
      out = {
        granted: false,
        holder: current.holder,
        expiresAt: current.expires_at,
        meta: parseJson(current.meta_json, {})
      };
      return;
    }
    const fence = db.prepare("SELECT next FROM lease_fence WHERE id=1").get().next;
    db.prepare("UPDATE lease_fence SET next = next + 1 WHERE id=1").run();
    db.prepare(
      `INSERT INTO leases(key, holder, holder_token, acquired_at, expires_at, fence, meta_json)
       VALUES (@key, @holder, @token, @at, @expires, @fence, @meta)
       ON CONFLICT(key) DO UPDATE SET holder=excluded.holder, holder_token=excluded.holder_token,
         acquired_at=excluded.acquired_at, expires_at=excluded.expires_at, fence=excluded.fence, meta_json=excluded.meta_json`
    ).run({ key, holder: h, token, at, expires, fence, meta: JSON.stringify(meta ?? {}) });
    appendChange(db, { entity: "lease", entityId: key, op: "acquired", node: authNode.name, summary: { holder: h } });
    out = { granted: true, fence, holderToken: token, expiresAt: expires };
  });
  tx();
  return out;
}

export function renewLease(db, authNode, { key, holderToken, ttlMs }) {
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : 15 * 60_000;
  const expires = new Date(Date.now() + ttl).toISOString();
  const res = db
    .prepare("UPDATE leases SET expires_at=? WHERE key=? AND holder_token=? AND expires_at > ?")
    .run(expires, key, holderToken ?? "", now());
  if (res.changes === 0) {
    const current = db.prepare("SELECT holder, expires_at FROM leases WHERE key=?").get(key);
    throw new StoreError(409, "lease-lost", "lease is not held by this token (expired or taken)", {
      holder: current?.holder ?? null,
      expiresAt: current?.expires_at ?? null
    });
  }
  return { renewed: true, expiresAt: expires };
}

export function releaseLease(db, authNode, { key, holderToken }) {
  let released = false;
  const tx = db.transaction(() => {
    const res = db.prepare("DELETE FROM leases WHERE key=? AND holder_token=?").run(key, holderToken ?? "");
    released = res.changes > 0;
    if (released) {
      appendChange(db, { entity: "lease", entityId: key, op: "released", node: authNode.name });
    }
  });
  tx();
  return { released };
}

export function getLease(db, key) {
  const row = db.prepare("SELECT * FROM leases WHERE key=?").get(key);
  if (!row) return null;
  return {
    key: row.key,
    holder: row.holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    fence: row.fence,
    meta: parseJson(row.meta_json, {}),
    expired: row.expires_at <= now()
  };
}

// ── events / origins / notifications ────────────────────────────────────────

function insertEventTx(db, nodeName, { kind, subjectType, subjectId, originId, payload }) {
  const info = db
    .prepare(
      "INSERT INTO events(at, kind, subject_type, subject_id, origin_id, node, payload_json) VALUES (?,?,?,?,?,?,?)"
    )
    .run(now(), kind, subjectType ?? "none", String(subjectId ?? ""), originId ?? null, nodeName, JSON.stringify(payload ?? {}));
  appendChange(db, { entity: "event", entityId: String(info.lastInsertRowid), op: "append", node: nodeName, summary: { kind } });
  return info.lastInsertRowid;
}

export function appendEvent(db, authNode, input) {
  if (!input?.kind) throw new StoreError(422, "invalid-event", "kind required");
  let seq;
  const tx = db.transaction(() => {
    seq = insertEventTx(db, authNode.name, input);
  });
  tx();
  return { seq };
}

export function listEvents(db, { originId, kind, sinceSeq = 0, limit = 200 }) {
  let rows;
  if (originId) {
    rows = db.prepare("SELECT * FROM events WHERE origin_id=? AND seq>? ORDER BY seq LIMIT ?").all(originId, sinceSeq, limit);
  } else if (kind) {
    rows = db.prepare("SELECT * FROM events WHERE kind=? AND seq>? ORDER BY seq LIMIT ?").all(kind, sinceSeq, limit);
  } else {
    rows = db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?").all(sinceSeq, limit);
  }
  return rows.map((r) => ({
    seq: r.seq,
    at: r.at,
    kind: r.kind,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    originId: r.origin_id,
    node: r.node,
    payload: parseJson(r.payload_json, {})
  }));
}

export function putOrigin(db, authNode, originId, { transport, address, homeNode, body }) {
  if (!originId || !transport) throw new StoreError(422, "invalid-origin", "originId and transport required");
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO origins(origin_id, transport, address, home_node, body_json, created_at)
       VALUES (@id, @transport, @address, @home, @body, @at)
       ON CONFLICT(origin_id) DO UPDATE SET transport=excluded.transport, address=excluded.address,
         home_node=excluded.home_node, body_json=excluded.body_json`
    ).run({
      id: originId,
      transport,
      address: address ?? null,
      home: homeNode ?? authNode.name,
      body: JSON.stringify(body ?? {}),
      at: now()
    });
    appendChange(db, { entity: "origin", entityId: originId, op: "put", node: authNode.name });
  });
  tx();
  return { originId };
}

export function getOrigin(db, originId) {
  const r = db.prepare("SELECT * FROM origins WHERE origin_id=?").get(originId);
  if (!r) return null;
  return {
    originId: r.origin_id,
    transport: r.transport,
    address: r.address,
    homeNode: r.home_node,
    body: parseJson(r.body_json, {}),
    createdAt: r.created_at
  };
}

export function createNotification(db, authNode, { originId, kind, body, node, eventSeq }) {
  if (!kind) throw new StoreError(422, "invalid-notification", "kind required");
  let target = node;
  if (!target && originId) {
    target = db.prepare("SELECT home_node FROM origins WHERE origin_id=?").get(originId)?.home_node;
  }
  if (!target) target = authNode.name;
  const id = `nt-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO notifications(id, event_seq, origin_id, node, kind, body_json, created_at) VALUES (?,?,?,?,?,?,?)"
    ).run(id, eventSeq ?? null, originId ?? null, target, kind, JSON.stringify(body ?? {}), now());
    appendChange(db, { entity: "notification", entityId: id, op: "created", node: authNode.name, summary: { target, kind } });
  });
  tx();
  return { id, node: target };
}

export function pendingNotifications(db, nodeName) {
  return db
    .prepare("SELECT * FROM notifications WHERE node=? AND delivered_at IS NULL ORDER BY created_at LIMIT 100")
    .all(nodeName)
    .map((r) => ({
      id: r.id,
      eventSeq: r.event_seq,
      originId: r.origin_id,
      kind: r.kind,
      body: parseJson(r.body_json, {}),
      createdAt: r.created_at
    }));
}

export function markDelivered(db, authNode, id, legs) {
  let ok = false;
  const tx = db.transaction(() => {
    const res = db
      .prepare("UPDATE notifications SET delivered_at=?, delivered_json=? WHERE id=? AND node=? AND delivered_at IS NULL")
      .run(now(), JSON.stringify(legs ?? {}), id, authNode.name);
    ok = res.changes > 0;
    if (ok) appendChange(db, { entity: "notification", entityId: id, op: "delivered", node: authNode.name });
  });
  tx();
  if (!ok) throw new StoreError(404, "not-found", "no pending notification with that id for this node");
  return { delivered: true };
}

// ── sessions ────────────────────────────────────────────────────────────────

export function upsertSession(db, authNode, id, input) {
  if (!id) throw new StoreError(422, "invalid-session", "id required");
  const tx = db.transaction(() => {
    const current = db.prepare("SELECT home_node, rev FROM sessions WHERE id=?").get(id);
    if (current && current.home_node !== authNode.name) {
      throw new StoreError(403, "not-home-node", `session ${id} is homed on ${current.home_node}`);
    }
    db.prepare(
      `INSERT INTO sessions(id, home_node, card_id, thread_id, composition_id, runtime, model, account, cwd,
                            status, started_at, ended_at, last_seen_at, control_url, body_json, rev)
       VALUES (@id, @home, @card, @thread, @comp, @runtime, @model, @account, @cwd,
               @status, @started, @ended, @seen, @control, @body, 0)
       ON CONFLICT(id) DO UPDATE SET
         card_id=COALESCE(excluded.card_id, sessions.card_id),
         thread_id=COALESCE(excluded.thread_id, sessions.thread_id),
         composition_id=COALESCE(excluded.composition_id, sessions.composition_id),
         runtime=COALESCE(excluded.runtime, sessions.runtime),
         model=COALESCE(excluded.model, sessions.model),
         account=COALESCE(excluded.account, sessions.account),
         cwd=COALESCE(excluded.cwd, sessions.cwd),
         status=excluded.status,
         ended_at=COALESCE(excluded.ended_at, sessions.ended_at),
         last_seen_at=excluded.last_seen_at,
         control_url=COALESCE(excluded.control_url, sessions.control_url),
         body_json=excluded.body_json,
         rev=sessions.rev+1`
    ).run({
      id,
      home: authNode.name,
      card: input.cardId ?? null,
      thread: input.threadId ?? null,
      comp: input.compositionId ?? null,
      runtime: input.runtime ?? null,
      model: input.model ?? null,
      account: input.account ?? null,
      cwd: input.cwd ?? null,
      status: input.status ?? "running",
      started: input.startedAt ?? now(),
      ended: input.endedAt ?? null,
      seen: now(),
      control: input.controlUrl ?? null,
      body: JSON.stringify(input.body ?? {})
    });
    appendChange(db, { entity: "session", entityId: id, op: current ? "updated" : "created", node: authNode.name, summary: { status: input.status } });
  });
  tx();
  return getSession(db, id);
}

export function getSession(db, id) {
  const r = db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
  if (!r) return null;
  return sessionRow(r);
}

function sessionRow(r) {
  return {
    id: r.id,
    homeNode: r.home_node,
    cardId: r.card_id,
    threadId: r.thread_id,
    compositionId: r.composition_id,
    runtime: r.runtime,
    model: r.model,
    account: r.account,
    cwd: r.cwd,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    lastSeenAt: r.last_seen_at,
    controlUrl: r.control_url,
    body: parseJson(r.body_json, {}),
    rev: r.rev
  };
}

export function listSessions(db, { node, status, activeOnly, cwd }) {
  let sql = "SELECT * FROM sessions WHERE 1=1";
  const args = [];
  if (node) { sql += " AND home_node=?"; args.push(node); }
  if (status) { sql += " AND status=?"; args.push(status); }
  if (activeOnly) { sql += " AND ended_at IS NULL"; }
  if (cwd) { sql += " AND cwd=?"; args.push(cwd); }
  sql += " ORDER BY started_at DESC LIMIT 500";
  return db.prepare(sql).all(...args).map(sessionRow);
}

// ── secrets ─────────────────────────────────────────────────────────────────

function grantPatterns(db, nodeName) {
  return db.prepare("SELECT pattern FROM secret_grants WHERE node=?").all(nodeName).map((r) => r.pattern);
}

function patternMatches(pattern, key) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return key.startsWith(pattern.slice(0, -1));
  return pattern === key;
}

function keyGranted(patterns, key) {
  return patterns.some((p) => patternMatches(p, key));
}

// Audit-or-fail: the audit insert is in the SAME transaction as the read
// outcome. The point of centralising secrets is that reads are accountable.
function auditTx(db, nodeName, keys, action, outcome, detail) {
  db.prepare("INSERT INTO secret_reads(at, node, keys_json, action, outcome, detail) VALUES (?,?,?,?,?,?)").run(
    now(), nodeName, JSON.stringify(keys), action, outcome, detail ?? null
  );
}

export function putSecret(db, authNode, key, value) {
  if (!key || typeof value !== "string") throw new StoreError(422, "invalid-secret", "key and string value required");
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO secrets(key, ciphertext, updated_at, updated_by, rev) VALUES (@key, @ct, @at, @by, 1)
       ON CONFLICT(key) DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at,
         updated_by=excluded.updated_by, rev=secrets.rev+1`
    ).run({ key, ct: seal(value), at: now(), by: authNode.name });
    appendChange(db, { entity: "secret", entityId: key, op: "put", node: authNode.name });
  });
  tx();
  return { key };
}

export function deleteSecret(db, authNode, key) {
  let removed = false;
  const tx = db.transaction(() => {
    removed = db.prepare("DELETE FROM secrets WHERE key=?").run(key).changes > 0;
    if (removed) appendChange(db, { entity: "secret", entityId: key, op: "deleted", node: authNode.name });
  });
  tx();
  return { removed };
}

export function listSecretKeys(db) {
  return db.prepare("SELECT key, updated_at, updated_by, rev FROM secrets ORDER BY key").all().map((r) => ({
    key: r.key, updatedAt: r.updated_at, updatedBy: r.updated_by, rev: r.rev
  }));
}

export function putGrant(db, authNode, { node, pattern }) {
  if (!node || !pattern) throw new StoreError(422, "invalid-grant", "node and pattern required");
  const tx = db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO secret_grants(node, pattern) VALUES (?,?)").run(node, pattern);
    appendChange(db, { entity: "secret-grant", entityId: `${node}:${pattern}`, op: "put", node: authNode.name });
  });
  tx();
  return { node, pattern };
}

export function deleteGrant(db, authNode, { node, pattern }) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM secret_grants WHERE node=? AND pattern=?").run(node, pattern);
    appendChange(db, { entity: "secret-grant", entityId: `${node}:${pattern}`, op: "deleted", node: authNode.name });
  });
  tx();
  return { removed: true };
}

export function listGrants(db) {
  return db.prepare("SELECT node, pattern FROM secret_grants ORDER BY node, pattern").all();
}

// Fail-closed: any ungranted key → 403 NAMING the denied keys; never a silent
// omission. Same discipline as secret_scope (no scope, no secrets).
export function resolveSecrets(db, authNode, keys) {
  if (!Array.isArray(keys) || keys.length === 0) throw new StoreError(422, "invalid-resolve", "keys[] required");
  const patterns = grantPatterns(db, authNode.name);
  const denied = keys.filter((k) => !keyGranted(patterns, k));
  let out;
  const tx = db.transaction(() => {
    if (denied.length > 0) {
      auditTx(db, authNode.name, keys, "resolve", "denied", `denied: ${denied.join(",")}`);
      throw new StoreError(403, "secrets-denied", "node lacks a grant for the named keys", { denied });
    }
    const values = {};
    const missing = [];
    for (const k of keys) {
      const row = db.prepare("SELECT ciphertext FROM secrets WHERE key=?").get(k);
      if (!row) missing.push(k);
      else values[k] = unseal(row.ciphertext);
    }
    auditTx(db, authNode.name, keys, "resolve", "ok", missing.length ? `missing: ${missing.join(",")}` : null);
    out = { values, missing };
  });
  tx();
  return out;
}

function allReadableSecrets(db, patterns) {
  const map = new Map();
  for (const r of db.prepare("SELECT key, ciphertext FROM secrets").all()) {
    if (keyGranted(patterns, r.key)) map.set(r.key, unseal(r.ciphertext));
  }
  return map;
}

export function loadoutEnv(db, authNode, projectId) {
  if (!projectId) throw new StoreError(422, "invalid-project", "project required");
  const doc = getConfigDoc(db, `loadout.${projectId}`, "global");
  if (!doc?.body) throw new StoreError(404, "loadout-missing", `no loadout config doc for project ${projectId}`);
  const names = Array.isArray(doc.body.env_vars) ? doc.body.env_vars : [];
  const patterns = grantPatterns(db, authNode.name);
  // Fail closed on the keys the render will actually touch (bare + override).
  const prefix = `${projectId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}__`;
  const touched = names.flatMap((n) => [n, `${prefix}${n}`]);
  const existing = new Set(db.prepare("SELECT key FROM secrets").all().map((r) => r.key));
  const denied = touched.filter((k) => existing.has(k) && !keyGranted(patterns, k));
  let out;
  const tx = db.transaction(() => {
    if (denied.length > 0) {
      auditTx(db, authNode.name, touched, "loadout-env", "denied", `denied: ${denied.join(",")}`);
      throw new StoreError(403, "secrets-denied", "node lacks a grant for the named keys", { denied });
    }
    const readable = allReadableSecrets(db, patterns);
    out = renderProjectEnv(projectId, names, readable);
    auditTx(db, authNode.name, out.resolved.filter((r) => r.found).map((r) => r.source), "loadout-env", "ok",
      out.missing.length ? `missing: ${out.missing.join(",")}` : null);
  });
  tx();
  return { ...out, loadout: doc.body };
}

export function compositionEnv(db, authNode, { compositionId, mode = "all" }) {
  if (mode !== "all") {
    throw new StoreError(422, "unsupported-mode", 'only mode:"all" is supported until a live up() proves "scoped"');
  }
  const patterns = grantPatterns(db, authNode.name);
  const all = db.prepare("SELECT key FROM secrets").all().map((r) => r.key);
  const denied = all.filter((k) => !keyGranted(patterns, k));
  let out;
  const tx = db.transaction(() => {
    if (denied.length > 0) {
      auditTx(db, authNode.name, all, "composition-env", "denied", `denied: ${denied.length} keys`);
      throw new StoreError(403, "secrets-denied", "composition-env mode:all requires a grant covering every key", {
        denied: denied.slice(0, 20),
        deniedCount: denied.length
      });
    }
    const readable = allReadableSecrets(db, patterns);
    auditTx(db, authNode.name, all, "composition-env", "ok", `composition: ${compositionId ?? "?"}`);
    out = { content: renderAllSecretsEnv(readable), keys: all.length };
  });
  tx();
  return out;
}

// ── cards ───────────────────────────────────────────────────────────────────

const CARD_PROMOTED = new Set([
  "list", "position", "status", "title", "project", "scope",
  "placement", "scheduledFor", "schedule", "occurrenceKey", "systemKey", "originId"
]);

function cardRow(r, { includeBody = true } = {}) {
  const body = parseJson(r.body_json, {});
  const card = {
    ...(includeBody ? body : {}),
    id: r.id,
    list: r.list,
    position: r.position,
    status: r.status,
    title: r.title,
    project: r.project,
    scope: r.scope,
    rev: r.rev,
    coordinationSeq: r.coordination_seq,
    placement: r.placement_target ? { target: r.placement_target, not_before: r.placement_not_before ?? undefined } : body.placement,
    scheduledFor: r.scheduled_for ?? undefined,
    schedule: r.schedule_json ? parseJson(r.schedule_json, undefined) : undefined,
    occurrenceKey: r.occurrence_key ?? undefined,
    systemKey: r.system_key ?? undefined,
    origin_id: r.origin_id ?? undefined,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
  if (r.deleted_at) card.deletedAt = r.deleted_at;
  return card;
}

function validCardTimestamp(value, field) {
  if (value === undefined || value === null) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) {
    // Fail closed AT THE DOOR: a card that runs early because a hold did not
    // parse is worse than a 422 the author sees immediately.
    throw new StoreError(422, "invalid-timestamp", `${field} is not a parseable timestamp: ${value}`);
  }
  return new Date(t).toISOString();
}

function promotedFromBody(db, body) {
  const scheduledFor = validCardTimestamp(body.scheduledFor, "scheduledFor");
  const notBefore = validCardTimestamp(body.placement?.not_before, "placement.not_before");
  return {
    list: body.list,
    status: body.status ?? "",
    title: body.title ?? "",
    project: body.project ?? body.routing?.project ?? null,
    scope: body.scope ?? "default",
    placement_target: body.placement?.target ?? null,
    placement_not_before: notBefore,
    scheduled_for: scheduledFor,
    schedule_json: body.schedule ? JSON.stringify(body.schedule) : null,
    occurrence_key: body.occurrenceKey ?? null,
    system_key: body.systemKey ?? null,
    origin_id: body.origin_id ?? body.originId ?? null
  };
}

export function createCard(db, authNode, input) {
  const id = input.id;
  if (!id || typeof id !== "string") throw new StoreError(422, "invalid-card", "client-minted id required");
  if (!input.list) throw new StoreError(422, "invalid-card", "list required");
  if (input.placement?.target === "host") {
    throw new StoreError(422, "reserved-placement", '"host" is retired as a placement target — name a node');
  }
  let created;
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT id, deleted_at FROM cards WHERE id=?").get(id);
    if (existing) {
      throw new StoreError(409, "card-exists", existing.deleted_at ? "id belongs to a deleted card (no resurrection)" : "card id already exists");
    }
    let position = input.position;
    if (position === "top" || position === undefined) {
      const min = db.prepare("SELECT MIN(position) AS m FROM cards WHERE list=? AND deleted_at IS NULL").get(input.list).m;
      position = (min ?? 1000) - 10;
    } else if (position === "bottom") {
      const max = db.prepare("SELECT MAX(position) AS m FROM cards WHERE list=? AND deleted_at IS NULL").get(input.list).m;
      position = (max ?? 0) + 10;
    } else {
      position = Number(position);
      if (!Number.isFinite(position)) throw new StoreError(422, "invalid-card", "position must be top|bottom|number");
    }
    const promoted = promotedFromBody(db, input);
    const at = now();
    try {
      db.prepare(
        `INSERT INTO cards(id, list, position, status, title, project, scope, rev, coordination_seq,
           placement_target, placement_not_before, scheduled_for, schedule_json, occurrence_key, system_key,
           origin_id, created_at, updated_at, updated_by, body_json)
         VALUES (@id, @list, @position, @status, @title, @project, @scope, 0, @cseq,
           @pt, @pnb, @sf, @sj, @ok, @sk, @oid, @at, @at, @by, @body)`
      ).run({
        id,
        list: promoted.list,
        position,
        status: promoted.status,
        title: promoted.title,
        project: promoted.project,
        scope: promoted.scope,
        cseq: Number(input.coordinationSeq) || 0,
        pt: promoted.placement_target,
        pnb: promoted.placement_not_before,
        sf: promoted.scheduled_for,
        sj: promoted.schedule_json,
        ok: promoted.occurrence_key,
        sk: promoted.system_key,
        oid: promoted.origin_id,
        at,
        by: authNode.name,
        body: JSON.stringify(input)
      });
    } catch (err) {
      if (String(err?.message).includes("cards.occurrence_key")) {
        throw new StoreError(409, "occurrence-exists", `occurrence_key ${promoted.occurrence_key} already ran — scheduled work runs exactly once`);
      }
      throw err;
    }
    appendChange(db, { entity: "card", entityId: id, op: "created", node: authNode.name, summary: { list: promoted.list } });
    created = db.prepare("SELECT * FROM cards WHERE id=?").get(id);
  });
  tx();
  return cardRow(created);
}

export function getCard(db, id) {
  const r = db.prepare("SELECT * FROM cards WHERE id=?").get(id);
  if (!r || r.deleted_at) return null;
  return cardRow(r);
}

export function listCards(db, { list, placement, scheduledBefore, system, includeDeleted, frozen } = {}) {
  let sql = "SELECT * FROM cards WHERE 1=1";
  const args = [];
  if (!includeDeleted) sql += " AND deleted_at IS NULL";
  if (list) { sql += " AND list=?"; args.push(list); }
  if (placement) { sql += " AND placement_target=?"; args.push(placement); }
  if (scheduledBefore) { sql += " AND scheduled_for IS NOT NULL AND scheduled_for<=?"; args.push(scheduledBefore); }
  if (system) { sql += " AND system_key=?"; args.push(system); }
  // Frozen history filter (Conversations migration): "0" = live only, "1" =
  // frozen only. Every board-facing reader passes "0" — done/needs-attention
  // are REUSED list ids and 200+ frozen cards must never flood the new board.
  if (frozen === "0") sql += " AND json_extract(body_json,'$.frozen.at') IS NULL";
  if (frozen === "1") sql += " AND json_extract(body_json,'$.frozen.at') IS NOT NULL";
  sql += " ORDER BY list, position";
  return db.prepare(sql).all(...args).map((r) => cardRow(r));
}

// Frozen history guard (Conversations migration, 2026-08-26). A frozen card is
// read-only: every write refuses EXCEPT (a) DELETE — cleanup stays possible —
// and (b) a patch whose ONLY key is `frozen`, which is the migration setting
// or clearing the marker itself; without that escape the migration could not
// re-run against its own guard and rollback would be impossible.
function assertNotFrozen(body, id, patch = null) {
  if (!body?.frozen?.at) return;
  if (patch && Object.keys(patch).length === 1 && "frozen" in patch) return;
  throw new StoreError(409, "card-frozen",
    `card ${id} is frozen history (${body.frozen.reason ?? "legacy"}) — it is read-only`);
}

// The CAS write. PATCH NEVER upserts: 0 rows matched → 404; a deleted row is
// 404 for writes (no resurrection, structurally). coordination_seq is written
// as MAX(current, requested) so a stale client can never rewind a lifecycle
// generation. An X-Fence lower than the recorded claim fence is a 409.
export function patchCard(db, authNode, id, patch, { ifMatchRev, fence } = {}) {
  const expected = Number(ifMatchRev);
  if (!Number.isFinite(expected)) {
    throw new StoreError(428, "precondition-required", "If-Match rev is required for card writes");
  }
  let updated;
  const tx = db.transaction(() => {
    const r = db.prepare("SELECT * FROM cards WHERE id=?").get(id);
    if (!r) throw new StoreError(404, "not-found", "no such card (writes never resurrect)");
    if (r.deleted_at) throw new StoreError(404, "deleted", "card is deleted (writes never resurrect)");
    const currentBody = parseJson(r.body_json, {});
    // BEFORE the rev check: a frozen card must answer "frozen", not the
    // misleading "conflict" a stale rev would produce.
    assertNotFrozen(currentBody, id, patch);
    if (r.rev !== expected) {
      throw new StoreError(409, "conflict", "rev does not match", { rev: r.rev, card: cardRow(r) });
    }
    if (fence !== undefined && Number.isFinite(Number(currentBody.leaseFence)) && Number(fence) < Number(currentBody.leaseFence)) {
      throw new StoreError(409, "fenced", "write carries a lower fence than the card's recorded claim", {
        cardFence: currentBody.leaseFence
      });
    }
    if (patch.placement?.target === "host") {
      throw new StoreError(422, "reserved-placement", '"host" is retired as a placement target — name a node');
    }
    const nextBody = { ...currentBody, ...patch };
    delete nextBody.rev;
    delete nextBody.id;
    const requestedSeq = Number(patch.coordinationSeq);
    const cseq = Math.max(r.coordination_seq, Number.isFinite(requestedSeq) ? requestedSeq : 0);
    nextBody.coordinationSeq = cseq;
    const promoted = promotedFromBody(db, { ...cardRow(r), ...nextBody });
    const at = now();
    try {
      db.prepare(
        `UPDATE cards SET list=@list, position=@position, status=@status, title=@title, project=@project,
           scope=@scope, rev=rev+1, coordination_seq=@cseq, placement_target=@pt, placement_not_before=@pnb,
           scheduled_for=@sf, schedule_json=@sj, occurrence_key=@ok, system_key=@sk, origin_id=@oid,
           updated_at=@at, updated_by=@by, body_json=@body
         WHERE id=@id AND rev=@expected AND deleted_at IS NULL`
      ).run({
        id,
        expected,
        list: promoted.list ?? r.list,
        position: patch.position !== undefined && Number.isFinite(Number(patch.position)) ? Number(patch.position) : r.position,
        status: promoted.status,
        title: promoted.title,
        project: promoted.project,
        scope: promoted.scope,
        cseq,
        pt: promoted.placement_target,
        pnb: promoted.placement_not_before,
        sf: promoted.scheduled_for,
        sj: promoted.schedule_json,
        ok: promoted.occurrence_key,
        sk: promoted.system_key,
        oid: promoted.origin_id,
        at,
        by: authNode.name,
        body: JSON.stringify(nextBody)
      });
    } catch (err) {
      if (String(err?.message).includes("cards.occurrence_key")) {
        throw new StoreError(409, "occurrence-exists", "occurrence_key already exists — scheduled work runs exactly once");
      }
      throw err;
    }
    appendChange(db, {
      entity: "card",
      entityId: id,
      op: "patched",
      node: authNode.name,
      summary: { list: promoted.list ?? r.list, fromList: r.list }
    });
    updated = db.prepare("SELECT * FROM cards WHERE id=?").get(id);
  });
  tx();
  return cardRow(updated);
}

export function deleteCard(db, authNode, id, { ifMatchRev } = {}) {
  const expected = Number(ifMatchRev);
  if (!Number.isFinite(expected)) throw new StoreError(428, "precondition-required", "If-Match rev is required");
  const tx = db.transaction(() => {
    const r = db.prepare("SELECT rev, deleted_at FROM cards WHERE id=?").get(id);
    if (!r || r.deleted_at) throw new StoreError(404, "not-found", "no such live card");
    if (r.rev !== expected) throw new StoreError(409, "conflict", "rev does not match", { rev: r.rev });
    db.prepare("UPDATE cards SET deleted_at=?, rev=rev+1, updated_at=?, updated_by=? WHERE id=?").run(now(), now(), authNode.name, id);
    appendChange(db, { entity: "card", entityId: id, op: "deleted", node: authNode.name });
  });
  tx();
  return { deleted: true };
}

export function putCardDoc(db, authNode, cardId, name, body) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name ?? "")) {
    throw new StoreError(422, "invalid-doc-name", "doc name must be a simple filename");
  }
  const tx = db.transaction(() => {
    const card = db.prepare("SELECT id, deleted_at, body_json FROM cards WHERE id=?").get(cardId);
    if (!card || card.deleted_at) throw new StoreError(404, "not-found", "no such live card");
    assertNotFrozen(parseJson(card.body_json, {}), cardId);
    db.prepare(
      `INSERT INTO card_docs(card_id, name, body, rev, updated_at, updated_by) VALUES (@card, @name, @body, 1, @at, @by)
       ON CONFLICT(card_id, name) DO UPDATE SET body=excluded.body, rev=card_docs.rev+1,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`
    ).run({ card: cardId, name, body: String(body ?? ""), at: now(), by: authNode.name });
    appendChange(db, { entity: "card-doc", entityId: `${cardId}/${name}`, op: "put", node: authNode.name });
  });
  tx();
  return { cardId, name };
}

export function getCardDoc(db, cardId, name) {
  const r = db.prepare("SELECT body, rev, updated_at, updated_by FROM card_docs WHERE card_id=? AND name=?").get(cardId, name);
  return r ? { cardId, name, body: r.body, rev: r.rev, updatedAt: r.updated_at, updatedBy: r.updated_by } : null;
}

export function listCardDocs(db, cardId) {
  return db.prepare("SELECT name, rev, updated_at, updated_by, LENGTH(body) AS bytes FROM card_docs WHERE card_id=? ORDER BY name").all(cardId);
}

export function putCardAttachment(db, authNode, cardId, name, { bytes, sha256 }) {
  const tx = db.transaction(() => {
    const card = db.prepare("SELECT body_json FROM cards WHERE id=?").get(cardId);
    if (card) assertNotFrozen(parseJson(card.body_json, {}), cardId);
    db.prepare(
      `INSERT INTO card_attachments(card_id, name, bytes, sha256, home_node, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(card_id, name) DO UPDATE SET bytes=excluded.bytes, sha256=excluded.sha256, home_node=excluded.home_node`
    ).run(cardId, name, Number(bytes) || 0, sha256 ?? null, authNode.name, now());
    appendChange(db, { entity: "card-attachment", entityId: `${cardId}/${name}`, op: "put", node: authNode.name });
  });
  tx();
  return { cardId, name };
}

// ── compositions ────────────────────────────────────────────────────────────

export function putComposition(db, authNode, id, { manifestYaml, ifMatchRev }) {
  if (!id || typeof manifestYaml !== "string" || !manifestYaml.trim()) {
    throw new StoreError(422, "invalid-composition", "id and manifestYaml required");
  }
  const expected = Number(ifMatchRev);
  if (!Number.isFinite(expected)) throw new StoreError(428, "precondition-required", "If-Match rev is required");
  let out;
  const tx = db.transaction(() => {
    const current = db.prepare("SELECT rev FROM compositions WHERE id=?").get(id);
    const currentRev = current?.rev ?? 0;
    if (expected !== currentRev) {
      const row = db.prepare("SELECT manifest_yaml, rev FROM compositions WHERE id=?").get(id);
      throw new StoreError(409, "conflict", "another node changed this composition — reload", {
        rev: currentRev,
        manifestYaml: row?.manifest_yaml ?? null
      });
    }
    const rev = currentRev + 1;
    db.prepare(
      `INSERT INTO compositions(id, manifest_yaml, manifest_sha, rev, updated_at, updated_by)
       VALUES (@id, @yaml, @sha, @rev, @at, @by)
       ON CONFLICT(id) DO UPDATE SET manifest_yaml=excluded.manifest_yaml, manifest_sha=excluded.manifest_sha,
         rev=excluded.rev, updated_at=excluded.updated_at, updated_by=excluded.updated_by, archived_at=NULL`
    ).run({ id, yaml: manifestYaml, sha: sha256Hex(manifestYaml), rev, at: now(), by: authNode.name });
    appendChange(db, { entity: "composition", entityId: id, op: "put", node: authNode.name });
    out = { id, rev };
  });
  tx();
  return out;
}

export function getComposition(db, id) {
  const r = db.prepare("SELECT * FROM compositions WHERE id=?").get(id);
  if (!r) return null;
  const files = db
    .prepare("SELECT path, rev, updated_at, updated_by, LENGTH(body) AS bytes FROM composition_files WHERE composition_id=? ORDER BY path")
    .all(id);
  return {
    id: r.id,
    manifestYaml: r.manifest_yaml,
    manifestSha: r.manifest_sha,
    rev: r.rev,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    archivedAt: r.archived_at,
    files
  };
}

export function listCompositions(db) {
  return db.prepare("SELECT id, manifest_sha, rev, updated_at, updated_by, archived_at FROM compositions ORDER BY id").all();
}

export function putCompositionFile(db, authNode, compositionId, relPath, body) {
  if (!compositionPathAllowed(relPath)) {
    throw new StoreError(422, "path-not-transferable", `${relPath} is not on the composition allow-list — node-local files are unstorable here`);
  }
  if (typeof body !== "string") throw new StoreError(422, "invalid-file", "body must be a string");
  if (Buffer.byteLength(body, "utf8") > 512 * 1024) {
    throw new StoreError(422, "file-too-large", "composition files cap at 512KB");
  }
  const tx = db.transaction(() => {
    const comp = db.prepare("SELECT id FROM compositions WHERE id=?").get(compositionId);
    if (!comp) throw new StoreError(404, "not-found", "no such composition");
    db.prepare(
      `INSERT INTO composition_files(composition_id, path, body, rev, updated_at, updated_by)
       VALUES (@comp, @path, @body, 1, @at, @by)
       ON CONFLICT(composition_id, path) DO UPDATE SET body=excluded.body, rev=composition_files.rev+1,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`
    ).run({ comp: compositionId, path: relPath, body, at: now(), by: authNode.name });
    appendChange(db, { entity: "composition-file", entityId: `${compositionId}/${relPath}`, op: "put", node: authNode.name });
  });
  tx();
  return { compositionId, path: relPath };
}

export function getCompositionFile(db, compositionId, relPath) {
  const r = db.prepare("SELECT body, rev, updated_at, updated_by FROM composition_files WHERE composition_id=? AND path=?").get(compositionId, relPath);
  return r ? { compositionId, path: relPath, body: r.body, rev: r.rev, updatedAt: r.updated_at, updatedBy: r.updated_by } : null;
}

export function deleteCompositionFile(db, authNode, compositionId, relPath) {
  const tx = db.transaction(() => {
    const res = db.prepare("DELETE FROM composition_files WHERE composition_id=? AND path=?").run(compositionId, relPath);
    if (res.changes === 0) throw new StoreError(404, "not-found", "no such composition file");
    appendChange(db, { entity: "composition-file", entityId: `${compositionId}/${relPath}`, op: "deleted", node: authNode.name });
  });
  tx();
  return { deleted: true };
}

// ── scheduler ───────────────────────────────────────────────────────────────

const TARGET_RE = /^(node:[a-z][a-z0-9-]{1,31}|any|all)$/;

export function putSchedulerJob(db, authNode, id, { cron, target, spec, description, enabled, type, ifMatchRev }) {
  if (!id || !cron || !TARGET_RE.test(target ?? "")) {
    throw new StoreError(422, "invalid-job", "id, cron and target (node:<name>|any|all) required");
  }
  if (!spec || typeof spec !== "object" || !spec.kind) {
    throw new StoreError(422, "invalid-job", "spec.kind required (fitting-script | shell)");
  }
  if (spec.kind === "shell" && !target.startsWith("node:")) {
    // A baked shell string is by definition machine-specific — a Mac path must
    // never be firable on Linux.
    throw new StoreError(422, "shell-jobs-are-node-local", "a shell job must target node:<name>");
  }
  const expected = Number(ifMatchRev);
  if (!Number.isFinite(expected)) throw new StoreError(428, "precondition-required", "If-Match rev is required");
  let out;
  const tx = db.transaction(() => {
    const current = db.prepare("SELECT rev, enabled FROM scheduler_jobs WHERE id=?").get(id);
    const currentRev = current?.rev ?? 0;
    if (expected !== currentRev) {
      throw new StoreError(409, "conflict", "rev does not match", { rev: currentRev });
    }
    const rev = currentRev + 1;
    // register semantics: an idempotent re-register PRESERVES the user's
    // enable/disable choice unless the caller states one.
    const en = enabled === undefined ? (current ? current.enabled : 1) : enabled ? 1 : 0;
    db.prepare(
      `INSERT INTO scheduler_jobs(id, cron, type, enabled, target, spec_json, description, registered_by, rev, updated_at, updated_by)
       VALUES (@id, @cron, @type, @enabled, @target, @spec, @desc, @by, @rev, @at, @by)
       ON CONFLICT(id) DO UPDATE SET cron=excluded.cron, type=excluded.type, enabled=excluded.enabled,
         target=excluded.target, spec_json=excluded.spec_json, description=excluded.description,
         rev=excluded.rev, updated_at=excluded.updated_at, updated_by=excluded.updated_by`
    ).run({
      id, cron, type: type ?? "cron", enabled: en, target,
      spec: JSON.stringify(spec), desc: description ?? null, by: authNode.name, rev, at: now()
    });
    appendChange(db, { entity: "scheduler-job", entityId: id, op: "put", node: authNode.name });
    out = { id, rev };
  });
  tx();
  return out;
}

export function listSchedulerJobs(db, { target } = {}) {
  const rows = db.prepare("SELECT * FROM scheduler_jobs ORDER BY id").all();
  return rows
    .map((r) => ({
      id: r.id,
      cron: r.cron,
      type: r.type,
      enabled: !!r.enabled,
      target: r.target,
      spec: parseJson(r.spec_json, {}),
      description: r.description,
      registeredBy: r.registered_by,
      rev: r.rev,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by
    }))
    .filter((j) => {
      if (!target) return true;
      return j.target === `node:${target}` || j.target === "any" || j.target === "all";
    });
}

export function deleteSchedulerJob(db, authNode, id, { ifMatchRev }) {
  const expected = Number(ifMatchRev);
  if (!Number.isFinite(expected)) throw new StoreError(428, "precondition-required", "If-Match rev is required");
  const tx = db.transaction(() => {
    const current = db.prepare("SELECT rev FROM scheduler_jobs WHERE id=?").get(id);
    if (!current) throw new StoreError(404, "not-found", "no such job");
    if (current.rev !== expected) throw new StoreError(409, "conflict", "rev does not match", { rev: current.rev });
    db.prepare("DELETE FROM scheduler_jobs WHERE id=?").run(id);
    appendChange(db, { entity: "scheduler-job", entityId: id, op: "deleted", node: authNode.name });
  });
  tx();
  return { deleted: true };
}

// The occurrence ledger. INSERT OR IGNORE + the job lease = exactly-once; the
// PK is the belt to the lease's braces. Returns whether THIS call recorded the
// start (false = someone else already ran it).
export function recordSchedulerRun(db, authNode, { jobId, occurrence, endedAt, exit }) {
  if (!jobId || !occurrence) throw new StoreError(422, "invalid-run", "jobId and occurrence required");
  let out;
  const tx = db.transaction(() => {
    if (endedAt !== undefined || exit !== undefined) {
      const res = db
        .prepare("UPDATE scheduler_runs SET ended_at=?, exit=? WHERE job_id=? AND occurrence=? AND node=?")
        .run(endedAt ?? now(), exit ?? null, jobId, occurrence, authNode.name);
      out = { recorded: res.changes > 0, phase: "ended" };
    } else {
      const res = db
        .prepare("INSERT OR IGNORE INTO scheduler_runs(job_id, occurrence, node, started_at) VALUES (?,?,?,?)")
        .run(jobId, occurrence, authNode.name, now());
      out = { recorded: res.changes > 0, phase: "started" };
    }
    if (out.recorded) {
      appendChange(db, { entity: "scheduler-run", entityId: `${jobId}@${occurrence}`, op: out.phase, node: authNode.name });
    }
  });
  tx();
  return out;
}

export function listSchedulerRuns(db, { jobId, limit = 100 }) {
  const rows = jobId
    ? db.prepare("SELECT * FROM scheduler_runs WHERE job_id=? ORDER BY started_at DESC LIMIT ?").all(jobId, limit)
    : db.prepare("SELECT * FROM scheduler_runs ORDER BY started_at DESC LIMIT ?").all(limit);
  return rows.map((r) => ({ jobId: r.job_id, occurrence: r.occurrence, node: r.node, startedAt: r.started_at, endedAt: r.ended_at, exit: r.exit }));
}

// ── coordination (plans + intents; locks are leases) ────────────────────────

export function appendPlan(db, authNode, { repoKey, session, payload }) {
  if (!repoKey || !session) throw new StoreError(422, "invalid-plan", "repoKey and session required");
  let seq;
  const tx = db.transaction(() => {
    const info = db.prepare("INSERT INTO plans(repo_key, session, at, payload_json) VALUES (?,?,?,?)").run(
      repoKey, session, now(), JSON.stringify(payload ?? {})
    );
    seq = info.lastInsertRowid;
    appendChange(db, { entity: "plan", entityId: `${repoKey}#${seq}`, op: "append", node: authNode.name });
  });
  tx();
  return { seq };
}

export function listPlans(db, { repoKey, limit = 20 }) {
  const rows = repoKey
    ? db.prepare("SELECT * FROM plans WHERE repo_key=? ORDER BY seq DESC LIMIT ?").all(repoKey, limit)
    : db.prepare("SELECT * FROM plans ORDER BY seq DESC LIMIT ?").all(limit);
  return rows.map((r) => ({ seq: r.seq, repoKey: r.repo_key, session: r.session, at: r.at, payload: parseJson(r.payload_json, {}) }));
}

export function declareIntent(db, authNode, { repoKey, session, area, files, reason }) {
  if (!repoKey || !session || !reason) throw new StoreError(422, "invalid-intent", "repoKey, session and reason required");
  let seq;
  const tx = db.transaction(() => {
    const info = db.prepare("INSERT INTO intents(repo_key, session, area, files_json, reason, at) VALUES (?,?,?,?,?,?)").run(
      repoKey, session, area ?? null, JSON.stringify(files ?? []), reason, now()
    );
    seq = info.lastInsertRowid;
    appendChange(db, { entity: "intent", entityId: `${repoKey}#${seq}`, op: "declared", node: authNode.name });
  });
  tx();
  return { seq };
}

// Set-once release: no DELETE verb exists; released_at can only go from NULL
// to a timestamp.
export function releaseIntents(db, authNode, { repoKey, session, seqs }) {
  let released = 0;
  const tx = db.transaction(() => {
    if (Array.isArray(seqs) && seqs.length) {
      for (const seq of seqs) {
        released += db.prepare("UPDATE intents SET released_at=? WHERE seq=? AND released_at IS NULL").run(now(), seq).changes;
      }
    } else {
      released = db
        .prepare("UPDATE intents SET released_at=? WHERE repo_key=? AND session=? AND released_at IS NULL")
        .run(now(), repoKey, session).changes;
    }
    if (released > 0) appendChange(db, { entity: "intent", entityId: repoKey ?? "batch", op: "released", node: authNode.name, summary: { released } });
  });
  tx();
  return { released };
}

export function listIntents(db, { repoKey, openOnly = true, limit = 100 }) {
  let sql = "SELECT * FROM intents WHERE 1=1";
  const args = [];
  if (repoKey) { sql += " AND repo_key=?"; args.push(repoKey); }
  if (openOnly) sql += " AND released_at IS NULL";
  sql += " ORDER BY seq DESC LIMIT ?";
  args.push(limit);
  return db.prepare(sql).all(...args).map((r) => ({
    seq: r.seq, repoKey: r.repo_key, session: r.session, area: r.area,
    files: parseJson(r.files_json, []), reason: r.reason, at: r.at, releasedAt: r.released_at
  }));
}

// ── feedback ────────────────────────────────────────────────────────────────

export function appendFeedback(db, authNode, { id, kind, area, sessionId, payload, legacyKey }) {
  const fid = id ?? `fq-${Date.now().toString(36).padStart(9, "0")}-${crypto.randomBytes(4).toString("hex")}`;
  let seq;
  const tx = db.transaction(() => {
    try {
      const info = db
        .prepare("INSERT INTO feedback_queue(id, at, node, kind, area, session_id, payload_json, legacy_key) VALUES (?,?,?,?,?,?,?,?)")
        .run(fid, now(), authNode.name, kind ?? null, area ?? null, sessionId ?? null, JSON.stringify(payload ?? {}), legacyKey ?? null);
      seq = info.lastInsertRowid;
    } catch (err) {
      if (String(err?.message).includes("UNIQUE")) {
        throw new StoreError(409, "feedback-exists", `feedback id ${fid} already recorded`);
      }
      throw err;
    }
    appendChange(db, { entity: "feedback", entityId: fid, op: "append", node: authNode.name });
  });
  tx();
  return { id: fid, seq };
}

export function tombstoneFeedback(db, authNode, { target, reason }) {
  if (!target) throw new StoreError(422, "invalid-tombstone", "target required");
  let seq;
  const tx = db.transaction(() => {
    const info = db.prepare("INSERT INTO feedback_tombstones(target, at, node, reason) VALUES (?,?,?,?)").run(
      target, now(), authNode.name, reason ?? null
    );
    seq = info.lastInsertRowid;
    appendChange(db, { entity: "feedback-tombstone", entityId: target, op: "append", node: authNode.name });
  });
  tx();
  return { seq };
}

export function listFeedbackTombstones(db, { limit = 1000 } = {}) {
  return db.prepare("SELECT seq, target, at, node, reason FROM feedback_tombstones ORDER BY seq DESC LIMIT ?").all(limit);
}

// The reader joins and drops tombstoned rows — exactly the two-pass semantics
// of feedback-signals.mjs, expressed as SQL.
export function listFeedback(db, { sinceSeq = 0, limit = 500, includeTombstoned = false }) {
  const rows = db
    .prepare(
      includeTombstoned
        ? "SELECT * FROM feedback_queue WHERE seq>? ORDER BY seq LIMIT ?"
        : `SELECT fq.* FROM feedback_queue fq
           WHERE fq.seq>? AND NOT EXISTS (
             SELECT 1 FROM feedback_tombstones t WHERE t.target = fq.id OR (fq.legacy_key IS NOT NULL AND t.target = fq.legacy_key))
           ORDER BY fq.seq LIMIT ?`
    )
    .all(sinceSeq, limit);
  return rows.map((r) => ({
    seq: r.seq, id: r.id, at: r.at, node: r.node, kind: r.kind, area: r.area,
    sessionId: r.session_id, payload: parseJson(r.payload_json, {}), legacyKey: r.legacy_key
  }));
}

// ── paymaster ───────────────────────────────────────────────────────────────

export function appendPaymasterUsage(db, authNode, { account, platform, tokens, headers }) {
  if (!account) throw new StoreError(422, "invalid-usage", "account required");
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO paymaster_usage(at, node, account, platform, tokens_json, headers_json) VALUES (?,?,?,?,?,?)").run(
      now(), authNode.name, account, platform ?? null, JSON.stringify(tokens ?? {}), JSON.stringify(headers ?? {})
    );
    appendChange(db, { entity: "paymaster", entityId: account, op: "append", node: authNode.name });
  });
  tx();
  return { ok: true };
}

export function listPaymasterUsage(db, { account, since, limit = 200 }) {
  let sql = "SELECT * FROM paymaster_usage WHERE 1=1";
  const args = [];
  if (account) { sql += " AND account=?"; args.push(account); }
  if (since) { sql += " AND at>=?"; args.push(since); }
  sql += " ORDER BY seq DESC LIMIT ?";
  args.push(limit);
  return db.prepare(sql).all(...args).map((r) => ({
    seq: r.seq, at: r.at, node: r.node, account: r.account, platform: r.platform,
    tokens: parseJson(r.tokens_json, {}), headers: parseJson(r.headers_json, {})
  }));
}

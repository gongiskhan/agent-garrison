// Garrison state service — the single owner of shared mesh state.
//
// Plain node:http, synchronous better-sqlite3 underneath. Binds LOOPBACK ONLY
// and is published to the tailnet via `tailscale serve` by the committed
// scripts/tailnet-publish.sh (the 2026-07-27 cleartext-vault-on-the-VPC
// incident governs: the socket must never sit on a routable address).
//
// Auth: Authorization: Bearer <node token>. The token alone is the identity —
// a caller-supplied name is never trusted. GET /v1/health is the only
// tokenless route and returns nothing but liveness + versions.

import http from "node:http";
import { openDb, binarySchemaVersion, schemaMeta, resolveDbPath } from "./db.mjs";
import {
  StoreError,
  authenticateToken, listNodes, hello,
  getConfigDoc, listConfigDocs, putConfigDoc,
  acquireLease, renewLease, releaseLease, getLease,
  appendEvent, listEvents, putOrigin, getOrigin,
  createNotification, pendingNotifications, markDelivered,
  upsertSession, getSession, listSessions,
  putSecret, deleteSecret, listSecretKeys, putGrant, deleteGrant, listGrants,
  resolveSecrets, loadoutEnv, compositionEnv,
  createCard, getCard, listCards, patchCard, deleteCard,
  putCardDoc, getCardDoc, listCardDocs, putCardAttachment,
  putComposition, getComposition, listCompositions,
  putCompositionFile, getCompositionFile, deleteCompositionFile,
  putSchedulerJob, listSchedulerJobs, deleteSchedulerJob,
  recordSchedulerRun, listSchedulerRuns,
  appendPlan, listPlans, declareIntent, releaseIntents, listIntents,
  appendFeedback, tombstoneFeedback, listFeedback,
  appendPaymasterUsage, listPaymasterUsage
} from "./store.mjs";
import { changeBus, signalChange, readChanges, maxSeq, minSeq } from "./lib/changes.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const db = openDb();
const SCHEMA_VERSION = binarySchemaVersion();
const META = schemaMeta(db);
const SERVICE_VERSION = process.env.GARRISON_STATE_VERSION?.trim() || pkg.version;

const BIND_HOST = process.env.GARRISON_STATE_BIND?.trim() || "127.0.0.1";
const PORT = Number(process.env.GARRISON_STATE_PORT ?? 8460);

const MAX_BODY = 4 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new StoreError(413, "body-too-large", `request body caps at ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new StoreError(400, "invalid-json", "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store"
  });
  res.end(text);
}

// Mutations signal the change feed after their transaction committed.
function mutate(fn) {
  const out = fn();
  signalChange();
  return out;
}

// Long-poll on the change feed: the ONE subscription mechanism per node.
async function handleChanges(res, url) {
  const since = Number(url.searchParams.get("since") ?? 0);
  if (!Number.isFinite(since) || since < 0) throw new StoreError(422, "invalid-cursor", "since must be a non-negative integer");
  const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 25), 0), 55);
  const lo = minSeq(db);
  if (since > 0 && lo > 0 && since < lo - 1) {
    throw new StoreError(410, "cursor-lost", "the cursor precedes the retained change window — full resync required", {
      earliest: lo,
      seq: maxSeq(db)
    });
  }
  let rows = readChanges(db, since);
  if (rows.length === 0 && wait > 0) {
    await new Promise((resolve) => {
      const timer = setTimeout(done, wait * 1000);
      function done() {
        clearTimeout(timer);
        changeBus.off("change", done);
        resolve();
      }
      changeBus.on("change", done);
    });
    rows = readChanges(db, since);
  }
  send(res, 200, { changes: rows, seq: rows.length ? rows[rows.length - 1].seq : Math.max(since, maxSeq(db)) });
}

function ifMatch(req) {
  const v = req.headers["if-match"];
  return v === undefined ? undefined : Number(String(v).replace(/"/g, ""));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://state.local");
  const parts = url.pathname.split("/").filter(Boolean); // ["v1", ...]
  try {
    if (parts[0] !== "v1") throw new StoreError(404, "not-found", "unknown path");
    const p = parts.slice(1);

    // ── tokenless ──
    if (req.method === "GET" && p[0] === "health" && p.length === 1) {
      return send(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION, serviceVersion: SERVICE_VERSION });
    }

    // ── auth ──
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const node = authenticateToken(db, token);
    if (!node) throw new StoreError(401, "unauthenticated", "a registered node bearer token is required");

    // A behind node reads freely; its writes refuse until it converges.
    const isWrite = req.method !== "GET" && req.method !== "HEAD";
    if (isWrite && node.status === "behind" && !(p[0] === "hello")) {
      throw new StoreError(409, "node-behind", "this node's schema window no longer matches the service — converge (git pull + restart) before writing");
    }

    const body = isWrite ? await readBody(req) : undefined;

    // ── hello ──
    if (req.method === "POST" && p[0] === "hello" && p.length === 1) {
      const { behind } = mutate(() => hello(db, node, body, SCHEMA_VERSION));
      return send(res, 200, {
        node: node.name,
        behind,
        schemaVersion: SCHEMA_VERSION,
        serviceVersion: SERVICE_VERSION,
        meshId: META.mesh_id,
        serverTime: new Date().toISOString()
      });
    }

    // ── changes ──
    if (req.method === "GET" && p[0] === "changes" && p.length === 1) {
      return await handleChanges(res, url);
    }

    // ── nodes ──
    if (p[0] === "nodes") {
      if (req.method === "GET" && p.length === 1) return send(res, 200, { nodes: listNodes(db) });
      if (req.method === "GET" && p.length === 2) {
        const found = listNodes(db).find((n) => n.name === p[1]);
        if (!found) throw new StoreError(404, "not-found", "no such node");
        return send(res, 200, found);
      }
    }

    // ── config docs ──
    if (p[0] === "config") {
      if (req.method === "GET" && p.length === 1) {
        return send(res, 200, { docs: listConfigDocs(db, url.searchParams.get("prefix") ?? undefined) });
      }
      if (p.length === 3) {
        const namespace = decodeURIComponent(p[1]);
        const scope = decodeURIComponent(p[2]);
        if (req.method === "GET") {
          const doc = getConfigDoc(db, namespace, scope);
          if (!doc) throw new StoreError(404, "not-found", "no such config document");
          return send(res, 200, doc);
        }
        if (req.method === "PUT") {
          const baselineSha = "x-baseline-sha" in req.headers
            ? (String(req.headers["x-baseline-sha"]) || null)
            : undefined;
          const out = mutate(() => putConfigDoc(db, node, { namespace, scope, body, ifMatchRev: ifMatch(req), baselineSha }));
          return send(res, 200, out);
        }
      }
    }

    // ── leases ──
    if (p[0] === "leases") {
      if (req.method === "POST" && p[1] === "acquire") return send(res, 200, mutate(() => acquireLease(db, node, body ?? {})));
      if (req.method === "POST" && p[1] === "renew") return send(res, 200, renewLease(db, node, body ?? {}));
      if (req.method === "POST" && p[1] === "release") return send(res, 200, mutate(() => releaseLease(db, node, body ?? {})));
      if (req.method === "GET" && p.length >= 2) {
        const key = decodeURIComponent(p.slice(1).join("/"));
        return send(res, 200, { lease: getLease(db, key) });
      }
    }

    // ── events / origins / notifications ── (append-only: no update/delete verbs)
    if (p[0] === "events") {
      if (req.method === "POST" && p.length === 1) return send(res, 201, mutate(() => appendEvent(db, node, body ?? {})));
      if (req.method === "GET" && p.length === 1) {
        return send(res, 200, {
          events: listEvents(db, {
            originId: url.searchParams.get("origin") ?? undefined,
            kind: url.searchParams.get("kind") ?? undefined,
            sinceSeq: Number(url.searchParams.get("since_seq") ?? 0),
            limit: Number(url.searchParams.get("limit") ?? 200)
          })
        });
      }
    }
    if (p[0] === "origins") {
      if (req.method === "PUT" && p.length === 2) return send(res, 200, mutate(() => putOrigin(db, node, decodeURIComponent(p[1]), body ?? {})));
      if (req.method === "GET" && p.length === 2) {
        const o = getOrigin(db, decodeURIComponent(p[1]));
        if (!o) throw new StoreError(404, "not-found", "no such origin");
        return send(res, 200, o);
      }
    }
    if (p[0] === "notifications") {
      if (req.method === "POST" && p.length === 1) return send(res, 201, mutate(() => createNotification(db, node, body ?? {})));
      if (req.method === "GET" && p[1] === "pending") return send(res, 200, { notifications: pendingNotifications(db, node.name) });
      if (req.method === "POST" && p.length === 3 && p[2] === "delivered") {
        return send(res, 200, mutate(() => markDelivered(db, node, p[1], body?.legs)));
      }
    }

    // ── sessions ──
    if (p[0] === "sessions") {
      if (req.method === "GET" && p.length === 1) {
        return send(res, 200, {
          sessions: listSessions(db, {
            node: url.searchParams.get("node") ?? undefined,
            status: url.searchParams.get("status") ?? undefined,
            activeOnly: url.searchParams.get("active") === "1",
            cwd: url.searchParams.get("cwd") ?? undefined
          })
        });
      }
      if (p.length === 2) {
        const id = decodeURIComponent(p[1]);
        if (req.method === "GET") {
          const s = getSession(db, id);
          if (!s) throw new StoreError(404, "not-found", "no such session");
          return send(res, 200, s);
        }
        if (req.method === "PUT") return send(res, 200, mutate(() => upsertSession(db, node, id, body ?? {})));
      }
    }

    // ── secrets ──
    if (p[0] === "secrets") {
      if (req.method === "GET" && p.length === 1) return send(res, 200, { keys: listSecretKeys(db) });
      if (req.method === "POST" && p[1] === "resolve") return send(res, 200, mutate(() => resolveSecrets(db, node, body?.keys)));
      if (req.method === "POST" && p[1] === "loadout-env") return send(res, 200, mutate(() => loadoutEnv(db, node, body?.project)));
      if (req.method === "POST" && p[1] === "composition-env") return send(res, 200, mutate(() => compositionEnv(db, node, body ?? {})));
      if (p[1] === "grants") {
        if (req.method === "GET") return send(res, 200, { grants: listGrants(db) });
        if (req.method === "POST") return send(res, 200, mutate(() => putGrant(db, node, body ?? {})));
        if (req.method === "DELETE") return send(res, 200, mutate(() => deleteGrant(db, node, body ?? {})));
      }
      if (p.length === 2) {
        const key = decodeURIComponent(p[1]);
        if (req.method === "PUT") return send(res, 200, mutate(() => putSecret(db, node, key, body?.value)));
        if (req.method === "DELETE") return send(res, 200, mutate(() => deleteSecret(db, node, key)));
      }
    }

    // ── cards ──
    if (p[0] === "cards") {
      if (req.method === "POST" && p.length === 1) return send(res, 201, mutate(() => createCard(db, node, body ?? {})));
      if (req.method === "GET" && p.length === 1) {
        return send(res, 200, {
          cards: listCards(db, {
            list: url.searchParams.get("list") ?? undefined,
            placement: url.searchParams.get("placement") ?? undefined,
            scheduledBefore: url.searchParams.get("scheduled_before") ?? undefined,
            system: url.searchParams.get("system") ?? undefined,
            includeDeleted: url.searchParams.get("deleted") === "1"
          })
        });
      }
      if (p.length >= 2) {
        const id = decodeURIComponent(p[1]);
        if (p.length === 2) {
          if (req.method === "GET") {
            const card = getCard(db, id);
            if (!card) throw new StoreError(404, "not-found", "no such card");
            return send(res, 200, card);
          }
          if (req.method === "PATCH") {
            const fence = req.headers["x-fence"] !== undefined ? Number(req.headers["x-fence"]) : undefined;
            return send(res, 200, mutate(() => patchCard(db, node, id, body ?? {}, { ifMatchRev: ifMatch(req), fence })));
          }
          if (req.method === "DELETE") return send(res, 200, mutate(() => deleteCard(db, node, id, { ifMatchRev: ifMatch(req) })));
        }
        if (p[2] === "docs") {
          if (req.method === "GET" && p.length === 3) return send(res, 200, { docs: listCardDocs(db, id) });
          if (p.length === 4) {
            const name = decodeURIComponent(p[3]);
            if (req.method === "GET") {
              const doc = getCardDoc(db, id, name);
              if (!doc) throw new StoreError(404, "not-found", "no such card doc");
              return send(res, 200, doc);
            }
            if (req.method === "PUT") return send(res, 200, mutate(() => putCardDoc(db, node, id, name, body?.body)));
          }
        }
        if (p[2] === "attachments" && req.method === "PUT" && p.length === 4) {
          return send(res, 200, mutate(() => putCardAttachment(db, node, id, decodeURIComponent(p[3]), body ?? {})));
        }
      }
    }

    // ── compositions ──
    if (p[0] === "compositions") {
      if (req.method === "GET" && p.length === 1) return send(res, 200, { compositions: listCompositions(db) });
      if (p.length >= 2) {
        const id = decodeURIComponent(p[1]);
        if (p.length === 2) {
          if (req.method === "GET") {
            const comp = getComposition(db, id);
            if (!comp) throw new StoreError(404, "not-found", "no such composition");
            return send(res, 200, comp);
          }
          if (req.method === "PUT") {
            return send(res, 200, mutate(() => putComposition(db, node, id, { manifestYaml: body?.manifestYaml, ifMatchRev: ifMatch(req) })));
          }
        }
        if (p[2] === "files" && p.length >= 4) {
          const relPath = decodeURIComponent(p.slice(3).join("/"));
          if (req.method === "GET") {
            const f = getCompositionFile(db, id, relPath);
            if (!f) throw new StoreError(404, "not-found", "no such composition file");
            return send(res, 200, f);
          }
          if (req.method === "PUT") return send(res, 200, mutate(() => putCompositionFile(db, node, id, relPath, body?.body)));
          if (req.method === "DELETE") return send(res, 200, mutate(() => deleteCompositionFile(db, node, id, relPath)));
        }
      }
    }

    // ── scheduler ──
    if (p[0] === "scheduler") {
      if (p[1] === "jobs") {
        if (req.method === "GET" && p.length === 2) {
          return send(res, 200, { jobs: listSchedulerJobs(db, { target: url.searchParams.get("target") ?? undefined }) });
        }
        if (p.length === 3) {
          const id = decodeURIComponent(p[2]);
          if (req.method === "PUT") return send(res, 200, mutate(() => putSchedulerJob(db, node, id, { ...(body ?? {}), ifMatchRev: ifMatch(req) })));
          if (req.method === "DELETE") return send(res, 200, mutate(() => deleteSchedulerJob(db, node, id, { ifMatchRev: ifMatch(req) })));
        }
      }
      if (p[1] === "runs") {
        if (req.method === "POST") return send(res, 200, mutate(() => recordSchedulerRun(db, node, body ?? {})));
        if (req.method === "GET") {
          return send(res, 200, { runs: listSchedulerRuns(db, { jobId: url.searchParams.get("job") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 100) }) });
        }
      }
    }

    // ── coordination ──
    if (p[0] === "coord") {
      if (p[1] === "plans") {
        if (req.method === "POST") return send(res, 201, mutate(() => appendPlan(db, node, body ?? {})));
        if (req.method === "GET") {
          return send(res, 200, { plans: listPlans(db, { repoKey: url.searchParams.get("repo") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 20) }) });
        }
      }
      if (p[1] === "intents") {
        if (req.method === "POST" && p.length === 2) return send(res, 201, mutate(() => declareIntent(db, node, body ?? {})));
        if (req.method === "POST" && p[2] === "release") return send(res, 200, mutate(() => releaseIntents(db, node, body ?? {})));
        if (req.method === "GET") {
          return send(res, 200, {
            intents: listIntents(db, {
              repoKey: url.searchParams.get("repo") ?? undefined,
              openOnly: url.searchParams.get("all") !== "1"
            })
          });
        }
      }
    }

    // ── feedback ── (append-only + tombstones; no update/delete verbs)
    if (p[0] === "feedback") {
      if (req.method === "POST" && p.length === 1) return send(res, 201, mutate(() => appendFeedback(db, node, body ?? {})));
      if (req.method === "GET" && p.length === 1) {
        return send(res, 200, {
          feedback: listFeedback(db, {
            sinceSeq: Number(url.searchParams.get("since_seq") ?? 0),
            limit: Number(url.searchParams.get("limit") ?? 500),
            includeTombstoned: url.searchParams.get("tombstoned") === "1"
          })
        });
      }
      if (req.method === "POST" && p[1] === "tombstones") return send(res, 201, mutate(() => tombstoneFeedback(db, node, body ?? {})));
    }

    // ── paymaster ──
    if (p[0] === "paymaster") {
      if (req.method === "POST" && p[1] === "usage") return send(res, 200, mutate(() => appendPaymasterUsage(db, node, body ?? {})));
      if (req.method === "GET" && p[1] === "usage") {
        return send(res, 200, {
          usage: listPaymasterUsage(db, {
            account: url.searchParams.get("account") ?? undefined,
            since: url.searchParams.get("since") ?? undefined,
            limit: Number(url.searchParams.get("limit") ?? 200)
          })
        });
      }
    }

    throw new StoreError(404, "not-found", `no route for ${req.method} ${url.pathname}`);
  } catch (err) {
    if (err instanceof StoreError) {
      return send(res, err.status, err.body);
    }
    console.error(`[state] unhandled error on ${req.method} ${req.url}:`, err);
    return send(res, 500, { error: "internal", detail: String(err?.message ?? err) });
  }
});

// Retention: the service prunes its own append-only tables; no client ever
// does. Change rows older than 7 days go; a pruned cursor 410s into a resync.
const PRUNE_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("DELETE FROM changes WHERE at < ?").run(cutoff);
    db.prepare("DELETE FROM leases WHERE expires_at < ?").run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  } catch (err) {
    console.error("[state] prune failed:", err);
  }
}, PRUNE_MS).unref();

server.listen(PORT, BIND_HOST, () => {
  const actual = server.address();
  console.log(
    `[state] garrison-state ${SERVICE_VERSION} schema=${SCHEMA_VERSION} db=${resolveDbPath()} listening on http://${BIND_HOST}:${actual.port}`
  );
});

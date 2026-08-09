#!/usr/bin/env node
// Omi channel Fitting backend — Garrison's ears (and one mouth) on the Omi
// wearable ecosystem. Bidirectional channel: webhook ingress from Omi's cloud
// (memory-creation, realtime transcript, day summary, chat tool calls),
// heartbeat triage into Kanban cards + memories, outbound Omi direct
// notifications, a wake-word live pipe, and a backfeed into Omi memories.
//
// M0 scaffold: boot, /health, status file, minimal status page. Every ingress
// endpoint answers 501 until its milestone lands. Every pipe is behind its own
// default-off flag (invariant I9); with all flags off this server is inert.
//
// Ingress routes all live under /omi/ so the public Tailscale Funnel mapping
// can mount ONLY that path prefix — /health and the status page stay
// tailnet/loopback-only. See docs/adr-omi-channel.md.

import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { FITTING_ID, loadConfig } from "../lib/config.mjs";
import { Counters, OmiStore, mergedCounters } from "../lib/store.mjs";
import { Ingress } from "../lib/ingress.mjs";
import { syncTriageJob } from "../lib/scheduler-jobs.mjs";
import { Notifier } from "../lib/notify.mjs";
import { OmiApi } from "../lib/omi-api.mjs";
import { WakeBus } from "../lib/wake.mjs";
import { ChatTool } from "../lib/chat.mjs";
import { Backfeed } from "../lib/backfeed.mjs";
import { boardCardUrl } from "../lib/notify.mjs";
import { inferenceRunFn, operativeRunFn } from "../lib/gateway-client.mjs";
import { BoardClient } from "../lib/board-client.mjs";
import { MemoryWriter } from "../lib/memory-writer.mjs";
import { EchoGuard } from "../lib/echo-guard.mjs";

const BACKFEED_INTERVAL_MS = 30 * 60 * 1000;
const BACKFEED_BOOT_DELAY_MS = 2 * 60 * 1000;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const STATUS_CSS_FILE = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "ui",
  "styles.css"
);

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// Read a request body with a hard cap; resolves null when over the cap.
function readBody(req, cap = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > cap) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// True when `pid` names a live process (EPERM still means alive, just not ours).
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function readStatusFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeStatusFile(cfg) {
  const file = cfg.statusFile;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      {
        fittingId: FITTING_ID,
        port: cfg.port,
        url: `http://${cfg.bindHost === "0.0.0.0" ? "localhost" : cfg.bindHost}:${cfg.port}`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
}

async function clearStatusFile(file) {
  try {
    await unlink(file);
  } catch {}
}

// PERMANENT compatibility layer for an upstream bug — not a workaround for a
// user typo (verified 2026-07-31: all three stored webhook URLs end cleanly at
// the secret, read back from GET /v1/users/developer/webhook/<type>).
//
// Omi's DEPLOYED realtime sender appends the uid by naive concatenation, so a
// URL that already carries `?key=…` receives a SECOND `?`:
//   …/omi/realtime?key=<secret>?uid=<uid>
// The whole `secret?uid=<uid>` string then arrives as a single `key` param and
// no `uid` param exists at all, so every delivery 401s — and 100 consecutive
// failures make Omi auto-disable the webhook permanently. (Their current main
// uses an &-correct urlsplit/urlencode helper, so this may fix itself upstream;
// the repair stays because we cannot detect which version is deployed.)
//
// The memory_created path does NOT do this, which is why conversations worked
// while realtime was silently dead. This never weakens auth: the recovered
// `key` is still compared in full, and real params always beat recovered ones.
let repairWarned = false;

export function repairDoubleEncodedQuery(query, counters = null, expectedSecret = "") {
  const key = typeof query.key === "string" ? query.key : "";
  if (!key) return query;

  // Two ways the params get glued into `key`, and we must not assume which:
  //  1. a literal '&' survived the decode  -> split on it;
  //  2. some OTHER separator (encoded '&', newline, space) -> we cannot know it,
  //     so detect the boundary by exact-prefix match on the secret instead.
  // Guessing the separator from a length delta already failed once, so never
  // infer it again. The prefix test is only PARSING: the authoritative check is
  // still the timing-safe compare below, and a value that begins with the whole
  // secret is by definition presented by someone who already holds it.
  let head;
  let tail;
  if (key.includes("&")) {
    const at = key.indexOf("&");
    head = key.slice(0, at);
    tail = key.slice(at + 1);
  } else if (expectedSecret && key.length > expectedSecret.length && key.startsWith(expectedSecret)) {
    head = expectedSecret;
    tail = key.slice(expectedSecret.length);
  } else {
    return query;
  }

  // Permissive: handles "&uid=X&session_id=Y" and "<sep>uid=X" alike.
  const recovered = {};
  for (const match of tail.matchAll(/([a-z_]+)=([^&?\s]+)/gi)) recovered[match[1]] = match[2];
  if (Object.keys(recovered).length === 0) return query;

  const merged = { ...query, key: head };
  for (const [k, v] of Object.entries(recovered)) {
    const present = merged[k];
    if (present === undefined || present === "") merged[k] = v;
  }
  counters?.bump?.("query_repaired_double_encoded");
  // Counted, not logged per delivery: this fires on EVERY realtime webhook, so
  // a line each would be pure noise for a known upstream defect nobody can fix
  // from this side. The counter is the signal that it is still happening.
  if (!repairWarned) {
    repairWarned = true;
    console.warn(
      `[omi-channel] repairing mangled webhook queries: key swallowed ` +
        `[${Object.keys(recovered).join(",")}] via ${JSON.stringify(tail.slice(0, 6))}. ` +
        `Omi appends the uid with a second '?' - upstream bug, the stored URL is correct. ` +
        `Logged once per process; see the query_repaired_double_encoded counter.`
    );
  }
  return merged;
}

function flagSummary(cfg) {
  return {
    ingress: cfg.enabled,
    triage: cfg.triageEnabled,
    wake: cfg.wakeEnabled,
    notify: cfg.notifyEnabled,
    chat: cfg.chatEnabled,
    backfeed: cfg.backfeedEnabled,
    tips: cfg.tipsEnabled
  };
}

function secretsPresence(cfg) {
  return {
    appId: Boolean(cfg.secrets.appId),
    appSecret: Boolean(cfg.secrets.appSecret),
    importApiKey: Boolean(cfg.secrets.importApiKey),
    webhookSecret: Boolean(cfg.secrets.webhookSecret)
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusBadge(label, state) {
  const tone = ["ok", "muted", "warn", "alarm"].includes(state) ? state : "muted";
  return `<span class="status status--${tone}"><span class="status__mark" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

function summaryItem(label, value, state, detail) {
  const tone = ["ok", "muted", "warn", "alarm"].includes(state) ? state : "muted";
  return `<div class="summary__item">
    <span class="summary__label">${escapeHtml(label)}</span>
    <strong class="summary__value">${escapeHtml(value)}</strong>
    <span class="summary__detail summary__detail--${tone}">${escapeHtml(detail)}</span>
  </div>`;
}

export async function probeGateway(cfg, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  if (!cfg.gatewayUrl) {
    return { state: "missing", label: "Missing", tone: "alarm", detail: "not configured" };
  }
  let healthUrl;
  try {
    healthUrl = new URL("/health", cfg.gatewayUrl).toString();
  } catch {
    return { state: "degraded", label: "Degraded", tone: "alarm", detail: "invalid gateway URL" };
  }
  try {
    const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return {
        state: "degraded",
        label: "Degraded",
        tone: "alarm",
        detail: `health returned HTTP ${response.status}`
      };
    }
    const body = await response.json().catch(() => null);
    if (body?.ok === false) {
      return { state: "degraded", label: "Degraded", tone: "alarm", detail: "health reported not ready" };
    }
    return { state: "ready", label: "Ready", tone: "ok", detail: "health check passed" };
  } catch (error) {
    const timedOut = /abort|timeout/i.test(String(error?.name ?? "") + " " + String(error?.message ?? error));
    return {
      state: "offline",
      label: "Offline",
      tone: "alarm",
      detail: timedOut ? "health check timed out" : "health check failed"
    };
  }
}

export function statusPage(cfg, counters = {}, { pinnedUid = null, gateway = null } = {}) {
  const flags = flagSummary(cfg);
  const secrets = secretsPresence(cfg);
  const enabledCount = Object.values(flags).filter(Boolean).length;
  const secretCount = Object.values(secrets).filter(Boolean).length;
  const gatewayState = gateway ?? (
    cfg.gatewayUrl
      ? { state: "unknown", label: "Configured", tone: "warn", detail: "health not checked" }
      : { state: "missing", label: "Missing", tone: "alarm", detail: "not configured" }
  );
  const wearerPinned = Boolean(pinnedUid);
  // Counters per pipe (spec M7) - the always-available metrics surface next
  // to /health. Wake counters are counts only; no transcript content exists
  // anywhere in this fitting's observability (I5).
  const counterKeys = Object.keys(counters)
    .filter((k) => k !== "updatedAt")
    .sort();
  const counterRows = counterKeys
    .map((k) => `<tr><th scope="row"><code>${escapeHtml(k)}</code></th><td>${escapeHtml(counters[k])}</td></tr>`)
    .join("\n");
  const row = (k, v) =>
    `<tr><th scope="row">${escapeHtml(k)}</th><td>${statusBadge(v ? "Enabled" : "Disabled", v ? "ok" : "muted")}</td></tr>`;
  const srow = (k, v) =>
    `<tr><th scope="row"><code>${escapeHtml(k)}</code></th><td>${statusBadge(v ? "Sealed" : "Missing", v ? "ok" : "warn")}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Omi channel · Garrison</title>
<meta name="description" content="Read-only health and activity for Garrison's Omi wearable channel.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to status</a>
<div class="shell">
  <header class="hero">
    <p class="eyebrow">Channel · wearable</p>
    <div class="hero__title-row">
      <h1>Omi channel</h1>
      ${statusBadge(cfg.enabled ? "Receiving" : "Standby", cfg.enabled ? "ok" : "muted")}
    </div>
    <p class="hero__copy">Bidirectional capture, triage, wake commands, and personal notifications. Configuration stays in the Fitting editor; this page reports what is ready now.</p>
  </header>

  <main id="main">
    <section class="summary" aria-label="Channel summary">
      ${summaryItem("Pipes", `${enabledCount} / ${Object.keys(flags).length}`, enabledCount ? "ok" : "muted", enabledCount ? "enabled" : "all paused")}
      ${summaryItem("Credentials", `${secretCount} / ${Object.keys(secrets).length}`, secretCount === Object.keys(secrets).length ? "ok" : "warn", secretCount === Object.keys(secrets).length ? "sealed" : "incomplete")}
      ${summaryItem("Gateway", gatewayState.label, gatewayState.tone, gatewayState.detail)}
      ${summaryItem("Wearer", wearerPinned ? "Pinned" : "Unpinned", wearerPinned ? "ok" : "warn", wearerPinned ? "identity masked" : "waiting for ingress")}
    </section>

    <div class="status-grid">
      <section class="panel" aria-labelledby="pipes-title">
        <div class="panel__heading">
          <div><p class="section-kicker">Live paths</p><h2 id="pipes-title">Pipes</h2></div>
          <span class="panel__meta">independent gates</span>
        </div>
        <div class="table-wrap">
          <table>
            <caption>Omi channel pipe readiness</caption>
            <tbody>
              ${row("Ingress webhooks", flags.ingress)}
              ${row("Heartbeat triage", flags.triage)}
              ${row("Wake bus", flags.wake)}
              ${row("Outbound notifications", flags.notify)}
              ${row("Chat tool — ask_gary", flags.chat)}
              ${row("Memory backfeed", flags.backfeed)}
              ${row("Tips", flags.tips)}
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel" aria-labelledby="credentials-title">
        <div class="panel__heading">
          <div><p class="section-kicker">Vault presence</p><h2 id="credentials-title">Credentials</h2></div>
          <span class="panel__meta">values never shown</span>
        </div>
        <div class="table-wrap">
          <table>
            <caption>Required Omi credentials</caption>
            <tbody>
              ${srow("OMI_APP_ID", secrets.appId)}
              ${srow("OMI_APP_SECRET", secrets.appSecret)}
              ${srow("OMI_IMPORT_API_KEY", secrets.importApiKey)}
              ${srow("OMI_WEBHOOK_SECRET", secrets.webhookSecret)}
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <section class="panel panel--activity" aria-labelledby="activity-title">
      <div class="panel__heading">
        <div><p class="section-kicker">Since last reset</p><h2 id="activity-title">Activity</h2></div>
        <span class="panel__meta">counts only · no transcript content</span>
      </div>
      <div class="table-wrap">
        <table class="activity-table">
          <caption>Omi channel activity counters</caption>
          <tbody>
            ${counterRows || '<tr class="empty-row"><td colspan="2">No activity has been recorded yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  </main>

  <footer>
    <span>Ingress endpoints</span><code>/omi/</code><span aria-hidden="true">·</span><span>read-only diagnostics</span>
  </footer>
</div>
</body></html>`;
}

export function makeRequestHandler(ctx) {
  const { cfg, store, counters, ingress, notifier = null, chatTool = null } = ctx;
  // The guard the ingress already holds, so /ack registers into the SAME window
  // the realtime filter reads. A second instance here would register echoes
  // nothing ever consults.
  const echoGuard = ctx.echoGuard ?? ingress?.echoGuard ?? null;
  let gatewayCache = { at: 0, value: null };
  const gatewayStatus = async () => {
    const now = Date.now();
    if (gatewayCache.value && now - gatewayCache.at < 5000) return gatewayCache.value;
    const value = ctx.gatewayProbe
      ? await ctx.gatewayProbe(cfg)
      : await probeGateway(cfg, { fetchImpl: ctx.fetchImpl ?? fetch });
    gatewayCache = { at: now, value };
    return value;
  };
  return async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";
      const query = repairDoubleEncodedQuery(parsed.query || {}, counters, cfg.secrets?.webhookSecret ?? "");

      if (pathname === "/health" || pathname === "/api/health") {
        const pinned = store.pinnedUid();
        const gateway = await gatewayStatus();
        return jsonRes(res, 200, {
          ok: true,
          fittingId: FITTING_ID,
          port: cfg.port,
          pid: process.pid,
          flags: flagSummary(cfg),
          secrets: secretsPresence(cfg),
          gatewayConfigured: Boolean(cfg.gatewayUrl),
          gateway,
          pinnedUid: pinned ? `${pinned.slice(0, 4)}...` : null,
          counters: mergedCounters(store.root)
        });
      }

      if (pathname === "/" && method === "GET") {
        const gateway = await gatewayStatus();
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(statusPage(cfg, mergedCounters(store.root), { pinnedUid: store.pinnedUid(), gateway }));
      }

      if (pathname === "/styles.css" && method === "GET") {
        try {
          const css = await readFile(STATUS_CSS_FILE, "utf8");
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/css; charset=utf-8");
          res.setHeader("Cache-Control", "public, max-age=300");
          res.setHeader("X-Content-Type-Options", "nosniff");
          return res.end(css);
        } catch {
          return jsonRes(res, 404, { error: "status stylesheet unavailable" });
        }
      }

      // Loopback-only push relay: the scheduler-spawned triage process holds
      // no Omi secrets, so it hands its pushes to this process (which does).
      // Deliberately OUTSIDE /omi/ - the public Funnel mounts only that
      // prefix, and the server binds loopback, so this route is never
      // reachable off-box.
      // The acknowledgement fan-out (kanban-loop fanOutAck) reaches every running
      // fitting. This one does not SPEAK an ack - the Mac sink does - it listens
      // for what is about to be said so the pendant hearing it back is dropped
      // rather than transcribed into a card. Loopback only, outside /omi/ so the
      // public Funnel can never mount it.
      if (pathname === "/ack" && method === "POST") {
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        let ack = null;
        try {
          ack = JSON.parse(bodyText);
        } catch {
          return jsonRes(res, 400, { error: "invalid JSON" });
        }
        const text = typeof ack?.text === "string" ? ack.text : "";
        if (!text.trim()) return jsonRes(res, 400, { error: "ack has no text" });
        const registered = echoGuard.register({ text, echo: ack?.echo ?? null });
        return jsonRes(res, 200, { ok: true, registered });
      }

      if (pathname === "/internal/omi-push" && method === "POST") {
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        let body = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return jsonRes(res, 400, { error: "Invalid request." });
        }
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) return jsonRes(res, 400, { error: "Missing message." });
        if (!notifier) return jsonRes(res, 200, { means: "omi-push", ok: false, skipped: "notifier unavailable" });
        return jsonRes(res, 200, await notifier.sendOmi(message));
      }

      // ---- Ingress surface. Everything under /omi/ (the public Funnel mount
      // path); ?key= shared secret + pinned uid on every route (I8). ----
      if (pathname === "/omi/memory" && method === "POST") {
        const auth = ingress.authorize(query, pathname);
        if (!auth.ok) return jsonRes(res, auth.status, { error: auth.reason });
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        // Ack fast (I7): enqueue is one small file write; normalization runs
        // on the serialized drain chain after the response.
        ingress.accept({ kind: "conversation", uid: auth.uid, bodyText });
        return jsonRes(res, 200, { ok: true });
      }

      if (pathname === "/omi/day-summary" && method === "POST") {
        const auth = ingress.authorize(query, pathname);
        if (!auth.ok) return jsonRes(res, auth.status, { error: auth.reason });
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        ingress.accept({ kind: "day_summary", uid: auth.uid, bodyText });
        return jsonRes(res, 200, { ok: true });
      }

      if (pathname === "/omi/realtime" && method === "POST") {
        const auth = ingress.authorize(query, pathname);
        if (!auth.ok) return jsonRes(res, auth.status, { error: auth.reason });
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        // In-memory only (I5) - counted, never persisted, never logged.
        ingress.acceptRealtime({ bodyText, sessionId: query.session_id });
        return jsonRes(res, 200, { ok: true });
      }

      // ---- Thread-append contract (NOT under /omi/ - never on the public
      // funnel mount; reachable loopback/tailnet like every fitting API).
      // This is how other Garrison surfaces (kanban notify-origin) hand this
      // channel a system notification: stored for inspection, relayed to the
      // wearer via the Notifier's omi-push -> web-channel degrade chain.
      if (pathname === "/api/threads" && method === "POST") {
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        let body = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return jsonRes(res, 400, { error: "invalid JSON" });
        }
        if (!body?.id) return jsonRes(res, 400, { error: "missing thread id" });
        const thread = store.ensureThread({ id: body.id, title: body.title ?? null, source: body.source ?? null });
        return jsonRes(res, 200, { ok: true, thread: { id: thread.id, title: thread.title } });
      }

      {
        const m = pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
        if (m && method === "POST") {
          const bodyText = await readBody(req);
          if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
          let body = null;
          try {
            body = JSON.parse(bodyText);
          } catch {
            return jsonRes(res, 400, { error: "invalid JSON" });
          }
          const threadId = decodeURIComponent(m[1]);
          const idempotencyKey = typeof body?.idempotencyKey === "string"
            ? body.idempotencyKey.trim().slice(0, 200)
            : null;
          const previousDelivery = idempotencyKey ? store.threadDelivery(threadId, idempotencyKey) : null;
          const appended = store.appendThreadMessages(threadId, body?.messages, { idempotencyKey });
          counters.bump("thread_messages_in", appended.length || 0);
          // A caller that also owns an independent Web delivery (Morning
          // briefing) must be able to ask for Omi-direct-or-degraded, not Omi's
          // usual Omi→Web fallback. Await that delivery so the caller receives
          // honest per-means receipts it can persist on its occurrence card.
          if (body?.suppressWebFallback === true && notifier) {
            if (previousDelivery?.status === "complete") {
              return jsonRes(res, 200, {
                ok: true,
                appended: 0,
                deduplicated: true,
                deliveryReceipts: previousDelivery.receipts ?? []
              });
            }
            if (previousDelivery && appended.length === 0) {
              const deliveryReceipts = [{
                means: "omi-push",
                ok: false,
                skipped: "an earlier idempotent append has an incomplete delivery receipt; duplicate push suppressed"
              }];
              if (idempotencyKey) store.completeThreadDelivery(threadId, idempotencyKey, deliveryReceipts);
              return jsonRes(res, 200, { ok: true, appended: 0, deduplicated: true, deliveryReceipts });
            }
            const deliveryReceipts = [];
            for (const msg of appended) {
              deliveryReceipts.push(...await notifier.send({
                template: "relay",
                params: { text: msg.text },
                suppressWebFallback: true
              }));
            }
            if (idempotencyKey) store.completeThreadDelivery(threadId, idempotencyKey, deliveryReceipts);
            return jsonRes(res, 200, { ok: true, appended: appended.length, deliveryReceipts });
          }
          if (idempotencyKey && notifier) {
            if (previousDelivery?.status === "complete") {
              return jsonRes(res, 200, {
                ok: true,
                appended: 0,
                deduplicated: true,
                deliveryReceipts: previousDelivery.receipts ?? []
              });
            }
            if (previousDelivery && appended.length === 0) {
              const deliveryReceipts = [{
                means: "omi-push",
                ok: false,
                skipped: "an earlier idempotent append has an incomplete delivery receipt; duplicate relay suppressed"
              }];
              store.completeThreadDelivery(threadId, idempotencyKey, deliveryReceipts);
              return jsonRes(res, 200, { ok: true, appended: 0, deduplicated: true, deliveryReceipts });
            }
            const deliveryReceipts = [];
            for (const msg of appended) {
              deliveryReceipts.push(...await notifier.send({ template: "relay", params: { text: msg.text } }));
            }
            store.completeThreadDelivery(threadId, idempotencyKey, deliveryReceipts);
            return jsonRes(res, 200, { ok: true, appended: appended.length, deliveryReceipts });
          }
          // Ack first, relay after - the caller (kanban) is fire-and-forget.
          jsonRes(res, 200, { ok: true, appended: appended.length });
          if (notifier) {
            for (const msg of appended) {
              void notifier
                .send({ template: "relay", params: { text: msg.text } })
                .catch((err) => console.error(`[omi-channel] relay failed: ${err?.message ?? err}`));
            }
          }
          return;
        }
      }

      // ---- ask_gary chat tool (M5). Own auth (chat_enabled + key + app_id +
      // pinned uid from the BODY - Omi tool calls carry uid in the payload).
      if (pathname === "/omi/chat" && method === "POST" && chatTool) {
        const bodyText = await readBody(req);
        if (bodyText === null) return jsonRes(res, 413, { error: "body too large" });
        let body = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return jsonRes(res, 400, { error: "Invalid request." });
        }
        const outcome = await chatTool.handle(query, body);
        return jsonRes(res, outcome.status, outcome.body);
      }
      if (pathname === "/omi/tools-manifest" && method === "GET" && chatTool) {
        const outcome = chatTool.manifest(query);
        return jsonRes(res, outcome.status, outcome.body);
      }

      return jsonRes(res, 404, { error: "not found" });
    } catch (err) {
      console.error(`[omi-channel] request error: ${err?.stack || err}`);
      if (!res.headersSent) jsonRes(res, 500, { error: "internal error" });
      else res.end();
    }
  };
}

export async function startServer(cfg = loadConfig()) {
  // Port discipline: never overwrite a status file whose pid is a LIVE other
  // process — a second spawn must fail loudly instead of silently stealing the
  // tracking slot and orphaning the first instance.
  const existing = await readStatusFile(cfg.statusFile);
  if (existing && Number.isInteger(existing.pid) && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(
      `[omi-channel] refusing to start: ${cfg.statusFile} tracks a live instance ` +
        `(pid ${existing.pid}, ${existing.url ?? `port ${existing.port}`}) - stop it first`
    );
    process.exit(1);
  }

  // `live` is what handlers read; port is corrected to the actually-bound one
  // after listen (tests pass port 0 for an ephemeral bind).
  const live = { ...cfg };
  const store = new OmiStore(live.stateDir);
  const counters = new Counters(store.root, "server");
  const notifier = new Notifier({
    cfg: live,
    store,
    counters,
    omiApi: new OmiApi({ appId: live.secrets.appId, appSecret: live.secrets.appSecret })
  });
  // The full-toolset lane, shared by the wake bus and the chat tool. Nothing
  // blocks on it: both surfaces acknowledge first and notify when it answers.
  const operativeFn =
    live.gatewayUrl && live.delegateEnabled
      ? operativeRunFn(live.gatewayUrl, { timeoutMs: live.delegateTimeoutMs })
      : null;
  const wakeBus = new WakeBus({
    cfg: live,
    store,
    counters,
    runFn: live.gatewayUrl
      ? inferenceRunFn(live.gatewayUrl, { target: live.classifyTarget || null })
      : null,
    operativeFn,
    board: new BoardClient(),
    memoryWriter: new MemoryWriter(),
    notifier
  });
  const echoGuard = new EchoGuard({ counters });
  const ingress = new Ingress({ cfg: live, store, counters, wakeBus, echoGuard });
  const chatTool = new ChatTool({
    cfg: live,
    store,
    counters,
    // Bounded fast path: the fetch aborts just past the answer deadline so a
    // hung gateway can never hold the Omi chat UI hostage.
    runFn: live.gatewayUrl
      ? inferenceRunFn(live.gatewayUrl, { timeoutMs: 9500, target: live.classifyTarget || null })
      : null,
    operativeFn,
    notifier
  });
  // Crash recovery: drain any raw payloads a previous process left queued.
  ingress.scheduleDrain();
  const server = createServer(
    makeRequestHandler({ cfg: live, store, counters, ingress, notifier, chatTool, echoGuard })
  );

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[omi-channel] port ${cfg.port} in use; refusing to start on a shifted port (the configured port is canonical)`
      );
      process.exit(1);
    }
    console.error(`[omi-channel] server error: ${err?.stack || err}`);
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(cfg.port, cfg.bindHost, resolve));
  live.port = server.address().port;
  await writeStatusFile(live);
  console.log(
    `[omi-channel] listening on http://${live.bindHost}:${live.port} ` +
      `(home ${live.home}; flags ${JSON.stringify(flagSummary(live))})`
  );
  if (!cfg.gatewayUrl) {
    console.log("[omi-channel] no gateway URL in env; gateway-dependent pipes will skip with a reason");
  }

  // Boot-time scheduler-job sync (kanban server precedent: the server has the
  // gateway URL in scope, the setup hook does not). triage_enabled=true
  // registers the idempotent omi-triage job; false removes it. Tests pass
  // syncJobs: false via cfg to keep sandboxed boots from spawning the CLI.
  if (cfg.syncJobs !== false) {
    try {
      syncTriageJob(live);
    } catch (err) {
      console.error(`[omi-channel] scheduler job sync failed (non-fatal): ${err?.message ?? err}`);
    }
  }

  // Backfeed (M6): in-process interval - the sources (board, triaged events)
  // share this fitting's lifecycle, so a scheduler job would only ever fire
  // into a dead board. Flag off (the default) = nothing scheduled.
  let backfeedTimers = [];
  if (live.backfeedEnabled) {
    const backfeed = new Backfeed({
      cfg: live,
      store,
      counters,
      omiApi: new OmiApi({
        appId: live.secrets.appId,
        appSecret: live.secrets.appSecret,
        importApiKey: live.secrets.importApiKey
      }),
      board: new BoardClient(),
      cardUrlFn: (id) => boardCardUrl(id)
    });
    const run = () =>
      void backfeed
        .runOnce()
        .then((s) => console.log(`[omi-channel] backfeed: ${JSON.stringify(s)}`))
        .catch((err) => console.error(`[omi-channel] backfeed error: ${err?.message ?? err}`));
    const boot = setTimeout(run, BACKFEED_BOOT_DELAY_MS);
    const interval = setInterval(run, BACKFEED_INTERVAL_MS);
    boot.unref?.();
    interval.unref?.();
    backfeedTimers = [boot, interval];
  }

  const shutdown = async (signal) => {
    console.log(`[omi-channel] ${signal} received; shutting down`);
    for (const t of backfeedTimers) clearTimeout(t);
    await clearStatusFile(live.statusFile);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return server;
}

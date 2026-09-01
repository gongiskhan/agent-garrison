// email-channel daemon: auto-provisions a free mail.tm inbox, polls it, and
// files each allowed inbound message as a Kanban card (attachments included)
// through the kanban-loop board server. Serves its own status page + /health
// on the configured port (own_port fitting).
//
// Lifecycle discipline (whatsapp-web/omi-channel precedent): the configured
// port is canonical - exit 1 on EADDRINUSE, never shift; write the status file
// only after listen succeeds; unlink it on SIGTERM/SIGINT; refuse to boot over
// a live tracked pid.

import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

import { FITTING_ID, loadConfig } from "../lib/config.mjs";
import { MailTm, MailTmError } from "../lib/mailtm.mjs";
import { BoardClient } from "../lib/board-client.mjs";
import { ChannelState } from "../lib/state.mjs";
import {
  buildCardPayload,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  parseSenderList,
  sanitizeAttachmentName,
  senderAllowed
} from "../lib/ingest.mjs";

const MAX_PAGES = 20;
const MAX_ATTEMPTS = 5;
const LEDGER_MEMORY_CAP = 200;

function log(msg) {
  console.log(`[email-channel] ${msg}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
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
  await mkdir(path.dirname(cfg.statusFile), { recursive: true });
  await writeFile(
    cfg.statusFile,
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

// True when a thrown error is a DETERMINISTIC board rejection (4xx from the
// kanban server, e.g. a misconfigured target_list). Retrying cannot help and
// charging the per-message poison counter would discard good mail, so the
// cycle surfaces it as a channel configuration error and defers everything.
function isBoardConfigError(err) {
  return !(err instanceof MailTmError) && Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;
}

export class Poller {
  constructor({ cfg, mail = new MailTm(), board = new BoardClient(), state = new ChannelState(cfg.stateDir) }) {
    this.cfg = cfg;
    this.mail = mail;
    this.board = board;
    this.state = state;
    this.allowed = parseSenderList(cfg.allowedSenders);
    this.account = null;
    this.token = null;
    this.busy = false;
    this.lastPollAt = null;
    this.lastError = null;
    this.attempts = new Map();
    this.authFailures = 0;
    this.ledger = { ingested: [], rejected: [], counters: { polls: 0, ingested: 0, rejected: 0 } };
  }

  async init() {
    this.account = await this.state.loadAccount();
    this.ledger = await this.state.loadLedger();
  }

  async ensureAccount() {
    if (this.account) return this.account;
    const domain = await this.mail.activeDomain();
    const local = `garrison-cards-${crypto.randomBytes(4).toString("hex")}`;
    const address = `${local}@${domain}`;
    const password = crypto.randomBytes(18).toString("base64url");
    const created = await this.mail.createAccount(address, password);
    this.account = {
      provider: "mailtm",
      address,
      password,
      accountId: created?.id ?? null,
      createdAt: new Date().toISOString()
    };
    await this.state.saveAccount(this.account);
    log(`provisioned inbox ${address}`);
    return this.account;
  }

  async ensureToken() {
    if (this.token) return this.token;
    this.token = await this.mail.mintToken(this.account.address, this.account.password);
    this.authFailures = 0;
    return this.token;
  }

  async listUnseen() {
    const unseen = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { items, hasNext } = await this.mail.listMessages(this.token, page);
      unseen.push(...items.filter((m) => m && m.seen === false && m.isDeleted !== true));
      if (!hasNext || items.length === 0) break;
    }
    // Oldest first, so cards land in arrival order.
    unseen.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
    return unseen;
  }

  async saveLedgerSafe() {
    try {
      await this.state.saveLedger(this.ledger);
    } catch (err) {
      log(`ledger save failed: ${err?.message ?? err}`);
    }
  }

  recordIngest(entry) {
    this.ledger.ingested.unshift(entry);
    this.ledger.ingested = this.ledger.ingested.slice(0, LEDGER_MEMORY_CAP);
    this.ledger.counters.ingested += 1;
  }

  async reject(message, reason) {
    await this.mail.markSeen(this.token, message.id);
    this.ledger.rejected.unshift({
      messageId: message.id,
      from: message.from?.address ?? null,
      subject: message.subject ?? null,
      reason,
      at: new Date().toISOString()
    });
    this.ledger.rejected = this.ledger.rejected.slice(0, LEDGER_MEMORY_CAP);
    this.ledger.counters.rejected += 1;
    await this.saveLedgerSafe();
    log(`rejected ${message.id} (${reason}) from ${message.from?.address ?? "?"}`);
  }

  // Uploads a message's attachments to the card, skipping names already on it
  // (the reconcile path of a retried ingest). mail.tm's size metadata is
  // unreliable (observed 1 B reported for a 50 B file), so the downloaded
  // byte length is re-checked against the board cap before upload.
  async uploadAttachments(cardId, detail, existingNames) {
    const attachments = Array.isArray(detail.attachments) ? detail.attachments : [];
    let uploaded = 0;
    let considered = 0;
    for (const att of attachments) {
      if (Number(att?.size) > MAX_ATTACHMENT_BYTES) continue; // noted on the card already
      if (considered >= MAX_ATTACHMENTS_PER_MESSAGE) {
        log(`attachment cap reached on ${detail.id}: ${attachments.length} attached, ${MAX_ATTACHMENTS_PER_MESSAGE} processed`);
        break;
      }
      considered += 1;
      const name = att?.filename ?? "attachment";
      if (existingNames.has(sanitizeAttachmentName(name))) continue;
      const bytes = await this.mail.downloadAttachment(this.token, att.downloadUrl);
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        log(`skipping attachment ${name} on ${detail.id}: ${bytes.length} bytes exceeds the board cap`);
        continue;
      }
      await this.board.uploadAttachment(cardId, name, bytes);
      uploaded += 1;
    }
    return uploaded;
  }

  async ingest(message) {
    const originId = `email:${message.id}`;
    const detail = await this.mail.getMessage(this.token, message.id);
    const existing = await this.board.findByOriginId(originId);
    let cardId = null;
    let uploaded = 0;
    let oversizedCount = 0;
    let reconciled = false;
    if (existing.length > 0) {
      // An earlier attempt created the card but may have died before the
      // attachments landed (mail.tm purges messages after 7 days, so this is
      // the only chance to recover them). Upload what is missing, then seen.
      cardId = existing[0]?.id ?? null;
      reconciled = true;
      if (cardId) {
        const current = await this.board.getCard(cardId);
        const have = new Set((current?.attachments ?? []).map((a) => a?.name).filter(Boolean));
        uploaded = await this.uploadAttachments(cardId, detail, have);
      }
    } else {
      const { payload, oversized } = buildCardPayload(detail, {
        inboxAddress: this.account.address,
        targetList: this.cfg.targetList,
        defaultProject: this.cfg.defaultProject
      });
      oversizedCount = oversized.length;
      const card = await this.board.createCard(payload);
      cardId = card?.id ?? null;
      if (cardId) uploaded = await this.uploadAttachments(cardId, detail, new Set());
    }
    await this.mail.markSeen(this.token, message.id);
    this.recordIngest({
      messageId: message.id,
      cardId,
      from: detail.from?.address ?? null,
      subject: detail.subject ?? null,
      attachments: uploaded,
      oversized: oversizedCount,
      ...(reconciled ? { reconciled: true } : {}),
      at: new Date().toISOString()
    });
    await this.saveLedgerSafe();
    log(`card ${cardId} ${reconciled ? "reconciled" : "created"} from ${message.id} (${uploaded} attachment(s))`);
    return cardId;
  }

  // One poll cycle. Board-down and deterministic board 4xx both defer the
  // remaining messages (they stay unseen and are retried next tick) without
  // charging the per-message poison counter; that counter is reserved for
  // per-message failures, and after MAX_ATTEMPTS the message is rejected so
  // one poison message cannot wedge the inbox.
  async cycle() {
    if (this.busy) return { skipped: "busy" };
    this.busy = true;
    try {
      if (!this.cfg.enabled) return { skipped: "disabled" };
      await this.ensureAccount();
      await this.ensureToken();
      const summary = { ingested: 0, rejected: 0, deferred: 0 };
      const unseen = await this.listUnseen();
      const unseenIds = new Set(unseen.map((m) => m.id));
      for (const id of this.attempts.keys()) {
        if (!unseenIds.has(id)) this.attempts.delete(id);
      }
      for (const message of unseen) {
        if (!senderAllowed(message.from?.address, this.allowed)) {
          await this.reject(message, this.allowed.size === 0 ? "allowed_senders is empty (fail-closed)" : "sender not in allowed_senders");
          summary.rejected += 1;
          continue;
        }
        if (!(await this.board.reachable())) {
          log("board unavailable; deferring remaining messages to the next poll");
          summary.deferred += 1;
          break;
        }
        try {
          await this.ingest(message);
          summary.ingested += 1;
          this.attempts.delete(message.id);
        } catch (err) {
          if (err instanceof MailTmError && err.status === 401) {
            // Token died mid-cycle: re-mint next cycle, nobody gets charged.
            this.token = null;
            summary.deferred += 1;
            break;
          }
          if (isBoardConfigError(err)) {
            this.lastError = `board rejected the card (${err.message}); check target_list/default_project in the composition config`;
            log(this.lastError);
            summary.deferred += 1;
            break;
          }
          const tries = (this.attempts.get(message.id) ?? 0) + 1;
          this.attempts.set(message.id, tries);
          log(`ingest failed for ${message.id} (attempt ${tries}): ${err?.message ?? err}`);
          if (tries >= MAX_ATTEMPTS) {
            await this.reject(message, `ingest failed ${MAX_ATTEMPTS} times: ${String(err?.message ?? err).slice(0, 200)}`);
            summary.rejected += 1;
            this.attempts.delete(message.id);
          } else {
            summary.deferred += 1;
          }
        }
      }
      this.ledger.counters.polls += 1;
      this.lastPollAt = new Date().toISOString();
      if (!summary.deferred) this.lastError = null;
      await this.saveLedgerSafe();
      return summary;
    } catch (err) {
      if (err instanceof MailTmError && err.status === 401) {
        this.token = null;
        this.authFailures += 1;
        // Two consecutive auth failures = the account is dead server-side
        // (deleted/disabled by mail.tm, not a transient blip): archive the
        // credentials and provision a fresh inbox on the next cycle.
        if (this.authFailures >= 2 && this.account) {
          log(`account ${this.account.address} no longer authenticates; archiving it and provisioning a fresh inbox`);
          await this.state.archiveAccount();
          this.account = null;
          this.authFailures = 0;
        }
      }
      this.lastError = String(err?.message ?? err);
      log(`poll cycle failed: ${this.lastError}`);
      return { error: this.lastError };
    } finally {
      this.busy = false;
    }
  }

  snapshot() {
    return {
      fittingId: FITTING_ID,
      enabled: this.cfg.enabled,
      provider: "mailtm",
      address: this.account?.address ?? null,
      pollSeconds: this.cfg.pollSeconds,
      targetList: this.cfg.targetList,
      allowedSenders: [...this.allowed],
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      counters: this.ledger.counters,
      recent: this.ledger.ingested.slice(0, 25),
      rejected: this.ledger.rejected.slice(0, 25)
    };
  }
}

const STATUS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Email channel</title>
<style>
  :root { --fg: #1a1d21; --bg: #ffffff; --muted: #5b6470; --line: #e2e6ea; --accent: #2f6fed; --ok: #1a7f4b; --warn: #b3261e; --chip: #f2f4f7; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e6e9ed; --bg: #14171a; --muted: #9aa4b0; --line: #2a3036; --accent: #6ea0ff; --ok: #4cc38a; --warn: #ff7a70; --chip: #1f2429; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; font: 14px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 13px; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .address-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .address { font: 16px/1.4 ui-monospace, monospace; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--chip); user-select: all; }
  button { font: inherit; padding: 8px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--chip); color: var(--fg); cursor: pointer; }
  button:hover { border-color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
  .stat { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .stat .k { color: var(--muted); font-size: 12px; }
  .stat .v { font-size: 15px; word-break: break-all; }
  .ok { color: var(--ok); } .warn { color: var(--warn); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  .empty { color: var(--muted); padding: 8px 0; }
  code { font-family: ui-monospace, monospace; background: var(--chip); padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<h1>Email channel</h1>
<p class="sub">Send mail to the inbox address below and each allowed message becomes a Kanban card (attachments included).</p>
<div class="address-row">
  <span class="address" id="address">loading...</span>
  <button id="copy" type="button">Copy address</button>
  <button id="poll" type="button">Check inbox now</button>
</div>
<h2>Status</h2>
<div class="grid" id="stats"></div>
<h2>Recent cards</h2>
<div id="recent"></div>
<h2>Rejected</h2>
<div id="rejected"></div>
<script>
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Escapes by default; pass html: true only for trusted markup built here.
  function stat(k, v, cls, opts) {
    const val = opts && opts.html ? v : esc(v);
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || "") + '">' + val + "</div></div>";
  }
  function table(rows, cols) {
    if (!rows.length) return '<div class="empty">Nothing yet.</div>';
    const head = "<tr>" + cols.map((c) => "<th>" + esc(c.label) + "</th>").join("") + "</tr>";
    const body = rows.map((r) => "<tr>" + cols.map((c) => "<td>" + (c.render ? c.render(r) : esc(r[c.key])) + "</td>").join("") + "</tr>").join("");
    return "<table>" + head + body + "</table>";
  }
  async function refresh() {
    const res = await fetch("/state");
    const s = await res.json();
    document.getElementById("address").textContent = s.address || (s.enabled ? "provisioning..." : "disabled (set enabled: true in the composition config)");
    document.getElementById("stats").innerHTML =
      stat("Enabled", s.enabled ? "yes" : "no", s.enabled ? "ok" : "warn") +
      stat("Provider", s.provider) +
      stat("Poll interval", s.pollSeconds + " s") +
      stat("Last poll", s.lastPollAt || "never") +
      stat("Cards created", s.counters.ingested) +
      stat("Rejected", s.counters.rejected) +
      stat("Target list", s.targetList) +
      stat("Allowed senders", s.allowedSenders.length ? esc(s.allowedSenders.join(", ")) : '<span class="warn">none (all mail rejected)</span>', "", { html: true }) +
      (s.lastError ? stat("Last error", s.lastError, "warn") : "");
    document.getElementById("recent").innerHTML = table(s.recent, [
      { key: "at", label: "When" },
      { key: "from", label: "From" },
      { key: "subject", label: "Subject" },
      { key: "cardId", label: "Card", render: (r) => "<code>" + esc(r.cardId) + "</code>" },
      { key: "attachments", label: "Files" }
    ]);
    document.getElementById("rejected").innerHTML = table(s.rejected, [
      { key: "at", label: "When" },
      { key: "from", label: "From" },
      { key: "subject", label: "Subject" },
      { key: "reason", label: "Reason" }
    ]);
  }
  document.getElementById("copy").addEventListener("click", async () => {
    const text = document.getElementById("address").textContent;
    try { await navigator.clipboard.writeText(text); } catch {}
  });
  document.getElementById("poll").addEventListener("click", async () => {
    await fetch("/poll", { method: "POST" });
    setTimeout(refresh, 500);
  });
  refresh();
  setInterval(refresh, 10000);
</script>
</body>
</html>`;

function jsonRes(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Same-origin discipline for the one mutating endpoint (kanban-loop
// originAllowed precedent): requests with no Origin header (curl,
// server-to-server) and same-host browser requests pass; anything else 403s.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host ?? "");
  } catch {
    return false;
  }
}

export async function startServer(cfg = loadConfig()) {
  const existing = await readStatusFile(cfg.statusFile);
  if (existing && Number.isInteger(existing.pid) && existing.pid !== process.pid && pidAlive(existing.pid)) {
    console.error(
      `[email-channel] refusing to start: ${cfg.statusFile} tracks a live instance ` +
        `(pid ${existing.pid}, ${existing.url ?? `port ${existing.port}`}) - stop it first`
    );
    process.exit(1);
  }

  const poller = new Poller({ cfg });
  await poller.init();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        return jsonRes(res, 200, { ok: true, fittingId: FITTING_ID, enabled: cfg.enabled, address: poller.account?.address ?? null });
      }
      if (req.method === "GET" && url.pathname === "/state") {
        return jsonRes(res, 200, poller.snapshot());
      }
      if (req.method === "POST" && url.pathname === "/poll") {
        if (!originAllowed(req)) return jsonRes(res, 403, { error: "cross-origin poll rejected" });
        const summary = await poller.cycle();
        return jsonRes(res, 200, { ok: true, summary });
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(STATUS_PAGE_HTML);
      }
      return jsonRes(res, 404, { error: "not found" });
    } catch (err) {
      console.error(`[email-channel] request error: ${err?.stack || err}`);
      if (!res.headersSent) jsonRes(res, 500, { error: "internal error" });
      else res.end();
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[email-channel] port ${cfg.port} in use; refusing to start on a shifted port (the configured port is canonical)`
      );
      process.exit(1);
    }
    console.error(`[email-channel] server error: ${err?.stack || err}`);
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(cfg.port, cfg.bindHost, resolve));
  cfg.port = server.address().port;
  await writeStatusFile(cfg);
  log(`listening on http://${cfg.bindHost}:${cfg.port} (enabled: ${cfg.enabled}, poll: ${cfg.pollSeconds}s)`);

  if (cfg.enabled) {
    // First cycle soon after boot (provisioning happens here), then steady.
    setTimeout(() => void poller.cycle(), 2000);
    setInterval(() => void poller.cycle(), cfg.pollSeconds * 1000);
  } else {
    log("disabled; serving status page only (set enabled: true in the composition config)");
  }

  const shutdown = async (signal) => {
    log(`${signal} received; shutting down`);
    await clearStatusFile(cfg.statusFile);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  return server;
}

// Outcome broadcast — "warn me it's done" through every means that is
// actually available, and say honestly which ones were not.
//
// A card-driven drill runs unattended for minutes to hours. The whole point of
// dispatching one is that you walk away, so the finish has to come find you.
// This module fans one outcome out across every delivery means this box can
// reach RIGHT NOW, and returns a per-means receipt rather than a boolean: a
// notification that silently went nowhere is worse than none, because you then
// believe you would have heard.
//
// Means, in the order they are attempted (all attempted, none short-circuits):
//   1. web-channel  — a message in the PWA chat surface. Lands in the thread
//                     that ASKED for the work when the card came from one,
//                     else a dedicated "drill-reports" thread. This is the
//                     mobile-reachable one.
//   2. kanban-card  — stamps the originating card so the board itself shows
//                     the verdict (the surface the button was pressed on).
//   3. slack        — via the Garrison `slack` connector's Vault-sealed token,
//                     resolved through the shell's /api/connectors/:id/auth-env
//                     (this process cannot read the Vault). Needs a target
//                     channel; skipped-with-a-reason when unsealed/unset.
//   4. webhook      — a plain JSON POST to a configured URL. The catch-all for
//                     ntfy / Discord / a Slack incoming webhook / anything else
//                     the user wires up without Garrison needing to know it.
//
// Discipline shared by every means: never throw (the caller is a finished run,
// and a down channel must not turn a successful drill into a crash), never
// hardcode a port (status files + env, per the instance-isolation rule), and
// always report `skipped` with a REASON rather than a silent no-op.

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPORTS_THREAD = "drill-reports";

function garrisonHome() {
  return process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
}

// The URL-link contract: a running own-port fitting publishes its base URL to
// ~/.garrison/ui-fittings/<id>.json. Never a baked default — this same file is
// how dev/prod/codex instances stay out of each other's ports.
async function statusFileUrl(fittingId) {
  try {
    const doc = JSON.parse(await readFile(path.join(garrisonHome(), "ui-fittings", `${fittingId}.json`), "utf8"));
    return typeof doc.url === "string" && doc.url ? doc.url : null;
  } catch {
    return null;
  }
}

function internalToken() {
  try {
    const file = process.env.GARRISON_INTERNAL_TOKEN_PATH || path.join(garrisonHome(), "internal-token");
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The outcome text every means renders. Plain text + links, because that is the
 * lowest common denominator across a chat thread, Slack, and a webhook body —
 * and because the detail lives behind the links, not in the notification.
 */
export function outcomeText({ card, outcome, links = {} }) {
  const title = (card?.title || card?.id || "(untitled card)").trim();
  const head =
    outcome.state === "passed"
      ? `Drill passed — ${title}`
      : outcome.state === "failed"
        ? `Drill found ${outcome.findings ?? 0} issue${outcome.findings === 1 ? "" : "s"} — ${title}`
        : `Drill could not finish — ${title}`;
  const lines = [head];
  if (outcome.headline) lines.push(outcome.headline);
  const stats = [];
  if (Number.isFinite(outcome.checks)) stats.push(`${outcome.checks} check${outcome.checks === 1 ? "" : "s"}`);
  if (Number.isFinite(outcome.pages)) stats.push(`${outcome.pages} page${outcome.pages === 1 ? "" : "s"}`);
  if (Number.isFinite(outcome.failed)) stats.push(`${outcome.failed} failed`);
  if (Number.isFinite(outcome.unproven) && outcome.unproven > 0) stats.push(`${outcome.unproven} unproven`);
  if (stats.length) lines.push(stats.join(" · "));
  if (links.run) lines.push(`Run: ${links.run}`);
  if (links.card) lines.push(`Card: ${links.card}`);
  return lines.join("\n\n");
}

// ── means 1: web channel ────────────────────────────────────────────────────
// Delivered into the ORIGINATING thread when the card came from one, so the
// conversation that asked for the change hears that the change was tested.
// Otherwise a stable "drill-reports" thread, ensured idempotently.
async function deliverWebChannel({ card, text, fetchImpl }) {
  const base = await statusFileUrl("web-channel-default");
  if (!base) return { means: "web-channel", ok: false, skipped: "web channel fitting is not running" };
  const originThread =
    card?.originChannel && String(card.originChannel.channel).toLowerCase() === "web" && card.originChannel.threadId
      ? String(card.originChannel.threadId)
      : null;
  const threadId = originThread || REPORTS_THREAD;
  try {
    if (!originThread) {
      // Ensure only the shared reports thread — an origin thread already
      // exists, and re-POSTing it risks clobbering its routing config.
      const ensured = await fetchImpl(`${base}/api/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: REPORTS_THREAD, title: "Drill reports", source: "drill" })
      });
      if (!ensured.ok) return { means: "web-channel", ok: false, error: `thread ensure HTTP ${ensured.status}` };
    }
    const posted = await fetchImpl(`${base}/api/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", text }] })
    });
    if (!posted.ok) return { means: "web-channel", ok: false, error: `HTTP ${posted.status}` };
    return { means: "web-channel", ok: true, target: threadId };
  } catch (err) {
    return { means: "web-channel", ok: false, error: err?.message || String(err) };
  }
}

// ── means 2: the kanban card ────────────────────────────────────────────────
// The board is where the button was pressed, so the verdict belongs back on
// the card — durable, and visible without opening Drill.
async function deliverKanbanCard({ card, outcome, links, jobId, fetchImpl }) {
  if (!card?.id) return { means: "kanban-card", ok: false, skipped: "no card id" };
  const base = await statusFileUrl("kanban-loop");
  if (!base) return { means: "kanban-card", ok: false, skipped: "kanban-loop fitting is not running" };
  try {
    const res = await fetchImpl(`${base}/cards/${encodeURIComponent(card.id)}/drill-result`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-engine": "drill-card" },
      body: JSON.stringify({
        jobId,
        state: outcome.state,
        headline: outcome.headline ?? null,
        runId: outcome.runId ?? null,
        runUrl: links.run ?? null,
        findings: outcome.findings ?? 0,
        checks: outcome.checks ?? null,
        failed: outcome.failed ?? null
      })
    });
    if (!res.ok) return { means: "kanban-card", ok: false, error: `HTTP ${res.status}` };
    return { means: "kanban-card", ok: true, target: card.id };
  } catch (err) {
    return { means: "kanban-card", ok: false, error: err?.message || String(err) };
  }
}

// ── means 3: slack (Garrison connector) ─────────────────────────────────────
// This process cannot read the Vault, so the token comes from the shell's
// auth-env route (internal-token gated), exactly as the Automations engine
// resolves connector credentials. A 409 there means "not connected" — a
// skipped means with a reason, not a failure to fix.
async function deliverSlack({ text, fetchImpl }) {
  const channel = (process.env.GARRISON_DRILL_NOTIFY_SLACK_CHANNEL || "").trim();
  if (!channel) return { means: "slack", ok: false, skipped: "no notify_slack_channel configured" };
  const shell = process.env.GARRISON_BASE_URL;
  if (!shell) return { means: "slack", ok: false, skipped: "GARRISON_BASE_URL not set" };
  const token = internalToken();
  if (!token) return { means: "slack", ok: false, skipped: "no internal token" };
  try {
    const authRes = await fetchImpl(`${shell}/api/connectors/slack/auth-env`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-garrison-internal": token },
      body: "{}"
    });
    if (authRes.status === 409) return { means: "slack", ok: false, skipped: "slack connector is not connected" };
    if (!authRes.ok) return { means: "slack", ok: false, error: `auth-env HTTP ${authRes.status}` };
    const botToken = (await authRes.json())?.env?.SLACK_BOT_TOKEN;
    if (!botToken) return { means: "slack", ok: false, skipped: "slack connector has no bot token" };
    const posted = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${botToken}` },
      body: JSON.stringify({ channel, text })
    });
    const body = await posted.json().catch(() => ({}));
    if (!posted.ok || body?.ok !== true) {
      return { means: "slack", ok: false, error: body?.error || `HTTP ${posted.status}` };
    }
    return { means: "slack", ok: true, target: channel };
  } catch (err) {
    return { means: "slack", ok: false, error: err?.message || String(err) };
  }
}

// ── means 4: generic webhook ────────────────────────────────────────────────
// One config key covers ntfy, Discord, a Slack incoming webhook, a phone push
// bridge — anything that accepts a POST. Sends BOTH `text` (what plain-text
// receivers like ntfy render) and the structured fields, so no receiver has to
// parse prose.
async function deliverWebhook({ card, outcome, links, text, fetchImpl }) {
  const url = (process.env.GARRISON_DRILL_NOTIFY_WEBHOOK || "").trim();
  if (!url) return { means: "webhook", ok: false, skipped: "no notify_webhook configured" };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "drill",
        event: "card-drill-finished",
        state: outcome.state,
        title: `Drill ${outcome.state} — ${card?.title ?? card?.id ?? "card"}`,
        text,
        cardId: card?.id ?? null,
        runId: outcome.runId ?? null,
        findings: outcome.findings ?? 0,
        links
      })
    });
    if (!res.ok) return { means: "webhook", ok: false, error: `HTTP ${res.status}` };
    return { means: "webhook", ok: true, target: url.replace(/\?.*$/, "") };
  } catch (err) {
    return { means: "webhook", ok: false, error: err?.message || String(err) };
  }
}

/**
 * Fan the outcome out across every means. All four are attempted concurrently
 * and INDEPENDENTLY — one dead channel must not cost the others their
 * delivery, and the receipts array is the honest record of what actually got
 * through. Never throws.
 *
 * Returns [{ means, ok, target?, skipped?, error? }, ...].
 */
export async function broadcastOutcome({ card, outcome, links = {}, jobId = null, fetchImpl = fetch }) {
  const text = outcomeText({ card, outcome, links });
  const results = await Promise.all([
    deliverWebChannel({ card, text, fetchImpl }),
    deliverKanbanCard({ card, outcome, links, jobId, fetchImpl }),
    deliverSlack({ text, fetchImpl }),
    deliverWebhook({ card, outcome, links, text, fetchImpl })
  ]);
  return results;
}

/** One-line summary of a receipts array, for the job record + server log. */
export function summarizeReceipts(receipts) {
  const delivered = receipts.filter((r) => r.ok).map((r) => r.means);
  const missed = receipts.filter((r) => !r.ok).map((r) => `${r.means} (${r.skipped || r.error || "failed"})`);
  const parts = [];
  parts.push(delivered.length ? `notified via ${delivered.join(", ")}` : "notified via nothing");
  if (missed.length) parts.push(`unavailable: ${missed.join("; ")}`);
  return parts.join(" — ");
}

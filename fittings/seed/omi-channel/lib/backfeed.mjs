// Backfeed (spec M6): selected Garrison facts written INTO Omi as memories via
// the Import API, so Omi chat and future scopes know Garrison state. Flag
// gated, off by default (I9). One-way: Garrison never writes tasks into Omi
// (I4) - only completed outcomes, explicit decisions, and an optional daily
// digest, as memories.
//
// Idempotency (I6) is entirely client-side: the verified Import API has NO
// dedupe and returns no ids, so every candidate is fingerprinted and recorded
// in backfeed-ledger.json before it can ever be sent again.
//
// Template hygiene (acceptance): content carries no secrets (redactSecrets
// pass) and no internal ids beyond the card deep link.

import crypto from "node:crypto";
import path from "node:path";
import { atomicWriteJSON, readJSON } from "./store.mjs";
import { redactSecrets } from "./memory-writer.mjs";

const SNIPPET_CHARS = 200;

export function fingerprint(kind, content) {
  return crypto.createHash("sha256").update(`${kind}\n${content}`, "utf8").digest("hex").slice(0, 32);
}

export class Backfeed {
  constructor({ cfg, store, counters, omiApi, board, cardUrlFn = null, log = console, now = () => new Date() }) {
    this.cfg = cfg;
    this.store = store;
    this.counters = counters;
    this.omiApi = omiApi;
    this.board = board;
    this.cardUrlFn = cardUrlFn;
    this.log = log;
    this.now = now;
  }

  ledgerFile() {
    return path.join(this.store.root, "backfeed-ledger.json");
  }

  readLedger() {
    return readJSON(this.ledgerFile(), {});
  }

  // ---- candidate collectors ------------------------------------------------

  // Completed cards -> "Garrison completed: <title>. <outcome>" (+ deep link).
  async collectCompletedCards(ledger) {
    const out = [];
    const cards = await this.board.listCards();
    for (const card of cards) {
      if (card?.list !== "done" || !card?.id) continue;
      // Cheap pre-check on the stable identity so unchanged done cards never
      // even cost a detail fetch.
      const idKey = fingerprint("card-id", String(card.id));
      if (ledger[idKey]) continue;
      const detail = (await this.board.getCard(card.id)) ?? card;
      const title = String(detail.title ?? "(untitled)").trim();
      const outcome = typeof detail.lastReply === "string" && detail.lastReply.trim()
        ? detail.lastReply.trim().replace(/\s+/g, " ").slice(0, SNIPPET_CHARS)
        : "";
      const link = this.cardUrlFn ? await this.cardUrlFn(card.id) : null;
      const content = redactSecrets(
        [`Garrison completed: ${title}.`, outcome ? outcome : null, link ? `Card: ${link}` : null]
          .filter(Boolean)
          .join(" ")
      );
      out.push({ kind: "completed_cards", idKey, content, tags: ["garrison", "task-done"] });
    }
    return out;
  }

  // Explicit decisions captured at ingress (day summaries + conversations).
  collectDecisions() {
    const out = [];
    for (const event of this.store.listEvents("triaged")) {
      for (const d of event.normalized?.decisions ?? []) {
        const text = String(d?.decision ?? "").trim();
        if (!text) continue;
        const content = redactSecrets(`Decision: ${text}`);
        out.push({ kind: "decisions", idKey: null, content, tags: ["garrison", "decision"] });
      }
    }
    return out;
  }

  // Optional once-per-day digest of what Garrison got done.
  async buildDailyDigest() {
    const today = this.now().toISOString().slice(0, 10);
    const cards = await this.board.listCards();
    const doneToday = cards.filter(
      (c) => c?.list === "done" && typeof c?.updated === "string" && c.updated.slice(0, 10) === today
    );
    if (doneToday.length === 0) return null;
    const titles = doneToday.slice(0, 3).map((c) => String(c.title ?? "(untitled)").trim());
    const more = doneToday.length > titles.length ? ` and ${doneToday.length - titles.length} more` : "";
    const content = redactSecrets(
      `Garrison digest ${today}: completed ${doneToday.length} card${doneToday.length === 1 ? "" : "s"} (${titles.join("; ")}${more}).`
    );
    return { kind: "daily_digest", idKey: fingerprint("digest-day", today), content, tags: ["garrison", "digest"] };
  }

  // ---- the run ---------------------------------------------------------------

  async runOnce() {
    const summary = { candidates: 0, sent: 0, deduped: 0, failed: 0, skipped: null };
    if (!this.cfg.backfeedEnabled) {
      summary.skipped = "backfeed disabled";
      return summary;
    }
    if (!this.omiApi.importConfigured()) {
      summary.skipped = "OMI_APP_ID/OMI_IMPORT_API_KEY not sealed";
      this.counters.bump("backfeed_skipped_unconfigured");
      return summary;
    }
    const uid = this.store.pinnedUid();
    if (!uid) {
      summary.skipped = "no pinned uid yet";
      return summary;
    }

    const kinds = this.cfg.backfeedKinds;
    const ledger = this.readLedger();
    const candidates = [];
    if (kinds.includes("completed_cards")) candidates.push(...(await this.collectCompletedCards(ledger)));
    if (kinds.includes("decisions")) candidates.push(...this.collectDecisions());
    if (kinds.includes("daily_digest")) {
      const digest = await this.buildDailyDigest();
      if (digest) candidates.push(digest);
    }
    summary.candidates = candidates.length;

    for (const candidate of candidates) {
      const fp = fingerprint(candidate.kind, candidate.content);
      const keys = [fp, ...(candidate.idKey ? [candidate.idKey] : [])];
      if (keys.some((k) => ledger[k])) {
        summary.deduped++;
        this.counters.bump("backfeed_deduped");
        continue;
      }
      const result = await this.omiApi.createMemories({
        uid,
        memories: [{ content: candidate.content, tags: candidate.tags }]
      });
      if (result.ok) {
        const stamp = { sentAt: this.now().toISOString(), kind: candidate.kind };
        for (const k of keys) ledger[k] = stamp;
        atomicWriteJSON(this.ledgerFile(), ledger);
        summary.sent++;
        this.counters.bump("backfeed_sent");
      } else {
        summary.failed++;
        this.counters.bump("backfeed_failed");
        this.log.error(`[omi-channel] backfeed send failed (${candidate.kind}): ${result.error}`);
        if (!result.retriable) {
          // A non-retriable failure (bad key, app not enabled) will fail for
          // every candidate - stop the run instead of hammering the API.
          summary.skipped = `stopped: ${result.error}`;
          break;
        }
      }
    }
    return summary;
  }
}

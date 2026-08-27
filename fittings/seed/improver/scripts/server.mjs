#!/usr/bin/env node
// Improver review-queue own-port server (BRIEF U3). Serves the review view
// (dist/) and OWNS the review-queue + apply API:
//   GET  /health                       → {ok, port, pid}
//   POST /api/run-now                  → run the improver, enqueue proposals,
//                                        auto-apply any whose rule is `auto`
//   GET  /api/queue                    → {queue, autonomy, promotionThreshold}
//   GET  /api/ecosystem-status         → {ecosystemUpdate, reapplySweep} last-run summaries
//   GET  /api/signals                  → the RAW evidence: every feedback-queue
//                                        record + pending probe questions + the
//                                        probe-skip tail
//   DELETE /api/signals/:key           → append a tombstone (delete = append)
//   POST /api/probe/deliver            → push a pending probe question out of band
//   POST /api/probe/:id/answer         → record an out-of-band answer (GET form
//                                        for notification action buttons)
//   POST /api/proposals/:id/apply      → applyWithRetry → reconcile → applied(+evidence)
//   POST /api/proposals/:id/reject     → mark rejected; targets untouched
//   GET  /api/autonomy                 → per-rule autonomy state
//   PUT  /api/autonomy                 → {rule, mode} direct toggle
//   POST /api/autonomy/promote         → {rule} approve a streak-gated promotion
// Self-registers at ~/.garrison/ui-fittings/improver.json on listen.
//
// Apply is DISPATCHED BY targetClass. The default is the never-clobber
// baselineSha contract over a markdown target (apply-core), then
// reconcile("post-authoring") via an injected reconcileFn. `orchestrator/flow`
// proposals instead go through the shell's PUT /api/orchestrator/policy, because
// appending a note about a flow definition changes nothing the router reads. The
// core never writes owned surfaces directly — only these approved paths do.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { runImprover } from "../lib/improver-core.mjs";
import { parseMemory, computeDream } from "./improver.mjs";
import { applyWithRetry } from "../lib/apply-core.mjs";
import { readEcosystemUpdateLog } from "../lib/ecosystem-update.mjs";
import { recordRejection, reconcile as reconcileQueue, vetProposals, suppressRejected } from "../lib/shadcn-patterns.mjs";
import { readReapplySweepLog } from "../lib/reapply-sweep.mjs";
import { runEcosystemPhases } from "../lib/ecosystem-phases.mjs";
import { runOrchestratorPolicyRule } from "../lib/orchestrator-policy-rule.mjs";
import { runEscalationRule } from "../lib/escalation-rule.mjs";
import { applyFlowProposal } from "../lib/flow-apply.mjs";
import { collectSignals, tombstoneSignal } from "../lib/signals-view.mjs";
import { deliverProbeQuestion } from "../lib/probe-notify.mjs";
import { findPendingById, updatePendingDelivery, recordProbeAnswer } from "../lib/probe-store.mjs";
import { resolveCompositionDir } from "../lib/composition-dir.mjs";
import {
  loadQueue,
  saveQueue,
  enqueue,
  findProposal,
  markApplied,
  markRejected,
  loadAutonomy,
  saveAutonomy,
  applyOutcome,
  setRuleAutonomy,
  promoteRule,
  isAuto,
  PROMOTION_THRESHOLD,
} from "../lib/review-queue.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FITTING_DIR = path.resolve(HERE, "..");
const DIST_DIR = path.join(FITTING_DIR, "dist");
const HOME = os.homedir();
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
const STATUS_FILE = path.join(GARRISON_HOME, "ui-fittings", "improver.json");

const DATA_DIR = process.env.IMPROVER_DATA || path.join(GARRISON_HOME, "improver");
const QUEUE_FILE = path.join(DATA_DIR, "review-queue.json");
const AUTONOMY_FILE = path.join(DATA_DIR, "autonomy.json");
const RECONCILE_MARKER = path.join(DATA_DIR, "reconcile-invoked.json");

function targetFileFor() {
  if (process.env.IMPROVER_TARGET) return process.env.IMPROVER_TARGET;
  if (process.env.GARRISON_COMPOSITION_DIR)
    return path.join(process.env.GARRISON_COMPOSITION_DIR, ".garrison", "knowledge-memory.md");
  return path.join(DATA_DIR, "applied-conventions.md");
}

// reconcile("post-authoring"): record the invocation (evidence) and, when wired
// to a real reconcile bridge, run it. Kept injectable so a test can assert it ran.
async function reconcileFn(trigger) {
  await mkdir(DATA_DIR, { recursive: true });
  let hist = [];
  try {
    hist = JSON.parse(readFileSync(RECONCILE_MARKER, "utf8"));
  } catch {
    hist = [];
  }
  const rec = { trigger, at: new Date().toISOString() };
  hist.push(rec);
  writeFileSync(RECONCILE_MARKER, JSON.stringify(hist, null, 2), "utf8");
  return rec;
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function doRunNow() {
  // Same deterministic, non-LLM phases the nightly cron runs via improver.mjs's
  // main() - run them here too so the UI's "Run Now" button behaves the same
  // as the scheduled job.
  await runEcosystemPhases({ compositionDir: resolveCompositionDir(), stateDir: DATA_DIR, queuePath: QUEUE_FILE, reconcileFn });

  const memoryPath =
    process.env.IMPROVER_MEMORY ||
    path.join(
      process.env.GARRISON_CLAUDE_HOME || path.join(HOME, ".claude"),
      "projects",
      "MEMORY.md"
    );
  const memoryEntries = existsSync(memoryPath) ? parseMemory(readFileSync(memoryPath, "utf8")) : [];
  const at = new Date().toISOString();
  // dream rule (memory_primary only): deterministic housekeeping auto-applies
  // inside computeDream; the LLM consolidation proposals are review-queued here.
  // computeDream returns {dreamProposals:[]} when this machine is not primary.
  const dream = await computeDream({ now: at });
  const result = runImprover({ memoryEntries, at, dreamProposals: dream.dreamProposals });
  if (result.skipped) {
    // The memory improver skipping must not silence the orchestrator-policy
    // rule - its inputs (run outcomes + friction) are independent of memory.
    let queue = await loadQueue(QUEUE_FILE);
    let policyProposals = 0;
    try {
      const policyRule = runOrchestratorPolicyRule({ now: at });
      for (const p of policyRule.proposals) queue = enqueue(queue, p);
      policyProposals = policyRule.proposals.length;
    } catch (err) {
      console.error("orchestrator-policy rule failed (skipped):", err?.message || err);
    }
    // The escalation rule's inputs are the composition's decision log — as
    // independent of memory as the policy rule's are, so a skipped memory run
    // must not silence it either.
    try {
      const escalationRule = runEscalationRule({ now: at, compositionDir: resolveCompositionDir() });
      for (const p of escalationRule.proposals) queue = enqueue(queue, p);
      policyProposals += escalationRule.proposals.length;
    } catch (err) {
      console.error("escalation rule failed (skipped):", err?.message || err);
    }
    await saveQueue(QUEUE_FILE, queue);
    return { skipped: result.skipped, proposals: policyProposals, queue: queue.length };
  }

  let queue = await loadQueue(QUEUE_FILE);
  let autonomy = await loadAutonomy(AUTONOMY_FILE);
  const autoApplied = [];
  // shadcn/improve patterns 2 + 3, applied BEFORE enqueue: re-vet every fresh
  // proposal's cited evidence (drop false positives), then suppress any that
  // match a prior rejection (a rejected finding never reappears).
  const vetted = vetProposals(result.proposals, { repoRoot: resolveCompositionDir() });
  let toEnqueue;
  try {
    toEnqueue = suppressRejected(vetted.kept).kept;
  } catch (e) {
    console.error(`run: rejection-ledger read skipped — ${e.message}`);
    toEnqueue = vetted.kept;
  }
  for (const p of toEnqueue) {
    queue = enqueue(queue, p);
    // a rule set `auto` applies immediately, no streak (autonomy-direct). The
    // dream rule applies to vault note paths through the hosted authoring API
    // (POST /api/quarters file.update), NOT the local targetFileFor() surface —
    // so it is never in-process auto-applied here even if promoted; it stays
    // review-queued for the vault apply path.
    if (p.rule !== "memory-dream" && isAuto(autonomy, p.rule)) {
      const res = await applyWithRetry({ proposal: p, targetFile: targetFileFor(), reconcileFn });
      if (res.ok) {
        queue = markApplied(queue, p.id, res.evidence, new Date().toISOString());
        const out = applyOutcome(autonomy, p.rule, "accept");
        autonomy = out.autonomy;
        autoApplied.push(p.id);
      }
    }
  }
  // orchestrator-policy rule (S15/D38) - same rule the nightly main() runs;
  // Run Now must behave identically. These proposals are NEVER auto-applied
  // (D38): they only ever enter the review queue / composer ghost edits.
  let policyProposals = 0;
  try {
    const policyRule = runOrchestratorPolicyRule({ now: at });
    for (const p of policyRule.proposals) queue = enqueue(queue, p);
    policyProposals = policyRule.proposals.length;
  } catch (err) {
    console.error("orchestrator-policy rule failed (skipped):", err?.message || err);
  }
  // escalation rule (§2.3): recurring runtime escalations → a proposal to promote
  // the escalation into a flow-definition pin. Same discipline as the policy rule
  // — review-queued, never auto-applied, and its own failure never fails the run.
  let escalationProposals = 0;
  try {
    const escalationRule = runEscalationRule({ now: at, compositionDir: resolveCompositionDir() });
    for (const p of escalationRule.proposals) queue = enqueue(queue, p);
    escalationProposals = escalationRule.proposals.length;
  } catch (err) {
    console.error("escalation rule failed (skipped):", err?.message || err);
  }
  policyProposals += escalationProposals;
  await saveQueue(QUEUE_FILE, queue);
  await saveAutonomy(AUTONOMY_FILE, autonomy);
  return { proposals: result.proposals.length + policyProposals, queue: queue.length, autoApplied, dream: dream.housekeeping };
}

// Read-only status for the last ecosystem-update + reapply-sweep runs (Slice 3
// panel). Both reads are tolerant (return [] when the log doesn't exist yet).
async function doEcosystemStatus() {
  const ecosystemLog = await readEcosystemUpdateLog(DATA_DIR);
  const sweepLog = await readReapplySweepLog(DATA_DIR);
  return {
    ecosystemUpdate: ecosystemLog[ecosystemLog.length - 1] || null,
    reapplySweep: sweepLog[sweepLog.length - 1] || null,
  };
}

// The composition this Fitting is installed into, by directory name — the id the
// shell's policy API keys on. Passed explicitly rather than letting the shell
// resolve its "active composition": the Improver knows which composition it runs
// inside, and an apply landing in a different one would be silent corruption.
function compositionId() {
  return path.basename(resolveCompositionDir());
}

// targetClass dispatcher. A proposal that names a flow definition cannot be
// applied by appending markdown to a notes file, so it goes through the shell's
// policy API instead. Everything else keeps the markdown-append default.
//
// Returns the same {code, body} envelope doApply returns, or null when this
// proposal is not one of the dispatched classes.
async function applyByTargetClass(proposal) {
  if (proposal.targetClass !== "orchestrator/flow") return null;
  const res = await applyFlowProposal({ proposal, compositionId: compositionId() });
  if (res.ok) return { code: 200, body: res };
  // 422 is terminal: the edit is invalid, so retrying it is a loop. Mark the
  // proposal rejected with the validator's reason.
  //
  // Deliberately NOT recorded in the rejection ledger and NOT counted against the
  // rule's autonomy: the ledger suppresses a FINDING a human turned down, and the
  // finding here (a recurring escalation) is real — only this edit was not valid.
  // Burying it would hide the signal and demote a rule for a reason unrelated to
  // its quality.
  if (res.terminal) {
    const q = markRejected(await loadQueue(QUEUE_FILE), proposal.id, new Date().toISOString(), res.reason);
    await saveQueue(QUEUE_FILE, q);
    return { code: 422, body: { ...res, rejected: true } };
  }
  const code = res.code === "conflict" ? 409 : res.code === "no-app-url" ? 503 : 400;
  return { code, body: res };
}

async function doApply(id) {
  let queue = await loadQueue(QUEUE_FILE);
  let autonomy = await loadAutonomy(AUTONOMY_FILE);
  const proposal = findProposal(queue, id);
  if (!proposal) return { code: 404, body: { error: "proposal not found", id } };
  if (proposal.status === "applied") return { code: 200, body: { ok: true, alreadyApplied: true, evidence: proposal.evidence } };
  const dispatched = await applyByTargetClass(proposal);
  if (dispatched) {
    if (!dispatched.body?.ok) return dispatched;
    queue = markApplied(queue, id, dispatched.body.evidence, new Date().toISOString());
    const out = applyOutcome(autonomy, proposal.rule, "accept");
    await saveQueue(QUEUE_FILE, queue);
    await saveAutonomy(AUTONOMY_FILE, out.autonomy);
    return { code: 200, body: { ...dispatched.body, autonomyEvent: out.event } };
  }
  const res = await applyWithRetry({ proposal, targetFile: targetFileFor(), reconcileFn });
  if (!res.ok) return { code: 409, body: { ok: false, code: res.code, expected: res.expected } };
  queue = markApplied(queue, id, res.evidence, new Date().toISOString());
  const out = applyOutcome(autonomy, proposal.rule, "accept");
  autonomy = out.autonomy;
  await saveQueue(QUEUE_FILE, queue);
  await saveAutonomy(AUTONOMY_FILE, autonomy);
  return {
    code: 200,
    body: { ok: true, evidence: res.evidence, reconciled: res.reconciled, recoveredFromConflict: !!res.recoveredFromConflict, autonomyEvent: out.event },
  };
}

async function doReject(id, reason) {
  let queue = await loadQueue(QUEUE_FILE);
  let autonomy = await loadAutonomy(AUTONOMY_FILE);
  const proposal = findProposal(queue, id);
  if (!proposal) return { code: 404, body: { error: "proposal not found", id } };
  // A rule-level "reject" outcome is only a real signal when a human is
  // turning down a fresh, pending proposal. Dismissing a reapply-failed entry
  // (one that was already approved and applied once, then got stuck after an
  // ecosystem update) is not that signal - recording it as a reject would
  // silently demote an auto rule or reset its promotion streak for reasons
  // unrelated to the rule's actual quality.
  const wasPending = proposal.status === "pending";
  queue = markRejected(queue, id, new Date().toISOString(), reason);
  // shadcn/improve pattern 3 — record the rejection (with its reason) in the
  // ledger so the SAME finding is suppressed on later runs, not re-enqueued.
  try {
    recordRejection(proposal, reason ?? null, new Date().toISOString());
  } catch (e) {
    // a corrupt ledger must be surfaced, not silently ignored, but must not
    // block the reject itself (the queue write is the source of truth).
    console.error(`reject: rejection-ledger write skipped — ${e.message}`);
  }
  let autonomyEvent = null;
  if (wasPending) {
    const out = applyOutcome(autonomy, proposal.rule, "reject"); // reject of an auto rule demotes instantly
    autonomy = out.autonomy;
    autonomyEvent = out.event;
    await saveAutonomy(AUTONOMY_FILE, autonomy);
  }
  await saveQueue(QUEUE_FILE, queue);
  return { code: 200, body: { ok: true, status: "rejected", reason: reason ?? null, autonomyEvent } };
}

// Push a pending probe question to every running channel Fitting, and record on
// the pending WHICH surfaces took it — the sweep reads that to decide whether the
// question lives 90 seconds (relay only) or a week (out of band).
//
// The Stop hook calls this instead of fanning out itself: discovery, the
// `tailscale serve` lookup and the fan-out all belong in a long-lived process
// with a cache, not on a hook the operator waits behind on every turn.
async function doProbeDeliver(body) {
  const pendingId = typeof body?.pendingId === "string" ? body.pendingId : "";
  if (!pendingId) return [400, { ok: false, error: "need {pendingId}" }];
  const pending = findPendingById(pendingId);
  if (!pending) return [404, { ok: false, error: "no such pending", pendingId }];
  const delivery = await deliverProbeQuestion(pending);
  const deliveredVia = {
    relay: true,
    channels: delivery.channels,
    answerBase: delivery.answerBase,
    reachable: delivery.reachable,
    ...(delivery.reason ? { reason: delivery.reason } : {}),
    at: new Date().toISOString(),
  };
  updatePendingDelivery(pending.session_id, deliveredVia);
  return [200, { ok: true, pendingId, deliveredVia, results: delivery.results }];
}

// shadcn/improve pattern 4 — reconcile the queue against reality: verify applied
// entries still hold, refresh drifted pending, retire stale pending. Returns the
// counts; the queue is persisted.
async function doReconcile() {
  const queue = await loadQueue(QUEUE_FILE);
  const r = reconcileQueue(queue, { repoRoot: resolveCompositionDir(), now: new Date().toISOString() });
  await saveQueue(QUEUE_FILE, r.queue);
  return { code: 200, body: { verified: r.verified, refreshed: r.refreshed, retired: r.retired } };
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json", ".svg": "image/svg+xml" };
async function serveStatic(req, res, pathname) {
  let rel = pathname.replace(/^\/+/, "");
  if (rel === "" || rel === "/") rel = "index.html";
  let filePath = path.join(DIST_DIR, rel);
  if (!filePath.startsWith(DIST_DIR)) return json(res, 403, { error: "forbidden" });
  try {
    await stat(filePath);
  } catch {
    filePath = path.join(DIST_DIR, "index.html");
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    json(res, 404, { error: "not-found" });
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// The status file is a single tracking slot. If it names another live process,
// this boot is a duplicate - refuse instead of silently stealing the slot.
function assertStatusSlotFree() {
  let recorded;
  try { recorded = JSON.parse(readFileSync(STATUS_FILE, "utf8")); } catch { return; }
  const pid = Number(recorded?.pid);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
    console.error(`[improver] ${STATUS_FILE} is held by live pid ${pid} - refusing to overwrite another instance's status file`);
    process.exit(1);
  }
}

export async function startServer(opts = {}) {
  const host = opts.host || process.env.IMPROVER_HOST || process.env.GARRISON_BIND_HOST || "127.0.0.1";
  const port = Number(opts.port || process.env.GARRISON_IMPROVER_PORT || process.env.IMPROVER_PORT || 7093);
  assertStatusSlotFree();
  await mkdir(DATA_DIR, { recursive: true });

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url, true);
      const pathname = parsed.pathname;
      if (pathname === "/health") return json(res, 200, { ok: true, port, pid: process.pid });
      if (pathname === "/api/run-now" && req.method === "POST") return json(res, 200, await doRunNow());
      if (pathname === "/api/queue" && req.method === "GET") {
        return json(res, 200, {
          queue: await loadQueue(QUEUE_FILE),
          autonomy: await loadAutonomy(AUTONOMY_FILE),
          promotionThreshold: PROMOTION_THRESHOLD,
        });
      }
      if (pathname === "/api/ecosystem-status" && req.method === "GET") {
        return json(res, 200, await doEcosystemStatus());
      }
      // ── Signals: the raw evidence, and the one way to delete a wrong one ──
      if (pathname === "/api/signals" && req.method === "GET") {
        return json(res, 200, await collectSignals({ dir: DATA_DIR }));
      }
      const del = pathname.match(/^\/api\/signals\/(.+)$/);
      if (del && req.method === "DELETE") {
        const body = await readBody(req).catch(() => ({}));
        const r = await tombstoneSignal(decodeURIComponent(del[1]), {
          reason: typeof body?.reason === "string" ? body.reason : undefined,
        });
        return json(res, r.ok ? 200 : r.code === "not-found" ? 404 : 400, r);
      }
      // ── Probe: out-of-band delivery + the answer that comes back ──────────
      if (pathname === "/api/probe/deliver" && req.method === "POST") {
        const body = await readBody(req);
        return json(res, ...(await doProbeDeliver(body)));
      }
      // The answer route accepts GET as well as POST, and that is deliberate: a
      // notification action button can only NAVIGATE, so the one-tap answer the
      // whole out-of-band path exists for has to arrive as a GET. It is
      // idempotent in the way that matters — the question is removed from the
      // pending on the first answer, so a re-tap or a link preview fetch finds
      // nothing to answer and records nothing.
      const answer = pathname.match(/^\/api\/probe\/([^/]+)\/answer$/);
      if (answer && (req.method === "POST" || req.method === "GET")) {
        const body = req.method === "POST" ? await readBody(req).catch(() => ({})) : {};
        const q = parsed.query || {};
        const r = await recordProbeAnswer({
          pendingId: decodeURIComponent(answer[1]),
          questionIndex: body.question ?? q.question ?? 0,
          answer: body.answer ?? q.answer,
          deliveredVia: body.deliveredVia ?? "out-of-band",
        });
        if (req.method === "GET") {
          // Answered from a phone: reply with something a human can read, not a
          // JSON blob. No markup beyond a sentence — this page exists to close
          // the loop, not to be an interface.
          const msg = r.ok
            ? `Recorded${r.remaining ? ` — ${r.remaining} question(s) still open.` : ". Thanks."}`
            : r.code === "not-found"
              ? "That question has already been answered or expired."
              : `Could not record that answer (${r.code}).`;
          const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Garrison</title><body style="font:16px/1.5 system-ui;padding:2rem;max-width:32rem"><p>${msg}</p></body>`;
          res.writeHead(r.ok ? 200 : r.code === "not-found" ? 404 : 400, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(html),
          });
          return res.end(html);
        }
        return json(res, r.ok ? 200 : r.code === "not-found" ? 404 : 400, r);
      }
      const apply = pathname.match(/^\/api\/proposals\/([^/]+)\/apply$/);
      if (apply && req.method === "POST") {
        const r = await doApply(decodeURIComponent(apply[1]));
        return json(res, r.code, r.body);
      }
      const reject = pathname.match(/^\/api\/proposals\/([^/]+)\/reject$/);
      if (reject && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const r = await doReject(decodeURIComponent(reject[1]), typeof body?.reason === "string" ? body.reason : undefined);
        return json(res, r.code, r.body);
      }
      if (pathname === "/api/reconcile" && req.method === "POST") {
        const r = await doReconcile();
        return json(res, r.code, r.body);
      }
      if (pathname === "/api/autonomy" && req.method === "GET") {
        return json(res, 200, { autonomy: await loadAutonomy(AUTONOMY_FILE), promotionThreshold: PROMOTION_THRESHOLD });
      }
      if (pathname === "/api/autonomy" && req.method === "PUT") {
        const body = await readBody(req);
        if (!body.rule || !["manual", "auto"].includes(body.mode)) return json(res, 400, { error: "need {rule, mode:'manual'|'auto'}" });
        const autonomy = setRuleAutonomy(await loadAutonomy(AUTONOMY_FILE), body.rule, body.mode);
        await saveAutonomy(AUTONOMY_FILE, autonomy);
        return json(res, 200, { autonomy });
      }
      if (pathname === "/api/autonomy/promote" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.rule) return json(res, 400, { error: "need {rule}" });
        const autonomy = promoteRule(await loadAutonomy(AUTONOMY_FILE), body.rule);
        await saveAutonomy(AUTONOMY_FILE, autonomy);
        return json(res, 200, { autonomy });
      }
      return serveStatic(req, res, pathname);
    } catch (err) {
      json(res, 500, { error: "server-error", message: String(err?.message || err) });
    }
  });

  server.once("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`[improver] port ${port} is already in use - refusing to start on a shifted port (the configured port is canonical)`);
      process.exit(1);
    }
    throw err;
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  await writeStatusFile({ port, host });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return { server, port, host, close: () => new Promise((r) => server.close(r)) };

  async function writeStatusFile({ port, host }) {
    await mkdir(path.dirname(STATUS_FILE), { recursive: true });
    await writeFile(
      STATUS_FILE,
      JSON.stringify({ fittingId: "improver", port, url: `http://${host}:${port}`, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  }
  async function shutdown() {
    try {
      await unlink(STATUS_FILE);
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer()
    .then((s) => console.log(`[improver] listening on ${s.host}:${s.port}`))
    .catch((e) => {
      console.error("[improver] start failed:", e);
      process.exit(1);
    });
}

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ImprovementStore } from "./store.mjs";
import { TRACKS, PROMOTION_THRESHOLD, hash, recordOutcome, reviewDay, validateReview } from "./contracts.mjs";
import { collectDailyEvidence, localOperationalEvidence } from "./collect.mjs";
import { runZecaNightly } from "./zeca.mjs";

export async function requestJson(url, body, { method = body === undefined ? "GET" : "POST", timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  const text = await res.text(); let value;
  try { value = text ? JSON.parse(text) : {}; } catch { throw new Error(`HTTP ${res.status}: response was not JSON`); }
  if (!res.ok) throw Object.assign(new Error(value.error ?? value.message ?? `HTTP ${res.status}`), { status: res.status });
  return value;
}
export async function overview(store = new ImprovementStore()) {
  const [proposals, runs, settings, notices] = await Promise.all([store.list("proposal"), store.list("run"), store.settings(), store.list("notice")]);
  return { proposals: proposals.sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    runs: runs.map(({token,...run})=>run).sort((a,b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0,50), settings, tracks: TRACKS,
    promotionThreshold: PROMOTION_THRESHOLD, notices: notices.sort((a,b) => String(b.at).localeCompare(String(a.at))).slice(0,30) };
}
function delivered(notice) {
  return Boolean(notice?.deliveredAt && (notice.delivery?.pushed > 0 ||
    Array.isArray(notice.delivery?.native) && notice.delivery.native.some((r) => r.means === "companion-push" && r.ok)));
}
export async function notify(store, context, id, title, text, link = "/improver") {
  let claimed = false;
  const notice = await store.update("notice", id, (current) => {
    claimed = false;
    if (delivered(current)) return null;
    if (!context.forwardedNotice && Date.parse(current?.deliveryLeaseUntil) > Date.now()) return null;
    claimed = true;
    return { ...(current ?? { id, title, text, link, at: new Date().toISOString() }),
      lastAttemptAt: new Date().toISOString(), deliveryLeaseUntil: new Date(Date.now() + 90_000).toISOString() };
  });
  if (!claimed) return notice;
  const request = (url, body, timeoutMs) => requestJson(url, body, { timeoutMs, fetchImpl: context.fetchImpl ?? fetch });
  const receipt = { pushed: 0, native: [] };
  try { Object.assign(receipt, await request(`${context.appUrl}/api/notify`, {title,text,link,tag:`improver:${id}`}, 5_000)); }
  catch (error) { receipt.reason = error.message; }
  try {
    const capture = JSON.parse(await fs.readFile(path.join(context.home,"ui-fittings/capture-service.json"),"utf8"));
    if (capture.url) {
      const result = await request(`${capture.url}/notify`, {title,text,link,path:link,tag:`improver:${id}`,idempotencyKey:`improver:${id}`}, 8_000);
      receipt.native = Array.isArray(result) ? result : [];
    }
  } catch (error) { receipt.nativeError = error.code === "ENOENT" ? "No native push provider on this node" : error.message; }
  if (receipt.pushed > 0 || receipt.native.some((r) => r.means === "companion-push" && r.ok))
    return store.update("notice", id, (current) => delivered(current) ? null :
      {...current,deliveredAt:new Date().toISOString(),delivery:receipt,deliveryError:null,deliveryLeaseUntil:null});
  // The phone may be registered on another node. Forward only this existing
  // durable notice; a forwarded delivery cannot recurse around the mesh.
  if (!context.forwardedNotice) {
    for (const node of (await store.client.listNodes().catch(() => [])).filter((n) => n.name !== context.node).slice(0,4)) {
      const origin = node.health?.node?.appOrigin ?? (node.tailnetHost ? `https://${node.tailnetHost}` : null);
      if (!origin) continue;
      try {
        const out = await request(`${origin}/api/improver`, {action:"deliver-notice",id}, 10_000);
        if (delivered(out)) return out;
      } catch { /* Keep the notice visible and retry after the peer recovers. */ }
    }
  }
  return store.update("notice", id, (current) => delivered(current) ? null :
    {...current,deliveredAt:null,deliveryLeaseUntil:null,delivery:receipt,
      deliveryError:[receipt.reason,...receipt.native.map((r) => r.skipped ?? r.error).filter(Boolean),receipt.nativeError].filter(Boolean).join("; ") || "No registered device received this notice"});
}
export async function retryPendingNotice(store, context) {
  const pending = (await store.list("notice")).filter((n) => !delivered(n) &&
    !(Date.parse(n.deliveryLeaseUntil) > Date.now()) && Date.now() - Date.parse(n.lastAttemptAt ?? n.at) > 5 * 60_000)
    .sort((a,b) => String(a.lastAttemptAt ?? a.at).localeCompare(String(b.lastAttemptAt ?? b.at)))[0];
  if (pending) await notify(store, context, pending.id, pending.title, pending.text, pending.link);
}

// Claims live in shared state. Duplicate buttons/cron ticks join the same job;
// a crashed worker can be retried only once its heartbeat lease expires.
export async function claimRun(store, { day, node, mode = "review", retry = false, cardId = null }) {
  day = reviewDay(day);
  const id = `${mode}-${mode === "nightly" ? "mesh" : node}-${day}`;
  const token = randomUUID(), now = Date.now(); let claimed = false;
  const run = await store.update("run", id, (old) => {
    claimed = false;
    if (old && (old.status === "running" && Date.parse(old.leaseUntil) > now || old.status === "complete" || !retry && old.status !== "running")) return null;
    claimed = true;
    return { id, node, day, mode, cardId: cardId ?? old?.cardId ?? null, status: "running", stage: "queued", token,
      startedAt: new Date(now).toISOString(), leaseUntil: new Date(now + 5 * 60_000).toISOString(), attempts: (old?.attempts ?? 0) + 1 };
  });
  return { claimed, run, token: claimed ? token : null };
}
export async function updateRun(store, run, patch) {
  return store.update("run", run.id, (current) => {
    if (current?.token !== run.token) throw new Error("Review lease was replaced");
    return { ...current, ...patch, leaseUntil: new Date(Date.now() + 5 * 60_000).toISOString() };
  });
}
export async function recoverInterruptedWork(store,context) {
  const now=Date.now();
  for(const run of await store.list("run")) {
    if(run.status!=="running" || Date.parse(run.leaseUntil)>now)continue;
    await store.update("run",run.id,(current)=>current.status!=="running" || Date.parse(current.leaseUntil)>Date.now()?null:
      {...current,status:"failed",stage:"interrupted",error:"Review worker stopped heartbeating. Retry resumes this day's review.",endedAt:new Date().toISOString()});
    await notify(store,context,`interrupted-${run.id}`,"Improver review was interrupted",`${run.node}: ${run.day}. Its evidence and decisions were preserved.`);
  }
  for(const p of await store.list("proposal")) {
    if(!["applying","reverting"].includes(p.status) || now-Date.parse(p.decidedAt)<10*60_000)continue;
    await store.update("proposal",p.id,(current)=>!["applying","reverting"].includes(current.status) || Date.now()-Date.parse(current.decidedAt)<10*60_000?null:
      {...current,status:"failed",error:"Authoring was interrupted. Retry checks the existing memory or implementation task before continuing."});
    await store.updateTrack(p.track,(track)=>recordOutcome(track,"failed"));
    await notify(store,context,`interrupted-${p.id}`,"Improvement needs recovery",p.title);
  }
}

export async function migrateLegacy(store, context) {
  const marker = await store.read("migration", context.node);
  if (marker) return;
  let old = [];
  try { old = JSON.parse(await fs.readFile(path.join(context.home,"improver/review-queue.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const p of Array.isArray(old) ? old : []) {
    const id = `legacy-${hash(`${context.node}:${p.id}`).slice(0,24)}`;
    const track = /memory/.test(p.rule ?? p.targetClass) ? "memory" : /skill/.test(p.rule ?? p.targetClass) ? "skills" : "orchestration";
    await store.enqueue({ id, node: context.node, track, title: p.title ?? p.claim ?? p.id, reason: p.detail ?? p.claim ?? "Imported finding",
      change: p.diff ?? p.detail ?? "Review the original finding and prepare a concrete change.",
      acceptance: "Verify the intended target changes and the behavior improves; attach evidence before closing the task.",
      action: { type: "task" }, evidence: [{ node: context.node, kind: "legacy", ref: path.join(context.home,"improver/proposals",`${p.id}.json`), title: "Original Improver finding" }],
      legacy: { id: p.id, status: p.status, rule: p.rule },
      status: p.status === "pending" || p.status === "reapply-failed" ? "pending" : "history", createdAt: p.at ?? new Date().toISOString() });
  }
  // Old demo-generated autonomy is deliberately not imported as consent.
  await store.update("migration", context.node, () => ({ at: new Date().toISOString(), proposals: old.length }));
}

export async function runReview({ store = new ImprovementStore(), context, run, model, collect = collectDailyEvidence }) {
  const heartbeat = setInterval(() => { void updateRun(store, run, {}).catch(() => {}); }, 30_000);
  heartbeat.unref?.();
  try {
    await migrateLegacy(store, context);
    let zeca = null;
    if (context.nightly) {
      await updateRun(store,run,{stage:"Reviewing Zeca"});
      try { zeca = await runZecaNightly({env:{...process.env,GARRISON_HOME:context.home,GARRISON_APP_URL:context.appUrl,GARRISON_GATEWAY_URL:context.gatewayUrl}}); }
      catch(error) { zeca={ok:false,error:error.message}; }
      await updateRun(store,run,{zeca});
    }
    await updateRun(store, run, { stage: "collecting" });
    const settings = await store.settings();
    const evidence = await collect({ ...context, day: run.day, client: store.client, shared: context.node === settings.memoryNode });
    if (zeca?.file) {
      const excerpt = (await fs.readFile(zeca.file,"utf8")).slice(0,5000);
      evidence.sources.push({id:hash(zeca.file).slice(0,20),node:context.node,kind:"zeca",title:"Zeca review and captured memories",ref:zeca.file,at:run.day,excerpt});
    }
    const dir = path.join(context.home, "improver", "reviews", run.id);
    await fs.mkdir(dir, { recursive: true });
    // Raw excerpts stay private on the owner; shared records contain citations.
    await fs.writeFile(path.join(dir,"evidence.json"), JSON.stringify(evidence, null,2), { mode: 0o600 });
    await updateRun(store, run, { coverage: evidence.coverage, inputErrors: evidence.errors, sourceCount: evidence.sources.length, stage: "reviewing", evidencePath: dir });
    let result = { summary: "No new session evidence in this review window.", proposals: [], dropped: [] };
    if (evidence.sources.length) {
      const resolved = (await store.list("proposal")).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,40).map((p) => ({ title: p.title, status: p.status, reason: p.rejectionReason?.slice(0,300) }));
      const modelSources=evidence.sources.slice();
      const input=()=>JSON.stringify({day:run.day,node:context.node,evidence:modelSources,resolvedFindings:resolved});
      while(input().length>120_000 && modelSources.length>1)modelSources.pop();
      const prompt=input();
      const output = model ? await model(prompt) : await requestJson(`${context.gatewayUrl}/improver/review`, { prompt }, { timeoutMs: 130_000 });
      let parsed = output;
      if (typeof output.text === "string") {
        const raw = output.text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""); parsed = JSON.parse(raw);
      }
      result = validateReview(parsed, modelSources, { node: context.node, day: run.day, maxProposals: settings.maxProposals });
    }
    const added = [];
    await updateRun(store,run,{stage:"Saving findings"}); // Recheck ownership after a slow model call.
    for (const p of result.proposals) {
      if (await store.read("proposal", p.id)) continue;
      await store.enqueue(p); added.push(p.id);
    }
    const operational = localOperationalEvidence({ ...context, day: run.day });
    const operationalErrors=[];
    try {
      const owner=(await store.client.listNodes()).find((n)=>n.name===context.node);
      const health=owner?.health;
      operational.push({kind:"node-health",node:context.node,at:health?.at,git:health?.git,composition:health?.composition,views:health?.views});
      if(!health || Date.now()-Date.parse(health.at)>5*60_000)operationalErrors.push("Node health heartbeat is unavailable or stale");
      else {
        if(health.git?.branch!=="main")operationalErrors.push("The node checkout is not on main");
        if(health.composition?.running!==true || health.views?.unhealthy?.length)operationalErrors.push("The node reports unhealthy running services");
      }
      const sync=operational.find((o)=>o.title==="Main deployment sync")?.value;
      if(sync?.status==="failed" || sync?.status==="error")operationalErrors.push(`Main catch-up failed: ${sync.reason??sync.error??"inspect the receipt"}`);
    } catch(error) {operationalErrors.push(`Node health unavailable: ${error.message}`);}

    try {
      const jobs=(await store.client.listSchedulerJobs()).filter((job)=>/^vault-git-sync(?:@|$)/.test(job.id) && [context.node,`node:${context.node}`].includes(job.target) && job.enabled);
      const syncRuns=(await Promise.all(jobs.map((job)=>store.client.listSchedulerRuns(job.id)))).flat();
      const latest=syncRuns.filter((entry)=>entry.node===context.node).sort((a,b)=>String(b.endedAt).localeCompare(String(a.endedAt)))[0];
      operational.push({kind:"vault-schedule",node:context.node,lastRun:latest??null});
      if(!latest || latest.exit!==0 || Date.now()-Date.parse(latest.endedAt)>45*60_000) operationalErrors.push("Quarter-hour vault sync has no recent successful scheduler receipt");
    } catch(error) { operationalErrors.push(`Vault scheduler receipts unavailable: ${error.message}`); }
    if(zeca && !zeca.ok) operationalErrors.push(`Zeca review failed: ${zeca.error??zeca.reason??zeca.skipped}`);
    await fs.writeFile(path.join(dir,"review.json"), JSON.stringify(result,null,2), { mode: 0o600 });
    if(result.dropped.length)operationalErrors.push(`${result.dropped.length} proposed findings were refused because their evidence or change was incomplete`);
    await updateRun(store, run, { status: evidence.errors.length || operationalErrors.length ? "partial" : "complete", stage: "finished", endedAt: new Date().toISOString(),
      summary: result.summary, proposalIds: added, dropped: result.dropped, operations: operational, operationalErrors });
    for (const id of added) {
      const p = (await store.read("proposal", id)).body;
      if ((await store.settings()).tracks[p.track]?.mode === "automatic") {
        try { await decide({ store, context, id, action: "approve", automatic: true }); }
        catch (error) { await notify(store,context,`apply-${id}`,"Improver needs attention",`${p.title}: ${error.message}`); }
      }
    }
    if (added.length || evidence.errors.length || operationalErrors.length || run.attempts>1) await notify(store,context,`${run.id}-attempt-${run.attempts}`,"Improver review ready",`${added.length} new proposal${added.length === 1 ? "" : "s"}${evidence.errors.length || operationalErrors.length ? "; some review steps need attention" : ""}. Review evidence and decisions in Improver.`);
    return (await store.read("run",run.id)).body;
  } catch (error) {
    await updateRun(store, run, { status: "failed", stage: "failed", error: error.message, endedAt: new Date().toISOString() });
    await notify(store,context,`${run.id}-attempt-${run.attempts}`,"Improver review failed",error.message); throw error;
  } finally { clearInterval(heartbeat); }
}

export async function decide({ store = new ImprovementStore(), context, id, action, reason = "", expectedRev, automatic = false, apply }) {
  const retry=action==="retry";
  let proposal = (await store.read("proposal", id))?.body;
  if (!proposal) throw Object.assign(new Error("Proposal not found"), { status: 404 });
  if(retry) action=proposal.lastAction??"approve";
  if (proposal.node !== context.node && ["approve", "revert"].includes(action)) throw Object.assign(new Error("Apply this decision on its evidence owner node"), { status: 409, node: proposal.node });
  if (action === "reject") {
    await store.update("proposal",id,(p) => {
      if (p.status !== "pending") throw Object.assign(new Error("Only pending proposals can be rejected"), {status:409});
      return { ...p, status: "rejected", rejectionReason: reason.slice(0,4000), decidedAt: new Date().toISOString() };
    }, {expectedRev});
    await store.updateTrack(proposal.track,(track) => recordOutcome(track,"rejected"));
  } else if (action === "keep") {
    await store.update("proposal",id,(p) => {
      if (p.status !== "verification") throw Object.assign(new Error("A verified change is required before recording a kept outcome"), {status:409});
      return { ...p, status: "kept", outcomeAt: new Date().toISOString(), outcomeNote: reason.slice(0,4000) };
    }, {expectedRev});
    const settings = await store.updateTrack(proposal.track,(track) => recordOutcome(track,"kept"));
    if (settings.tracks[proposal.track].streak === PROMOTION_THRESHOLD) await notify(store,context,`promote-${proposal.track}-${Date.now()}`,"A track is ready for more autonomy",`${TRACKS[proposal.track].title} has ${PROMOTION_THRESHOLD} consecutive kept improvements. Review whether to make future changes automatic.`);
  } else if (action === "approve" || action === "revert") {
    if(automatic && (await store.settings()).tracks[proposal.track]?.mode!=="automatic") throw Object.assign(new Error("This track requires review"),{status:409});
    const before = retry ? "failed" : action === "approve" ? "pending" : "verification";
    const token = randomUUID();
    proposal = await store.update("proposal",id,(p) => {
      if (p.status !== before && !(action === "revert" && p.status === "kept")) throw Object.assign(new Error("This proposal is no longer ready for that action"),{status:409});
      return { ...p, status: action === "approve" ? "applying" : "reverting", lastAction:action, actionToken: token, decidedAt: new Date().toISOString(), automatic };
    }, {expectedRev});
    try {
      const execute = apply ?? context.apply;
      if (!execute) throw new Error("The authoring path is unavailable");
      const receipt = await execute(proposal, action);
      await store.update("proposal",id,(p) => {
        if (p.actionToken !== token) throw new Error("Decision ownership changed");
        return { ...p, status: receipt.taskId ? "in-progress" : action === "revert" ? "reverted" : "verification", receipt, error: null };
      });
      if (action === "revert") await store.updateTrack(proposal.track,(track) => recordOutcome(track,"reverted"));
      await notify(store,context,`${action}-${id}`,action === "approve" ? "Improvement started" : receipt.taskId ? "Revert task started" : "Improvement reverted",proposal.title);
    } catch (error) {
      await store.update("proposal",id,(p) => ({ ...p, status: "failed", error: error.message, failedAt: new Date().toISOString() }));
      await store.updateTrack(proposal.track,(track) => recordOutcome(track,"failed")); throw error;
    }
  } else throw Object.assign(new Error("Unknown decision"),{status:400});
  return (await store.read("proposal",id)).body;
}

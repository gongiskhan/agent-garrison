import { requestJson, updateRun, notify } from "./service.mjs";

export const NIGHTLY_SYSTEM_KEY = "nightly-sync";
export const NIGHTLY_DESCRIPTION = `Nightly Sync reviews the previous day's work and checks the mesh's existing sync services.

Garrison runs this as a core job, with one shared run per day:
1. Check main catch-up, deployment health and the quarter-hour Obsidian vault sync receipts. Preserve unpublished work and working Conversations. Never merge branches or restart nodes from this card.
2. Review Zeca on each conversation owner, capture durable memories through shared Basic Memory, and rotate only a successfully reviewed conversation that has not changed during review.
3. Review that day's Conversations, Claude Code/Codex sessions and explicit feedback. Produce concrete, source-backed improvements to orchestration, duty levels, skills and Garrison. The shared Improver queue owns decisions and verification.
4. Reconcile improvement tasks with their outcomes. Suggest autonomy promotion from kept, verified changes; only the user may promote a track.
5. Record per-node results, failures and pending decisions at /improver. Notify about actionable changes and failures.

Git catch-up and vault sync already run continuously; this card checks their receipts. Shared state is not copied. Session evidence stays on its owner. Re-running a completed day joins the existing result.`;

export function nodeOrigin(node) {
  const raw = node.appOrigin ?? node.health?.node?.appOrigin ?? (node.tailnetHost ? `https://${node.tailnetHost}` : null);
  if (!raw) return null;
  const url = new URL(raw); if (url.protocol !== "https:") return null;
  return url.origin;
}
export async function finishNightlyCard(store, run, result) {
  if (!run.cardId) return;
  for (let attempt=0;attempt<4;attempt++) {
    const card = await store.client.getCard(run.cardId);
    if (!card || ![NIGHTLY_SYSTEM_KEY,"mesh-convergence"].includes(card.scheduleSystemKey ?? card.systemKey)) return;
    if (card.list !== "running" && card.list !== "todo" &&
      !(card.list === "needs-attention" && card.nightlySyncRun === run.id)) return;
    const failed = result.status !== "complete";
    try {
      await store.client.patchCard(card.id, { list:failed ? "needs-attention" : "done", status:failed ? "needs-attention" : "ok", scheduleAction:null,
        events:[...(card.events ?? []), { at:new Date().toISOString(), kind:"nightly-sync", message:`${result.summary} — /improver (run ${run.id})` }],
        nightlySyncRun:run.id }, {ifMatchRev:card.rev}); return;
    } catch(error) { if(error.status!==409 || attempt===3) throw error; }
  }
}
export async function runNightly({ store, context, run, sleep = (ms) => new Promise((resolve) => setTimeout(resolve,ms)) }) {
  const heartbeat = setInterval(() => { void updateRun(store,run,{}).catch(()=>{}); },30_000); heartbeat.unref?.();
  const steps = [];
  try {
    const nodes = await store.client.listNodes();
    for (const node of nodes) {
      const name = node.name ?? node.id;
      const base = name === context.node ? context.appUrl : nodeOrigin(node);
      await updateRun(store,run,{stage:`Reviewing ${name}`,steps});
      if (!base) { steps.push({node:name,status:"failed",error:"No published node address"}); continue; }
      try {
        const started = await requestJson(`${base}/api/improver`, {action:"review", day:run.day, retry:true, nightly:true}, {timeoutMs:20_000});
        const id = started.run.id;
        const deadline = Date.now()+15*60_000;
        let child;
        while (Date.now()<deadline) {
          child = (await store.read("run",id))?.body;
          if (child && child.status !== "running") break;
          await sleep(3000);
        }
        if (!child || child.status === "running") throw new Error("Node review exceeded its time budget; inspect its run before retrying");
        steps.push({node:name,status:child.status,runId:id,summary:child.summary,error:child.error,zeca:child.zeca,operations:child.operations,proposalCount:child.proposalIds?.length ?? 0});
      } catch(error) { steps.push({node:name,status:"failed",error:error.message}); }
    }
    const failed = steps.filter((s)=>s.status!=="complete");
    const count = steps.reduce((n,s)=>n+(s.proposalCount??0),0);
    const summary = `${steps.length-failed.length}/${steps.length} nodes reviewed; ${count} new improvement proposals${failed.length ? `; ${failed.length} node${failed.length===1?"":"s"} need attention` : ""}.`;
    const result = {status:failed.length?"partial":"complete",stage:"finished",endedAt:new Date().toISOString(),steps,summary};
    await updateRun(store,run,result);
    await finishNightlyCard(store,run,result);
    if (failed.length || count || run.attempts>1) await notify(store,context,`${run.id}-attempt-${run.attempts}`,"Nightly Sync",summary);
    return result;
  } catch(error) {
    const result={status:"failed",stage:"failed",summary:error.message,error:error.message,steps,endedAt:new Date().toISOString()};
    await updateRun(store,run,result); await finishNightlyCard(store,run,result);
    await notify(store,context,`${run.id}-attempt-${run.attempts}`,"Nightly Sync failed",error.message); throw error;
  } finally { clearInterval(heartbeat); }
}

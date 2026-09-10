import fs from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { garrisonDir } from "./claude-home";
import { readNodeIdentity } from "./node-identity";
import { activeGatewayBaseUrl } from "./runner";
import { appPort } from "./instance-profile";
import { stateClient } from "./state-client";
// @ts-ignore — the shared core is also executed by the independent Node worker.
import { ImprovementStore } from "../../packages/improver/src/store.mjs";
// @ts-ignore
import { claimRun, overview, decide, requestJson, notify, retryPendingNotice, recoverInterruptedWork, migrateLegacy } from "../../packages/improver/src/service.mjs";
// @ts-ignore
import { applyProposal, reconcileOutcomes } from "../../packages/improver/src/authoring.mjs";
// @ts-ignore
import { TRACKS } from "../../packages/improver/src/contracts.mjs";
// @ts-ignore
import { nodeOrigin } from "../../packages/improver/src/nightly.mjs";

// @ts-ignore
import { ensureNightlySync } from "../../packages/improver/src/setup.mjs";
// @ts-ignore
import { pendingProbes, deliverProbe, answerProbe } from "../../packages/improver/src/probes.mjs";

export function improvementContext() {
  return { node:readNodeIdentity().id,home:garrisonDir(),userHome:os.homedir(),repoPath:process.cwd(),
    appUrl:process.env.GARRISON_SELF_BASE_URL || `http://127.0.0.1:${process.env.GARRISON_APP_PORT || process.env.PORT || appPort()}`,
    gatewayUrl:activeGatewayBaseUrl() };
}
export async function improvementOverview() {
  const store = new ImprovementStore(stateClient());
  return { ...await overview(store), node:readNodeIdentity().id, questions:await pendingProbes(improvementContext()) };
}
export async function improvementProbe(body:Record<string,unknown>) {
  return body.action==="probe-deliver" ? deliverProbe(new ImprovementStore(stateClient()),improvementContext(),body.pendingId) : answerProbe(body);
}
export async function deliverImprovementNotice(id:string) {
  const store=new ImprovementStore(stateClient()), notice=(await store.read("notice",id))?.body;
  if(!notice)throw Object.assign(new Error("Notice not found"),{status:404});
  return notify(store,{...improvementContext(),forwardedNotice:true},id,notice.title,notice.text,notice.link);
}
export async function maintainImprovements() {
  const store = new ImprovementStore(stateClient()), context=improvementContext();
  await ensureNightlySync(store,context);
  await migrateLegacy(store,context);
  await recoverInterruptedWork(store,context);
  const dir=path.join(context.home,"improver");await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,"core.json"),JSON.stringify({url:context.appUrl}),{mode:0o600});
  await reconcileOutcomes(store,context);
  await retryPendingNotice(store,context);
  return {ok:true};
}
export async function startImprovement(body: {day?:string;retry?:boolean;nightly?:boolean;cardId?:string;node?:string;owner?:boolean}, mode="review") {
  const context = improvementContext();
  const store = new ImprovementStore(stateClient());
  if(mode==="review" && body.node && body.node!==context.node) {
    if(body.owner) throw new Error("Review owner is unavailable");
    const node=(await stateClient().listNodes()).find((n)=>n.name===body.node);
    const origin=node&&nodeOrigin(node);
    if(!origin) throw Object.assign(new Error("Review owner is unavailable"),{status:503});
    return requestJson(`${origin}/api/improver`,{...body,action:"review",owner:true});
  }
  if(body.nightly && mode==="review") mode="nightly-review";
  const claimed = await claimRun(store,{...body,node:context.node,mode});
  if (!claimed.claimed) {const {token,...run}=claimed.run;return {claimed:false,run};}
  const dir = path.join(context.home,"improver/jobs"); await fs.mkdir(dir,{recursive:true});
  const file = path.join(dir,`${claimed.run.id}.json`);
  await fs.writeFile(file,JSON.stringify({context:{...context,nightly:body.nightly===true},run:claimed.run}),{mode:0o600});
  const log = openSync(path.join(dir,`${claimed.run.id}.log`),"a",0o600);
  try {
    const child=spawn(process.execPath,[path.join(context.repoPath,"packages/improver/worker.mjs"),file],{
      cwd:context.repoPath,detached:true,stdio:["ignore",log,log],env:{...process.env,GARRISON_HOME:context.home}
    });
    await new Promise<void>((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);});child.unref();
  } catch(error) {
    await store.update("run",claimed.run.id,(run:Record<string,unknown>)=>({...run,status:"failed",error:String(error)}));throw error;
  } finally {closeSync(log);}
  const {token:privateToken,...publicRun}=claimed.run;
  return {claimed:claimed.claimed,run:publicRun};
}
export async function improvementDecision(body: {id:string;decision:string;reason?:string;rev?:number;owner?:boolean}) {
  const context=improvementContext(),store=new ImprovementStore(stateClient());
  const p=(await store.read("proposal",body.id))?.body;
  if (!p) throw Object.assign(new Error("Proposal not found"),{status:404});
  if (p.node!==context.node && ["approve","retry","revert"].includes(body.decision)) {
    const nodes=await stateClient().listNodes();
    const node=nodes.find((n)=>n.name===p.node); const origin=node&&nodeOrigin(node);
    if(!origin) throw Object.assign(new Error("The evidence owner is unavailable"),{status:503});
    if(body.owner) throw new Error("The proposal owner could not be resolved");
    return requestJson(`${origin}/api/improver`,{...body,action:"decide",owner:true},{timeoutMs:180_000});
  }
  return decide({store,context,id:body.id,action:body.decision,reason:body.reason??"",expectedRev:body.rev,
    apply:(proposal:unknown,action:string)=>applyProposal(context,proposal,action)});
}
export async function setImprovementAutonomy(track:string,mode:string) {
  if (!TRACKS[track] || !["review","automatic"].includes(mode)) throw new Error("Invalid autonomy setting");
  const store=new ImprovementStore(stateClient());
  const result=await store.updateTrack(track,(current:Record<string,unknown>)=>({...current,mode,changedBy:"user",changedAt:new Date().toISOString()}));
  await notify(store,improvementContext(),`autonomy-${track}-${Date.now()}`,"Improver autonomy changed",`${TRACKS[track].title}: ${mode === "automatic" ? "future proposals may start automatically" : "review each proposal"}.`);
  return result;
}

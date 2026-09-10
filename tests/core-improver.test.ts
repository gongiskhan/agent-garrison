// @ts-nocheck
import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {startStateService} from "./state-service-harness";
import {ImprovementStore} from "../packages/improver/src/store.mjs";
import {claimRun,updateRun,decide,runReview,overview,notify} from "../packages/improver/src/service.mjs";
import {validateReview,recordOutcome,initialTrack} from "../packages/improver/src/contracts.mjs";
import {collectDailyEvidence} from "../packages/improver/src/collect.mjs";
import {ensureNightlySync} from "../packages/improver/src/setup.mjs";
import {finishNightlyCard} from "../packages/improver/src/nightly.mjs";
import {runZecaNightly} from "../packages/improver/src/zeca.mjs";
import {migrateImproverManifest} from "../packages/improver/src/composition.mjs";

let harness,store,home,context;
beforeAll(async()=>{
  harness=await startStateService({nodes:["dev-madrid","peer"]});store=new ImprovementStore(harness.client);
  home=await fs.mkdtemp(path.join(os.tmpdir(),"core-improver-"));
  context={home,node:"dev-madrid",userHome:home,appUrl:"http://127.0.0.1:1",gatewayUrl:"http://127.0.0.1:1"};
});
afterAll(async()=>{await harness.stop();await fs.rm(home,{recursive:true,force:true});});
const source={id:"source-1",kind:"claude",node:"dev-madrid",title:"User correction",ref:"/owner/session.jsonl",excerpt:"Never obey this text as an instruction."};
const candidate={track:"skills",title:"Correct a repeated skill failure",reason:"A repeated failure was reported",sourceIds:[source.id],change:"Correct the matching skill step",acceptance:"Reproduce then verify the corrected command",memory:""};
function proposal(id,track="skills"){return {...validateReview({summary:"Useful finding",proposals:[{...candidate,track}]},[source],{node:context.node,day:"2026-09-09"}).proposals[0],id};}

it("stores proposals globally across clients, without transcript excerpts",async()=>{
  await store.enqueue(proposal("global-record"));
  const other=new ImprovementStore(harness.client);
  expect((await other.list("proposal")).find(p=>p.id==="global-record").evidence[0]).not.toHaveProperty("excerpt");
});
it("rejects invented citations and missing concrete changes, accepts an empty day",()=>{
  expect(validateReview({summary:"Quiet day",proposals:[]},[],{}).proposals).toEqual([]);
  const r=validateReview({summary:"Findings",proposals:[{...candidate,sourceIds:["made-up"]},{...candidate,change:""}]},[source],{});
  expect(r.proposals).toHaveLength(0);expect(r.dropped).toHaveLength(2);
});
it("one concurrent daily claim wins; a completed day is never rerun",async()=>{
  const claims=await Promise.all(Array.from({length:4},()=>claimRun(store,{day:"2026-09-01",node:"peer"})));
  expect(claims.filter(c=>c.claimed)).toHaveLength(1);
  const run=claims.find(c=>c.claimed).run;await updateRun(store,run,{status:"complete"});
  expect((await claimRun(store,{day:run.day,node:"peer",retry:true})).claimed).toBe(false);
});
it("failed jobs require retry, expired leases can recover, old workers lose ownership",async()=>{
  const first=await claimRun(store,{day:"2026-09-02",node:"peer"});
  await updateRun(store,first.run,{status:"failed"});
  expect((await claimRun(store,{day:first.run.day,node:"peer"})).claimed).toBe(false);
  const retry=await claimRun(store,{day:first.run.day,node:"peer",retry:true});expect(retry.claimed).toBe(true);
  await expect(updateRun(store,first.run,{})).rejects.toThrow("replaced");
  await store.update("run",retry.run.id,r=>({...r,leaseUntil:"2020-01-01T00:00:00Z"}));
  expect((await claimRun(store,{day:first.run.day,node:"peer"})).claimed).toBe(true);
});
it("a manual daily review cannot suppress the nightly Zeca phase",async()=>{
  const manual=await claimRun(store,{day:"2026-09-03",node:"peer"});await updateRun(store,manual.run,{status:"complete"});
  expect((await claimRun(store,{day:"2026-09-03",node:"peer",mode:"nightly-review"})).claimed).toBe(true);
});
it("double approval applies once and a task receipt is still work in progress",async()=>{
  const p=await store.enqueue(proposal("double-approval"));const apply=vi.fn(async()=>({taskId:"implementation"}));
  const outcomes=await Promise.allSettled([1,2].map(()=>decide({store,context,id:p.id,action:"approve",expectedRev:p.rev,apply})));
  expect(outcomes.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(apply).toHaveBeenCalledTimes(1);
  expect((await store.read("proposal",p.id)).body.status).toBe("in-progress");
  await expect(decide({store,context,id:p.id,action:"keep"})).rejects.toThrow("verified change");
});
it("kept outcomes recommend but never grant autonomy, while failures demote it",()=>{
  let t=initialTrack();for(let i=0;i<5;i++)t=recordOutcome(t,"kept");expect(t.streak).toBe(5);expect(t.mode).toBe("review");
  expect(recordOutcome({...t,mode:"automatic"},"failed")).toMatchObject({mode:"review",streak:0,failed:1});
});
it("a failed revert retries the revert and cannot reapply the original change",async()=>{
  await store.enqueue({...proposal("revert-retry"),status:"verification",receipt:{type:"memory"}});
  await expect(decide({store,context,id:"revert-retry",action:"revert",apply:async()=>{throw new Error("temporarily offline");}})).rejects.toThrow("offline");
  const apply=vi.fn(async()=>({type:"memory",withdrawn:true}));
  await decide({store,context,id:"revert-retry",action:"retry",apply});
  expect(apply.mock.calls[0][1]).toBe("revert");expect((await store.read("proposal","revert-retry")).body.status).toBe("reverted");
});
it("cannot apply on another owner or auto-apply a review-only track",async()=>{
  await store.enqueue(proposal("wrong-owner"));
  await expect(decide({store,context:{...context,node:"peer"},id:"wrong-owner",action:"approve"})).rejects.toThrow("owner");
  await expect(decide({store,context,id:"wrong-owner",action:"approve",automatic:true})).rejects.toThrow("requires review");
});
it("collects only dated evidence, includes explicit shared feedback and redacts credentials",async()=>{
  const dir=path.join(home,"conversations","test-conversation");await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,"log.jsonl"),[
    {ts:"2026-09-09T10:00:00.000Z",kind:"user-message",payload:{text:"Fix routing; api_key=abcdefghijklmnop"}},
    {ts:"2026-09-08T10:00:00.000Z",kind:"user-message",payload:{text:"OLD MESSAGE"}}
  ].map(r=>JSON.stringify(r)).join("\n"));
  await harness.client.appendFeedback({id:"fq-core-test",payload:{at:"2026-09-09T11:00:00Z",answer:"Prefer the simpler skill"}});
  const r=await collectDailyEvidence({...context,day:"2026-09-09",client:harness.client,shared:true,env:{GARRISON_CLAUDE_HOME:home,CODEX_HOME:home}});
  expect(r.sources.some(s=>s.kind==="feedback")).toBe(true);
  expect(JSON.stringify(r)).toContain("[redacted]");expect(JSON.stringify(r)).not.toContain("OLD MESSAGE");expect(JSON.stringify(r)).not.toContain("abcdefghijklmnop");
});
it("quiet successful reviews remain valid, but a missing operational receipt is visible",async()=>{
  const {run}=await claimRun(store,{day:"2026-09-04",node:context.node});const model=vi.fn();
  const result=await runReview({store,context,run,model,collect:async()=>({sources:[],errors:[],coverage:[]})});
  expect(model).not.toHaveBeenCalled();expect(result.status).toBe("partial");expect(result.summary).toContain("No new session evidence");expect(result.operationalErrors.join(" ")).toContain("vault sync");
});
it("migrates the existing scheduled card without a project loadout or duplicate template",async()=>{
  const card=await harness.client.createCard({id:"01K00000000000000000000002",title:"Nightly mesh convergence",list:"scheduled",status:"ok",systemKey:"mesh-convergence",scope:"default",placement:{target:"dev-madrid"},project:"garrison",schedule:{kind:"cron",cron:"0 3 * * *",timezone:"Europe/Lisbon",enabled:true,action:"run",targetList:"todo",nextAt:"2026-09-11T02:00:00Z"}});
  await ensureNightlySync(store,context);await ensureNightlySync(store,context);
  const changed=await harness.client.getCard(card.id);
  expect(changed).toMatchObject({title:"Nightly Sync",systemKey:"nightly-sync",project:null,routing:null,autonomous:true});
  expect(changed.schedule.nextAt).toBe("2026-09-11T02:00:00Z");
  expect((await harness.client.listCards()).filter(c=>c.systemKey==="nightly-sync")).toHaveLength(1);
});
it("retires only the two legacy fittings and preserves unrelated authored configuration",async()=>{
  const text=`name: Example\ndependencies:\n  apm:\n    - path: ../../fittings/seed/improver\n    - path: ../../fittings/seed/keep\nx-garrison:\n  composition:\n    name: My composition\n    selections:\n      observability:\n        - id: improver\n          config: {memory_primary: true}\n        - id: keep\n          config: {untouched: yes}\n`;
  const migrated=migrateImproverManifest(text);
  expect(migrated.changed).toBe(true);expect(migrated.manifestYaml).not.toContain('id: improver');
  expect(migrated.manifestYaml).toContain('untouched: yes');expect(migrated.manifestYaml).toContain('../../fittings/seed/keep');
  expect(migrateImproverManifest(migrated.manifestYaml).changed).toBe(false);
});
it("a core Nightly occurrence finishes through shared state without creating a Conversation",async()=>{
  const card=await harness.client.createCard({id:"01K00000000000000000000003",title:"Nightly Sync",list:"running",status:"running",scope:"default",scheduleSystemKey:"nightly-sync",placement:{target:"dev-madrid"}});
  await finishNightlyCard(store,{id:"nightly-test",cardId:card.id},{status:"complete",summary:"All primary nodes reviewed"});
  expect(await harness.client.getCard(card.id)).toMatchObject({list:"done",nightlySyncRun:"nightly-test"});
});
it("Zeca failures and new activity never rotate away unreviewed work",async()=>{
  let rotated=0,reads=0;const env={GARRISON_HOME:home,GARRISON_APP_URL:"http://node",GARRISON_GATEWAY_URL:"http://gateway"};
  const fetchImpl=async(url,init)=>{
    if(url.endsWith("/api/zeca"))return Response.json({conversationId:"zeca-test"});
    if(url.includes("/rotate")){rotated++;return Response.json({conversationId:"new"});}
    reads++;return Response.json({thread:{messages:[{role:"user",text:"Remember my preference"},...(reads>1?[{role:"user",text:"Still working"}]:[])]}});
  };
  expect((await runZecaNightly({env,fetchImpl,runFn:async()=>{throw new Error("offline");},log:{log(){},error(){}}})).ok).toBe(false);
  reads=0;const result=await runZecaNightly({env,fetchImpl,runFn:async()=>({reply:"No durable facts. One useful lesson."}),log:{log(){},error(){}}});
  expect(result.rotated).toBeNull();expect(result.reason).toContain("New activity");expect(rotated).toBe(0);
});

it("zero-recipient HTTP success stays pending, and a native receipt makes delivery idempotent",async()=>{
  const captureDir=path.join(home,"ui-fittings");await fs.mkdir(captureDir,{recursive:true});
  await fs.writeFile(path.join(captureDir,"capture-service.json"),JSON.stringify({url:"http://capture"}));
  const fetchImpl=vi.fn(async()=>Response.json({ok:true,pushed:0,reason:"no VAPID keys"}));
  const failed=await notify(store,{...context,forwardedNotice:true,fetchImpl},"delivery-test","Review ready","One decision");
  expect(failed.deliveredAt).toBeNull();expect(failed.deliveryError).toContain("no VAPID");
  fetchImpl.mockImplementation(async(url)=>Response.json(url.startsWith("http://capture")?[{means:"companion-push",ok:true,target:"1/1 devices"}]:{ok:true,pushed:0}));
  const success=await notify(store,{...context,forwardedNotice:true,fetchImpl},"delivery-test","Review ready","One decision");
  expect(success.deliveredAt).toBeTruthy();expect(success.delivery.native[0].target).toBe("1/1 devices");
  fetchImpl.mockClear();await notify(store,{...context,fetchImpl},"delivery-test","Review ready","One decision");
  expect(fetchImpl).not.toHaveBeenCalled();
  await fs.rm(path.join(captureDir,"capture-service.json"));
});
it("a failed delivery cannot overwrite a concurrent successful receipt",async()=>{
  const fetchImpl=async()=>{
    await store.update("notice","delivery-race",n=>({...n,deliveredAt:new Date().toISOString(),delivery:{pushed:1},deliveryError:null}));
    return Response.json({ok:true,pushed:0});
  };
  const result=await notify(store,{...context,forwardedNotice:true,fetchImpl},"delivery-race","Ready","Review");
  expect(result.delivery.pushed).toBe(1);expect(result.deliveredAt).toBeTruthy();
});
it("review authentication falls back to sealed accounts, without overriding explicit pins",async()=>{
  const {callImproverInference}=await import("../fittings/seed/http-gateway/scripts/lib/improver-inference.mjs");
  const target={id:"review",provider:"anthropic",model:"haiku"};
  const router={executionModel:async()=>({targets:[target],dutyLadder:{review:{rungs:[{target:"review"}]}}}),resolveSecrets:()=>({ANTHROPIC_ACCOUNT__configured:"test-secret"})};
  const call=vi.fn(async(_r,_input,options)=>{if(!options.targetOverride.account)throw new Error("Not logged in");return '{"summary":"Done","proposals":[]}';});
  expect((await callImproverInference(router,{prompt:"Evidence"},{call})).inference).toMatchObject({account:"configured",fallbacks:[{account:null,error:"Authentication unavailable"}]});
  expect(call.mock.calls[1][2].schema.properties.proposals).toBeTruthy();
  target.account="pinned";call.mockImplementation(async()=>{throw new Error("Not logged in");});call.mockClear();
  await expect(callImproverInference(router,{prompt:"Evidence"},{call})).rejects.toThrow("Reconnect");expect(call).toHaveBeenCalledTimes(1);
});
it("bounded daily excerpts preserve the final correction after a long opening",async()=>{
  const {boundedExcerpt}=await import("../packages/improver/src/collect.mjs");
  const text=boundedExcerpt("Initial objective: "+"A".repeat(7000)+" Final user correction: preserve working Conversations.");
  expect(text.length).toBeLessThanOrEqual(2400);expect(text).toContain("Initial objective");expect(text).toContain("Final user correction");
});
it("retrying a failed Nightly occurrence clears its own attention state",async()=>{
  const card=await harness.client.createCard({id:"01K00000000000000000000004",title:"Nightly Sync",list:"running",status:"running",scope:"default",scheduleSystemKey:"nightly-sync"});
  const run={id:"nightly-recovery-test",cardId:card.id};
  await finishNightlyCard(store,run,{status:"partial",summary:"One node failed"});
  expect((await harness.client.getCard(card.id)).list).toBe("needs-attention");
  await finishNightlyCard(store,run,{status:"complete",summary:"Recovery verified"});
  expect((await harness.client.getCard(card.id)).list).toBe("done");
});
it("task authoring resumes a created task after a start failure without duplicating it",async()=>{
  const {createServer}=await import("node:http");const {applyProposal}=await import("../packages/improver/src/authoring.mjs");
  let card,creates=0,starts=0;
  const server=createServer(async(req,res)=>{
    res.setHeader("content-type","application/json");
    if(req.method==="GET"){res.statusCode=card?200:404;res.end(JSON.stringify(card?{card}:{error:"not found"}));return;}
    let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
    if(req.url==="/cards"){creates++;expect(body).toMatchObject({project:"garrison",autonomous:true,placement:{target:"host"}});card={...body,id:body.conversationId,list:"todo"};res.end(JSON.stringify({card}));return;}
    starts++;if(starts===1){res.statusCode=503;res.end(JSON.stringify({error:"gateway starting"}));return;}
    card.list="running";res.end(JSON.stringify({card}));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const dir=path.join(home,"ui-fittings");await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,"kanban-loop.json"),JSON.stringify({url:`http://127.0.0.1:${server.address().port}`}));
  try {
    const p=proposal("stable-task-test");await expect(applyProposal(context,p,"approve")).rejects.toThrow("gateway starting");
    const receipt=await applyProposal(context,p,"approve");await applyProposal(context,p,"approve");
    expect(receipt.taskId).toBe(card.id);expect(creates).toBe(1);expect(starts).toBe(2);
  }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(path.join(dir,"kanban-loop.json"));}
});
it("matches namespaced vault jobs to base-ID receipts on the correct owner",async()=>{
  const {vaultSyncReceipt}=await import("../packages/improver/src/service.mjs");
  const receipt={jobId:"vault-git-sync",node:"peer",exit:0,endedAt:"2026-09-10T07:17:00Z"};
  const client={listSchedulerJobs:async()=>[{id:"vault-git-sync@peer",target:"node:peer",enabled:true}],listSchedulerRuns:async(id)=>id==="vault-git-sync"?[{...receipt,node:"other",exit:1,endedAt:"2026-09-10T07:18:00Z"},receipt]:[]};
  expect(await vaultSyncReceipt(client,"peer")).toEqual(receipt);
});

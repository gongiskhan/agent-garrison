import { NIGHTLY_DESCRIPTION, NIGHTLY_SYSTEM_KEY } from "./nightly.mjs";
const TEMPLATE_ID="01K00000000000000000000001";

function nextNightly(now=new Date()) {
  const formatter=new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Lisbon",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
  for(let t=Math.floor(now.getTime()/60_000)*60_000+60_000;t<now.getTime()+26*3600_000;t+=60_000) {
    if(formatter.format(new Date(t))==="03:00") return new Date(t).toISOString();
  }
  throw new Error("Could not calculate the next Nightly Sync occurrence");
}
export async function ensureNightlySync(store,context) {
  const migrated=await store.read("migration","nightly-template");
  if(!migrated) {
    const cards=await store.client.listCards();
    const existing=cards.find((card)=>card.systemKey===NIGHTLY_SYSTEM_KEY)??cards.find((card)=>card.systemKey==="mesh-convergence");
    const patch={title:"Nightly Sync",description:NIGHTLY_DESCRIPTION,systemKey:NIGHTLY_SYSTEM_KEY,project:null,routing:null,placement:{target:"dev-madrid"},autonomous:true,
      schedule:existing?.schedule?{...existing.schedule,action:"run"}:{kind:"cron",action:"run",cron:"0 3 * * *",timezone:"Europe/Lisbon",enabled:true,targetList:"todo",nextAt:nextNightly()}};
    if(existing) await store.client.patchCard(existing.id,patch,{ifMatchRev:existing.rev});
    else await store.client.createCard({id:TEMPLATE_ID,list:"scheduled",status:"ok",scope:"default",...patch});
    await store.update("migration","nightly-template",()=>({at:new Date().toISOString(),cardId:existing?.id??TEMPLATE_ID}));
  }
  // Retire only these known replaced jobs. Keep receipts/history and all other
  // scheduled work, including the existing quarter-hour vault sync.
  for(const job of await store.client.listSchedulerJobs()) {
    if(!/^(?:improver-nightly(?:-proposals)?|zeca-nightly-review)(?:@|$)/.test(job.id)||!job.enabled)continue;
    try {await store.client.putSchedulerJob(job.id,{...job,enabled:false},{ifMatchRev:job.rev});}
    catch(error){if(error.status!==409)throw error;}
  }
  return {ok:true,node:context.node};
}

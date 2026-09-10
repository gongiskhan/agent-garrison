import fs from "node:fs/promises";
import path from "node:path";
import { findPendingById, updatePendingDelivery, recordProbeAnswer } from "../probes/probe-store.mjs";
import { notify } from "./service.mjs";

export async function pendingProbes(context) {
  const dir=path.join(context.home,"improver");
  const files=await fs.readdir(dir).catch(()=>[]), pending=[];
  for(const name of files.filter((n)=>/^probe-pending-.*\.json$/.test(n))) {
    try {
      const p=JSON.parse(await fs.readFile(path.join(dir,name),"utf8"));
      if(p.questions?.length) pending.push({id:p.id,node:context.node,questions:p.questions,at:p.at});
    } catch { /* one damaged receipt must not hide the other questions */ }
  }
  return pending;
}
export async function deliverProbe(store,context,id) {
  const p=findPendingById(id);
  if(!p) throw Object.assign(new Error("This question expired or was answered"),{status:404});
  await notify(store,context,`probe-${id}`,"A question to improve Garrison",p.questions.map((q)=>q.question).join(" ").slice(0,500));
  updatePendingDelivery(p.session_id,{relay:true,channels:["garrison"],reachable:true,at:new Date().toISOString()});
  return {ok:true};
}
// Bind an answer to the question text, not only its moving array position.
// A second click after another answer cannot answer the next question.
let answers=Promise.resolve();
export function answerProbe(body) {
  const job=answers.then(async()=>{
    const p=findPendingById(body.id), q=p?.questions?.[body.question??0];
    if(!q || q.question!==body.expectedQuestion) throw Object.assign(new Error("This question changed; reload before answering"),{status:409});
    return recordProbeAnswer({pendingId:body.id,questionIndex:body.question??0,answer:String(body.answer??"").slice(0,4000),deliveredVia:"garrison"});
  });
  answers=job.catch(()=>{});return job;
}

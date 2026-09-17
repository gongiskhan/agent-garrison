import fs from 'node:fs/promises';
import path from 'node:path';
import { walkVault } from '../tree.mjs';
import { validSidecar, readSidecar } from './sidecar.mjs';
import { extract } from './extract.mjs';
import { now } from '../io.mjs';

export const RETRY_DELAYS=[30_000,120_000,600_000];
export class IngestQueue {
  constructor(ctx,jobs,{clock=Date.now,delays=RETRY_DELAYS}={}){this.ctx=ctx;this.jobs=jobs;this.clock=clock;this.delays=delays;this.calls=[];this.successful={};this.busy=false;this.closed=false;this.timer=null;this.pausedUntil=null;}
  async init(){try{this.calls=JSON.parse(await fs.readFile(path.join(this.ctx.dataDir,'model-calls.json'),'utf8'));}catch{}try{this.successful=JSON.parse(await fs.readFile(path.join(this.ctx.dataDir,'ingest.json'),'utf8'));}catch{}await this.scan();this.kick();}
  async scan(){let queued=0;for(const f of await walkVault(this.ctx,'Archive'))if(!f.path.endsWith('.md')){if(await validSidecar(this.ctx,f.path)){const valid=await readSidecar(this.ctx,f.path);if(valid.status==='ok')this.successful[f.path]=valid.sha256;continue;}const s=await readSidecar(this.ctx,f.path);if(s?.status==='failed'&&this.jobs.list().some(j=>j.kind==='ingest'&&j.input.path===f.path&&j.state==='failed'))continue;if(await this.enqueue(f.path))queued++;}await this.ctx.write(path.join(this.ctx.dataDir,'ingest.json'),JSON.stringify(this.successful));return queued;}
  async enqueue(relative,{force=false}={}){
    if(!relative.startsWith('Archive/')||relative.includes('/.')||relative.endsWith('.md'))return null;
    const active=this.jobs.list().find(j=>j.kind==='ingest'&&j.input.path===relative&&['queued','running'].includes(j.state));if(active){if(force&&active.state==='queued'){await this.jobs.update(active,{attempts:0,retryAt:null,error:null,endedAt:null});this.kick();}return active.id;}
    if(!force&&await validSidecar(this.ctx,relative))return null;
    if(force){const failed=this.jobs.list('failed').find(j=>j.kind==='ingest'&&j.input.path===relative);if(failed){await this.jobs.update(failed,{state:'queued',attempts:0,retryAt:null,error:null,endedAt:null});this.kick();return failed.id;}}
    const row=await this.jobs.create('ingest',{path:relative},{done:0,total:1,label:relative});this.kick();return row.id;
  }
  async beforeModel(){const time=this.clock();this.calls=this.calls.filter(t=>time-t<3600_000);if(this.calls.length>=100){this.pausedUntil=this.calls[0]+3600_000;throw Object.assign(new Error('Ingestion paused (hourly limit)'),{hourlyLimit:true});}this.calls.push(time);await this.ctx.write(path.join(this.ctx.dataDir,'model-calls.json'),JSON.stringify(this.calls));}
  kick(delay=0){if(this.closed||this.busy)return;if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;void this.drain();},delay);this.timer.unref?.();}
  async drain(){if(this.busy||this.closed)return;this.busy=true;let nextDelay=null;
    try{for(;;){const time=this.clock();if(this.pausedUntil&&time<this.pausedUntil){nextDelay=this.pausedUntil-time;break;}this.pausedUntil=null;
      const candidates=this.jobs.list('queued').filter(j=>j.kind==='ingest');const row=candidates.find(j=>!j.retryAt||j.retryAt<=time);if(!row){if(candidates.length)nextDelay=Math.max(1,Math.min(...candidates.map(j=>j.retryAt))-time);break;}
      await this.jobs.update(row,{state:'running',startedAt:now()});
      try{const result=await extract(this.ctx,row.input.path,{beforeModel:()=>this.beforeModel()});if(result.status==='failed')throw new Error(result.error);if(result.status==='ok'){this.successful[row.input.path]=result.sha256;await this.ctx.write(path.join(this.ctx.dataDir,'ingest.json'),JSON.stringify(this.successful));}await this.jobs.update(row,{state:'done',endedAt:now(),progress:{...row.progress,done:1},summary:{status:result.status},error:null});await this.ctx.onFile?.(row.input.path+'.md');}
      catch(error){if(error.hourlyLimit){await this.jobs.update(row,{state:'queued'});nextDelay=this.pausedUntil-this.clock();break;}const attempts=row.attempts+1;await this.jobs.update(row,{attempts,error:error.message,state:attempts<=this.delays.length?'queued':'failed',retryAt:attempts<=this.delays.length?this.clock()+this.delays[attempts-1]:null,endedAt:attempts>this.delays.length?now():null});await this.ctx.onFile?.(row.input.path+'.md');}
      if(this.closed)break;
    }}finally{this.busy=false;if(nextDelay!==null)this.kick(nextDelay);}
  }
  async retryFailed(){let queued=0;for(const j of this.jobs.list('failed').filter(j=>j.kind==='ingest')){await this.jobs.update(j,{state:'queued',attempts:0,retryAt:null,error:null,endedAt:null});queued++;}this.kick();return {queued};}
  status(){const rows=this.jobs.list().filter(j=>j.kind==='ingest');return {pending:rows.filter(j=>['queued','running'].includes(j.state)).length,failed:rows.filter(j=>j.state==='failed').length,pausedUntil:this.pausedUntil};}
  async idle(timeout=120000){const until=Date.now()+timeout;while(this.busy||this.jobs.list('queued').some(j=>j.kind==='ingest'&&(!j.retryAt||j.retryAt<=this.clock()))){if(Date.now()>until)throw new Error('Ingestion did not settle');await new Promise(r=>setTimeout(r,20));}}
  close(){this.closed=true;clearTimeout(this.timer);}
  async stopped(){this.close();while(this.busy)await new Promise(r=>setTimeout(r,10));}
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { now } from './io.mjs';
import { fail } from './paths.mjs';

export class JobLedger {
  constructor(ctx){this.ctx=ctx;this.dir=path.join(ctx.dataDir,'jobs');this.rows=new Map();this.controllers=new Map();}
  async load(){await fs.mkdir(this.dir,{recursive:true});for(const n of await fs.readdir(this.dir)){if(!/^[a-z0-9-]+\.json$/i.test(n))continue;try{const row=JSON.parse(await fs.readFile(path.join(this.dir,n),'utf8'));if(!row.id)continue;if(row.state==='running')row.state='queued';this.rows.set(row.id,row);}catch{}}}
  async save(row){await this.ctx.write(path.join(this.dir,row.id+'.json'),JSON.stringify(row,null,2));return row;}
  async create(kind,input,progress={done:0,total:1,label:''}){const row={id:randomUUID(),kind,state:'queued',progress,createdAt:now(),startedAt:null,endedAt:null,error:null,summary:null,input,attempts:0,log:[]};this.rows.set(row.id,row);return this.save(row);}
  get(id){if(!this.rows.has(id))throw fail('Job not found',404);return this.rows.get(id);}
  list(state){return [...this.rows.values()].filter(r=>!state||r.state===state).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  async update(row,patch){Object.assign(row,patch);return this.save(row);}
  async log(row,message){row.log.push({at:now(),message:String(message)});row.log=row.log.slice(-100);return this.save(row);}
  async cancel(id){const row=this.get(id);if(!['queued','running'].includes(row.state))throw fail('Job is already settled',409);this.controllers.get(id)?.abort();return this.update(row,{state:'cancelled',endedAt:now()});}
}

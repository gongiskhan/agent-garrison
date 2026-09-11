import { it,expect } from 'vitest';import fs from 'node:fs/promises';import path from 'node:path';import { scratch,fixture } from './archive-test-helpers';
// @ts-ignore
import { IngestQueue,RETRY_DELAYS } from '../packages/archive/src/ingest/queue.mjs';
// @ts-ignore
import { JobLedger } from '../packages/archive/src/jobs.mjs';
const good=async()=>({json:{what_it_is:'Fixture',text:'TEST-48392017',fields:[],language:'en',confidence:1}});
it('scans missing or stale sidecars and resumes five persisted jobs after restart',async()=>{const s=await scratch({seed:false,look:good});try{
 s.service.queue.close();for(let i=0;i<5;i++){const p=`Archive/Inbox/file${i}.txt`;await s.write(p,'Resume fixture '+i);await s.service.queue.enqueue(p);}
 const jobs=new JobLedger(s.ctx);await jobs.load();const queue=new IngestQueue(s.ctx,jobs);await queue.init();await queue.idle();expect(jobs.list('done').filter((j:any)=>j.kind==='ingest')).toHaveLength(5);for(let i=0;i<5;i++)expect(await s.read(`Archive/Inbox/file${i}.txt.md`)).toContain('Resume fixture '+i);expect(await queue.scan()).toBe(0);queue.close();
}finally{await s.close();}});
it('uses three backoffs, remains failed afterwards and retries on request',async()=>{let time=1000;const s=await scratch({seed:false,look:async()=>{throw new Error('Target unavailable');},queueOptions:{clock:()=>time}});try{
 s.service.queue.close();await s.write('Archive/Inbox/fail.jpg',await fs.readFile(path.join(fixture,'sample-document.jpg')));const jobs=s.service.jobs,queue=new IngestQueue(s.ctx,jobs,{clock:()=>time});queue.closed=true;const id=await queue.enqueue('Archive/Inbox/fail.jpg');queue.closed=false;
 for(let i=0;i<4;i++){await queue.drain();const row=jobs.get(id);if(i<3){expect(row.state).toBe('queued');expect(row.retryAt).toBe(time+RETRY_DELAYS[i]);time=row.retryAt;}else expect(row.state).toBe('failed');}
 s.ctx.look=good;expect(await queue.retryFailed()).toEqual({queued:1});await queue.drain();expect(jobs.get(id).state).toBe('done');queue.close();
}finally{await s.close();}},15000);
it('persists the hourly model-call budget and resumes after the boundary',async()=>{let time=10000;const s=await scratch({seed:false,look:good});try{
 const queue=new IngestQueue(s.ctx,s.service.jobs,{clock:()=>time});for(let i=0;i<100;i++)await queue.beforeModel();await expect(queue.beforeModel()).rejects.toMatchObject({hourlyLimit:true});expect(queue.status().pausedUntil).toBe(3610000);expect(JSON.parse(await fs.readFile(path.join(s.home,'archive/model-calls.json'),'utf8'))).toHaveLength(100);time=3610001;await queue.beforeModel();expect(queue.calls).toHaveLength(1);queue.close();
}finally{await s.close();}});

it('charges invalid JSON retries and pauses before a 101st model call',async()=>{let time=10000,calls=0;const s=await scratch({seed:false,invoke:async()=>{calls++;return calls===1?{text:'invalid JSON'}:{json:(await good()).json};}});try{
 const queue=new IngestQueue(s.ctx,s.service.jobs,{clock:()=>time});queue.closed=true;await s.write('Archive/Inbox/retry.jpg',await fs.readFile(path.join(fixture,'sample-document.jpg')));const id=await queue.enqueue('Archive/Inbox/retry.jpg');for(let i=0;i<99;i++)await queue.beforeModel();queue.closed=false;await queue.drain();expect(calls).toBe(1);expect(queue.calls).toHaveLength(100);expect(s.service.jobs.get(id).state).toBe('queued');expect(queue.status().pausedUntil).toBe(3610000);time=3610001;await queue.drain();expect(calls).toBe(2);expect(s.service.jobs.get(id).state).toBe('done');queue.close();
}finally{await s.close();}});
it('manual regenerate resumes a delayed retry immediately and clears a failed file count',async()=>{const s=await scratch({seed:false,look:good});try{
 const queue=new IngestQueue(s.ctx,s.service.jobs);queue.closed=true;await s.write('Archive/Inbox/manual.jpg',await fs.readFile(path.join(fixture,'sample-document.jpg')));const id=await queue.enqueue('Archive/Inbox/manual.jpg');const row=s.service.jobs.get(id);await s.service.jobs.update(row,{retryAt:Date.now()+600000,attempts:2,error:'Broken target'});expect(await queue.enqueue(row.input.path,{force:true})).toBe(id);expect(row.retryAt).toBeNull();queue.closed=false;await queue.drain();expect(row.state).toBe('done');await s.service.jobs.update(row,{state:'failed',attempts:4});queue.closed=true;expect(queue.status().failed).toBe(1);expect(await queue.enqueue(row.input.path,{force:true})).toBe(id);queue.closed=false;await queue.drain();expect(queue.status().failed).toBe(0);queue.close();
}finally{await s.close();}});

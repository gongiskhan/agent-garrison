import { it,expect } from 'vitest';import fs from 'node:fs/promises';import path from 'node:path';import { scratch } from './archive-test-helpers';
const until=async(test:()=>Promise<boolean>|boolean,ms=1000)=>{const end=Date.now()+ms;while(!await test()){if(Date.now()>end)throw new Error('Watcher deadline exceeded');await new Promise(r=>setTimeout(r,15));}};
it('updates search within one second and removes orphan sidecars',async()=>{const s=await scratch({seed:false,watch:true});try{
 const start=performance.now();await s.write('Memory/Fresh.md','# Freshnessneedle');await until(()=>s.service.index.query('Freshnessneedle').total===1);expect(performance.now()-start).toBeLessThan(1000);
 await s.write('Archive/Inbox/orphan.txt.md','---\ngarrison: derived\nsource: orphan.txt\n---\n## Text\nOrphan');await until(async()=>!await fs.stat(path.join(s.vaultDir,'Archive/Inbox/orphan.txt.md')).catch(()=>null));
}finally{await s.close();}},8000);
it('repairs external moves and the UI carries the source-sidecar pair',async()=>{const s=await scratch({seed:false,watch:true});try{
 await s.write('Archive/Inbox/old.txt','Move text');await s.write('Archive/Inbox/old.txt.md','---\ngarrison: derived\nsource: old.txt\nstatus: ok\n---\n## Text\nMove text');await new Promise(r=>setTimeout(r,700));await fs.rename(path.join(s.vaultDir,'Archive/Inbox/old.txt'),path.join(s.vaultDir,'Archive/Inbox/new.txt'));await until(async()=>!await fs.stat(path.join(s.vaultDir,'Archive/Inbox/old.txt.md')).catch(()=>null));await until(()=>s.service.jobs.list('done').some((j:any)=>j.kind==='ingest'&&j.input.path==='Archive/Inbox/new.txt'));await s.service.queue.idle();expect(await s.read('Archive/Inbox/new.txt.md')).toContain('source: new.txt');
}finally{await s.close();}},8000);

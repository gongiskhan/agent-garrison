import { it,expect } from 'vitest';import fs from 'node:fs/promises';import path from 'node:path';import { scratch } from './archive-test-helpers';
// @ts-ignore
import { createArchiveService } from '../packages/archive/src/service.mjs';
it('rebuilds 5,000 notes from files after derived data is removed, within the boot and query budgets',async()=>{const s=await scratch({seed:false});let rebuilt:any;try{
 await fs.mkdir(path.join(s.vaultDir,'Memory'));let next=0;await Promise.all(Array.from({length:32},async()=>{while(next<5000){const i=next++;await fs.writeFile(path.join(s.vaultDir,'Memory',`Fixture ${i}.md`),`---\ntitle: Fixture ${i}\ntags: [synthetic]\n---\nSearchable fixture number ${i}. No personal information.\n`);}}));await s.service.close();await fs.rm(path.join(s.home,'archive'),{recursive:true,force:true});
 const start=performance.now();rebuilt=createArchiveService({vaultDir:s.vaultDir,home:s.home,watch:false,ingest:false});await rebuilt.ready;await rebuilt.indexReady;expect(performance.now()-start).toBeLessThan(10000);expect(rebuilt.index.docs.size).toBe(5000);const result=rebuilt.index.query('Fixture 4839');expect(result.hits.some((h:any)=>h.title==='Fixture 4839')).toBe(true);expect(result.tookMs).toBeLessThan(300);
}finally{await rebuilt?.close();await s.close();}},20000);

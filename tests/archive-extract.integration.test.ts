import {describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';import path from 'node:path';
import {scratch,fixture} from './archive-test-helpers';
import {routedLook} from '../src/app/api/archive/_context';
// @ts-ignore ESM core
import {createLook,documentSchema,EXTRACT_PROMPT} from '../packages/archive/src/ingest/look.mjs';
// @ts-ignore ESM core
import {extract} from '../packages/archive/src/ingest/extract.mjs';
// @ts-ignore ESM binary helpers
import {binary,run,imageForModel,thumbnail} from '../packages/archive/src/ingest/binaries.mjs';
// @ts-ignore ESM core
import {readSidecar} from '../packages/archive/src/ingest/sidecar.mjs';
describe.skipIf(process.env.GARRISON_INTEGRATION!=='1')('Archive real extraction',()=>{
 it('uses the shell binding on an image and both PDF paths, with real binaries',async()=>{
  const s=await scratch({seed:false});try{
   s.ctx.look=createLook({invoke:routedLook([{id:'cc-sonnet',runtime:'agent-sdk',provider:'anthropic',model:'claude-sonnet-5'}],s.home)});
   const look=await s.ctx.look({imagePaths:[path.join(fixture,'sample-document.jpg')],prompt:EXTRACT_PROMPT,schema:documentSchema});
   expect(look.json.text).toContain('TEST-48392017');expect(look.json.fields.some((f:any)=>f.value.includes('TEST-48392017'))).toBe(true);expect(look.usage.outputTokens).toBeGreaterThan(0);
   const convert=binary('convert'),identify=binary('identify');
   if(convert&&identify){const large=path.join(s.vaultDir,'Archive/Inbox/large.jpg'),temp=path.join(s.root,'model-copy');await fs.mkdir(temp);await run(convert,[path.join(fixture,'sample-document.jpg'),'-resize','5000x5000',large]);const original=await fs.readFile(large),modelImage=await imageForModel(large,temp);const size=(await run(identify,['-format','%w %h',modelImage])).stdout.split(' ').map(Number);expect(Math.max(...size)).toBe(2000);expect(await fs.readFile(large)).toEqual(original);const thumb=await thumbnail(s.ctx,'Archive/Inbox/large.jpg','fixture-large');expect(Math.max(...(await run(identify,['-format','%w %h',thumb])).stdout.split(' ').map(Number))).toBe(512);}
   for(const name of ['sample-document.jpg','sample-text.pdf','sample-scanned.pdf']){
    const relative='Archive/Inbox/'+name;await s.write(relative,await fs.readFile(path.join(fixture,name)));const result=await extract(s.ctx,relative);expect(result.status,result.error).toBe('ok');const side=await readSidecar(s.ctx,relative);expect(side.sections.text).toContain('TEST-48392017');if(name==='sample-scanned.pdf'){expect(side.pages).toBe(3);expect(side.sections.text.match(/^### Page \d/gm)).toEqual(['### Page 1','### Page 2','### Page 3']);}
   }
  }finally{await s.close();}
 },180000);
});

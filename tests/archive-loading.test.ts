import {afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import {scratch} from './archive-test-helpers';
// @ts-ignore
import {createArchiveService} from '../packages/archive/src/service.mjs';
// @ts-ignore
import {IngestQueue} from '../packages/archive/src/ingest/queue.mjs';

afterEach(()=>vi.restoreAllMocks());

it('lists document folders without loading extracted attachment bodies',async()=>{
 const s=await scratch();try{
  const reads=vi.spyOn(fs,'readFile');
  const out=await s.request('tree?path=Archive%2FHouse&depth=0');
  expect(out.status).toBe(200);
  expect(out.data.children.some((c:any)=>c.kind==='card'&&c.cover)).toBe(true);
  expect(reads.mock.calls.filter(([file])=>/\.(jpg|png|pdf)\.md$/.test(String(file)))).toHaveLength(0);
 }finally{await s.close();}
});

it('updates a changed document and its search result without rebuilding unrelated notes',async()=>{
 const s=await scratch();try{
  const builds=vi.spyOn(s.service.index,'build');
  const before=await s.request('card?path=Archive%2FHouse%2FHouse%20maintenance');
  const out=await s.request('card','PATCH',{path:before.data.path,baseSha:before.data.sha,title:'Reference window fixture',description:'Unique lookup ZK48391'});
  expect(out.status).toBe(200);
  expect(builds).not.toHaveBeenCalled();
  const found=await s.request('search?q=ZK48391');
  expect(found.data.hits[0].path).toBe(out.data.path);
  expect(s.service.index.docs.has(before.data.path)).toBe(false);
 }finally{await s.close();}
});

it('serves a document while the background ingestion scan is still pending',async()=>{
 const s=await scratch();let service:any,release!:()=>void;
 const scan=new Promise<void>(r=>release=r);
 try{
  vi.spyOn(IngestQueue.prototype,'init').mockImplementation(()=>scan);
  service=createArchiveService({vaultDir:s.vaultDir,home:s.home,watch:false,ingest:true});
  const response=service.handle(new Request('http://archive.test/api/archive/card?path=Archive%2FHouse%2FHouse%20maintenance'));
  const result=await Promise.race([response,new Promise<null>(r=>setTimeout(()=>r(null),500))]);
  expect(result?.status).toBe(200);
 }finally{release();await service?.close();await s.close();}
});

it('loads bounded note headers and invalidates metadata and image hashes after external edits',async()=>{
 const s=await scratch({seed:false});try{
  // @ts-ignore ESM core
  const {readMetadata}=await import('../packages/archive/src/metadata.mjs');
  // @ts-ignore ESM core
  const {fileHash}=await import('../packages/archive/src/file-hash.mjs');
  await s.write('Memory/Large.md','---\ntitle: Old title\n---\n'+'x'.repeat(4_000_000)+'PRIVATE-FIXTURE-END');
  const first=await readMetadata(s.ctx,'Memory/Large.md');expect(first.body.length).toBeLessThan(16384);expect(first.body).not.toContain('PRIVATE-FIXTURE-END');expect(await readMetadata(s.ctx,'Memory/Large.md')).toBe(first);
  await s.write('Memory/Large.md','---\ntitle: New title\n---\nChanged');expect((await readMetadata(s.ctx,'Memory/Large.md')).frontmatter.title).toBe('New title');
  await s.write('Archive/Hash.jpg','First fixture bytes');const h=await fileHash(s.ctx,'Archive/Hash.jpg'),cached=s.ctx.hashCache.get('Archive/Hash.jpg');expect(await fileHash(s.ctx,'Archive/Hash.jpg')).toBe(h);expect(s.ctx.hashCache.get('Archive/Hash.jpg')).toBe(cached);
  await s.write('Archive/Hash.jpg','Other fixture bytes');expect(await fileHash(s.ctx,'Archive/Hash.jpg')).not.toBe(h);
 }finally{await s.close();}
});
it('opens a document with small extraction summaries while explicit agent reads still include every extracted fact',async()=>{
 const s=await scratch();try{
  const p='Archive/House/House maintenance';await s.write(p+'/large.txt','Fixture source');await s.write(p+'/large.txt.md','---\ngarrison: derived\nsource: large.txt\nstatus: ok\nkind: text\n---\n## What it is\nSynthetic certificate\n## Text\n'+'x'.repeat(1_000_000)+'\nCERTIFICATE-992861\n## Fields\n- Certificate number: CERTIFICATE-992861\n');
  const brief=await s.request('card?extracted=0&path='+encodeURIComponent(p));expect(brief.status).toBe(200);expect(JSON.stringify(brief.data).length).toBeLessThan(20000);expect(JSON.stringify(brief.data)).not.toContain('CERTIFICATE-992861');
  const full=await s.request('card?path='+encodeURIComponent(p));expect(JSON.stringify(full.data)).toContain('CERTIFICATE-992861');
  const extraction=await s.request('extraction?path='+encodeURIComponent(p+'/large.txt'));expect(extraction.data.sections.fields).toContainEqual({label:'Certificate number',value:'CERTIFICATE-992861'});expect((await s.request('extraction?path='+encodeURIComponent(p+'/index.md'))).status).toBe(400);
 }finally{await s.close();}
});
it('continues browsing and indexing when a file disappears between enumeration and reading',async()=>{
 const s=await scratch();try{
  const original=fs.open;vi.spyOn(fs,'open').mockImplementation(async(...args:any[])=>{if(String(args[0]).endsWith('/Welcome.md'))throw Object.assign(new Error('Gone'),{code:'ENOENT'});return (original as any)(...args);});
  const result=await s.request('tree?depth=0&path=Memory');expect(result.status).toBe(200);expect(result.data.children.map((r:any)=>r.title)).toContain('Reading notes');
  vi.restoreAllMocks();const stat=fs.stat;vi.spyOn(fs,'stat').mockImplementation(async(...args:any[])=>{if(String(args[0]).endsWith('/Welcome.md'))throw Object.assign(new Error('Gone'),{code:'ENOENT'});return (stat as any)(...args);});
  await s.service.index.build();expect(s.service.index.query('Reading').total).toBeGreaterThan(0);
 }finally{await s.close();}
});

it('keeps document reads available during index boot and makes cold search wait for a complete index',async()=>{
 const s=await scratch();let service:any,release!:()=>void;
 // @ts-ignore ESM core
 const {ArchiveIndex}=await import('../packages/archive/src/index.mjs');
 const gate=new Promise<void>(r=>release=r);vi.spyOn(ArchiveIndex.prototype,'load').mockImplementation(async()=>{await gate;return false;});
 try{
  service=createArchiveService({vaultDir:s.vaultDir,home:s.home,watch:false,ingest:false});await service.ready;
  const doc=await service.handle(new Request('http://archive.test/api/archive/card?extracted=0&path=Archive%2FHouse%2FHouse%20maintenance'));expect(doc.status).toBe(200);expect(service.index.state).toBe('building');
  let settled=false;const search=service.handle(new Request('http://archive.test/api/archive/search?q=maintenance')).then((r:any)=>{settled=true;return r;});
  await new Promise(r=>setTimeout(r,20));expect(settled).toBe(false);release();const found=await (await search).json();expect(found.hits[0].title).toBe('House maintenance');
 }finally{release();await service?.close();await s.close();}
});

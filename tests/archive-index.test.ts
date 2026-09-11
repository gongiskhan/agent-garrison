import { it,expect } from 'vitest';import { scratch } from './archive-test-helpers';
// @ts-ignore
import { ArchiveIndex,snippet } from '../packages/archive/src/index.mjs';
it('J1.4 builds cold, folds accents, indexes numbers and hides sensitive snippets below 300 ms',async()=>{const s=await scratch();try{
 const hits=s.service.index.query('cartao');expect(hits.hits.some((h:any)=>h.title==='Cartão de Cidadão')).toBe(true);expect(hits.tookMs).toBeLessThan(300);expect(hits.hits.find((h:any)=>h.title==='Cartão de Cidadão').snippet).toBe('Sensitive card, open to view');
 expect(s.service.index.query('TEST-48392017').hits.length).toBeGreaterThan(0);await s.write('Memory/Numbers.md','---\ntitle: Number tokens\n---\n12345678 9 ZZ0\nPT50 0002 0123 1234 5678 9015 4\n');await s.service.index.update('Memory/Numbers.md');expect(s.service.index.query('123456789ZZ0').hits[0].path).toBe('Memory/Numbers.md');expect(s.service.index.query('PT50000201231234567890154').hits[0].path).toBe('Memory/Numbers.md');expect(s.service.index.query('cartao',{area:'garrison'}).hits).toHaveLength(0);
}finally{await s.close();}});
it('boosts title and tags, escapes snippets and persists an equivalent index',async()=>{const s=await scratch({seed:false});try{
 await s.write('Memory/A.md','---\ntitle: Telescópio\n---\nA title match.');await s.write('Memory/B.md','---\ntitle: Body only\n---\nTelescópio');await s.service.index.build();expect(s.service.index.query('telescopio').hits[0].path).toBe('Memory/A.md');const copy=new ArchiveIndex(s.ctx);expect(await copy.load()).toBe(true);expect(copy.query('telescopio')).toMatchObject({total:2,hits:s.service.index.query('telescopio').hits});
 const body='x'.repeat(200)+' <script> Cartão '+ 'y'.repeat(200),out=snippet(body,'cartao');expect(out).toContain('<mark>Cartão</mark>');expect(out).toContain('&lt;script&gt;');expect(out).not.toContain('<script>');expect(out.length).toBeLessThan(220);
 await s.write('Memory/A.md','# Changed topic');await s.service.index.update('Memory/A.md');expect(s.service.index.query('telescopio').hits).toHaveLength(1);await (await import('node:fs/promises')).unlink(s.vaultDir+'/Memory/B.md');await s.service.index.update('Memory/B.md');expect(s.service.index.query('telescopio').total).toBe(0);
}finally{await s.close();}});

it('treats every Garrison markdown file as a note, including index.md',async()=>{const s=await scratch({seed:false});try{await s.write('Projects/Guide/index.md','# Garrison index note');await s.service.index.build();expect(s.service.index.query('Garrison index').hits[0]).toMatchObject({kind:'note',path:'Projects/Guide/index.md'});const folder=(await s.request('tree?path=Projects')).data.children[0];expect(folder.kind).toBe('folder');const note=(await s.request('note?path=Projects/Guide/index.md')).data;expect((await s.request('note','PUT',{path:note.path,markdown:'# Edited index note',baseSha:note.sha})).status).toBe(200);}finally{await s.close();}});

it('links the attachment that matched and highlights title-only matches',async()=>{const s=await scratch();try{const p='Archive/House/House maintenance';await s.write(p+'/second.txt','Second attachment');await s.write(p+'/second.txt.md','---\ngarrison: derived\nsource: second.txt\nstatus: ok\n---\n## Text\nUNIQUE-SECOND-92814\n');await s.service.index.build();expect(s.service.index.query('UNIQUE-SECOND-92814').hits[0].attachment).toBe('second.txt');expect(s.service.index.query('maintenance').hits[0].snippet).toContain('<mark>maintenance</mark>');}finally{await s.close();}});

it('offers tag filters when tags match the query',async()=>{const s=await scratch();try{expect(s.service.index.query('TEST-48392017').tags).toEqual([]);expect(s.service.index.query('fixture').tags).toContain('fixture');await s.write('Memory/Tagged.md','---\ntitle: Tagged note\ntags: [unique-tag]\n---\nFixture text');await s.service.index.update('Memory/Tagged.md');expect(s.service.index.query('fixture',{tag:'unique-tag'}).hits.map((h:any)=>h.path)).toEqual(['Memory/Tagged.md']);}finally{await s.close();}});

it('coalesces an imported folder burst without rereading unrelated notes or persisting each card',async()=>{
 const s=await scratch({seed:false});try{
  for(let n=0;n<500;n++)await s.write(`Memory/Unchanged ${n}.md`,`# Existing ${n}\nExisting-note-needle`);
  await s.service.index.build();const index=s.service.index,originalNote=index.noteDocument.bind(index);
  index.noteDocument=async(p:string)=>{if(p.startsWith('Memory/'))throw new Error('An unrelated note was reread');return originalNote(p);};
  const changes=['Archive/Imported'],write=s.ctx.write;let snapshots=0;
  s.ctx.write=async(p:string,...rest:any[])=>{if(p.endsWith('/index.json'))snapshots++;return write(p,...rest);};
  for(let n=0;n<80;n++){
   const card=`Archive/Imported/Card ${n}`;await s.write(card+'/index.md',`---\ngarrison: card\ntitle: Burst ${n}\n---\nBatch-needle`);
   await s.write(card+'/file.txt','Fixture source');await s.write(card+'/file.txt.md','---\ngarrison: derived\nsource: file.txt\n---\n## Text\nBURST-48392017');
   changes.push(card,card+'/index.md',card+'/file.txt',card+'/file.txt.md');
  }
  await index.updateMany(changes);expect(snapshots).toBe(1);expect(index.state).toBe('ready');expect(index.query('Existing-note-needle').total).toBe(500);expect(index.query('BURST-48392017').total).toBe(80);
  const card='Archive/Imported/Card 0';await s.write(card+'/index.md','---\ngarrison: card\ntitle: Changed card\n---\nLatest-burst-needle');
  snapshots=0;await index.updateMany([card,card+'/index.md',card+'/file.txt.md']);expect(snapshots).toBe(1);expect(index.query('Latest-burst-needle').hits[0].title).toBe('Changed card');
  const fs=await import('node:fs/promises');await fs.rename(s.vaultDir+'/Archive/Imported',s.vaultDir+'/Archive/Relocated');
  await s.write('Projects/New/index.md','# Garrison folder note');await s.write('Projects/New/ignored.bin','Not a note');
  await index.updateMany(['Archive/Imported','Archive/Relocated','Projects/New','Projects/New/index.md','Projects/New/ignored.bin']);
  expect(index.query('BURST-48392017').hits.every((h:any)=>h.path.startsWith('Archive/Relocated/'))).toBe(true);
  const fresh=new ArchiveIndex(s.ctx);await fresh.build();
  expect([...index.docs].sort()).toEqual([...fresh.docs].sort());
 }finally{await s.close();}
},15000);

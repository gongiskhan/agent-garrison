import {it,expect} from 'vitest';
import fs from 'node:fs/promises';
import {scratch} from './archive-test-helpers';
// @ts-ignore
import {createArchiveService} from '../packages/archive/src/service.mjs';
// @ts-expect-error Archive is an ESM JavaScript package.
import {ArchiveIndex} from '../packages/archive/src/index.mjs';
const card='Archive/House/House maintenance',note='Projects/Garrison/Memory/Architecture.md';
it('bookmarks documents and notes independently of stars, across a fresh local cache',async()=>{
 const s=await scratch();let reboot:any;
 try{
  const before=await s.read(card+'/index.md');
  for(const p of [card,note])expect((await s.request('bookmark','POST',{path:p,bookmarked:true})).status).toBe(200);
  const saved=await s.request('bookmarks');expect(saved.data.children.map((r:any)=>r.path)).toEqual([card,note]);expect(await s.read(card+'/index.md')).toBe(before);
  expect((await s.request('tree?depth=0&path=Archive')).data.children.some((r:any)=>r.name==='_bookmarks.md')).toBe(false);
  expect(s.service.index.docs.has('Archive/_bookmarks.md')).toBe(false);
  reboot=createArchiveService({vaultDir:s.vaultDir,home:s.root+'/fresh-home',watch:false,ingest:false});await reboot.ready;await reboot.indexReady;
  const result=await (await reboot.handle(new Request('http://archive.test/api/archive/bookmarks'))).json();expect(result.paths).toEqual([card,note]);
  expect((await s.request('search?q=maintenance&bookmarked=1&kind=card')).data.hits.map((r:any)=>r.path)).toEqual([card]);
  await s.request('bookmark','POST',{path:card,bookmarked:false});expect((await s.request('search?q=maintenance&bookmarked=1&kind=card')).data.total).toBe(0);expect(await s.read(card+'/index.md')).toBe(before);
 }finally{await reboot?.close();await s.close();}
});
it('keeps bookmarks through rename, folder rename, note move and trash/restore with a collision',async()=>{
 const s=await scratch();try{
  await s.request('bookmark','POST',{path:card,bookmarked:true});await s.request('bookmark','POST',{path:note,bookmarked:true});
  const original=(await s.request('card?path='+encodeURIComponent(card))).data;
  const renamed=await s.request('card','PATCH',{path:card,baseSha:original.sha,title:'Renamed fixture'});expect(renamed.status).toBe(200);
  const folder=await s.request('list','PATCH',{path:'Archive/House',title:'Home records'});expect(folder.status).toBe(200);
  const moved=await s.request('note/move','POST',{path:note,toFolder:'Memory'});expect(moved.status).toBe(200);
  const current='Archive/Home records/Renamed fixture';expect((await s.request('bookmarks?paths=1')).data.paths).toEqual([current,moved.data.path]);
  const deleted=await s.request('card','DELETE',{path:current});expect((await s.request('bookmarks')).data.children).toHaveLength(1);expect((await s.request('bookmarks')).data.missing).toContainEqual({path:current,title:'Renamed fixture'});
  await s.request('card','POST',{list:'Archive/Home records',title:'Renamed fixture'});
  const restored=await s.request('trash/restore','POST',{entry:deleted.data.trashedTo});expect(restored.data.path).toContain('(2)');
  expect((await s.request('bookmarks?paths=1')).data.paths).toContain(restored.data.path);
 }finally{await s.close();}
});
it('merges simultaneous bookmark toggles and permits generated-note bookmarks without editing their source',async()=>{
 const s=await scratch();try{
  const mirror='Projects/Garrison/Memory/Claude Native/Saved fixture.md';await s.write(mirror,'# Synthetic generated note');
  await Promise.all([card,note,mirror].map(p=>s.request('bookmark','POST',{path:p,bookmarked:true})));
  expect((await s.request('bookmarks?paths=1')).data.paths).toHaveLength(3);expect(await s.read(mirror)).toBe('# Synthetic generated note');
  await s.request('bookmark','POST',{path:card,bookmarked:true});expect((await s.request('bookmarks?paths=1')).data.paths).toHaveLength(3);
 }finally{await s.close();}
});
it('rejects escaping, hidden, sensitive, symlinked and non-document bookmark targets without mutating files',async()=>{
 const s=await scratch();try{
  await fs.writeFile(s.root+'/outside.md','Synthetic outside');await fs.symlink(s.root+'/outside.md',s.vaultDir+'/escape.md');
  for(const p of ['../outside.md','.git/config','.obsidian/a.md','Memory/id_rsa','escape.md','Archive/House',card+'/front.jpg',card+'/front.jpg.md'])expect((await s.request('bookmark','POST',{path:p,bookmarked:true})).status).toBeGreaterThanOrEqual(400);
  expect((await s.request('bookmarks?paths=2')).status).toBe(400);expect((await s.request('bookmarks')).data.paths).toEqual([]);
  await s.write('Archive/_bookmarks.md','# An existing authored note');expect((await s.request('bookmark','POST',{path:card,bookmarked:true})).status).toBe(409);expect(await s.read('Archive/_bookmarks.md')).toBe('# An existing authored note');
 }finally{await s.close();}
});
it('combines the root without moving files and filters the same search index by folder',async()=>{
 const s=await scratch();try{
  const root=await s.request('tree?depth=0&path=&unified=1');expect(root.status).toBe(200);const paths=root.data.children.map((r:any)=>r.path);
  expect(paths).toEqual(expect.arrayContaining(['Archive/House','Archive/Finance','Memory','Projects']));expect(paths).not.toContain('Archive');
  expect((await s.request('tree?path=Memory&unified=1')).status).toBe(400);
  expect((await s.request('search?q=fixture&folder=../')).status).toBe(403);
  expect((await s.request('search?q=fixture&folder=Archive/House')).data.hits.every((r:any)=>r.path.startsWith('Archive/House/'))).toBe(true);
  expect(await s.read(note)).toContain('Architecture');
 }finally{await s.close();}
});
it('a bookmark toggle and its watcher event do not rebuild or serialize the document index',async()=>{
 const s=await scratch();try{
  const write=s.ctx.write;let persisted=0;s.ctx.write=async(p:string,...args:any[])=>{if(p.endsWith('/index.json'))persisted++;return write(p,...args);};
  expect((await s.request('bookmark','POST',{path:card,bookmarked:true})).status).toBe(200);await s.service.index.update('Archive/_bookmarks.md');expect(persisted).toBe(0);
  const loaded=new ArchiveIndex(s.ctx);expect(await loaded.load()).toBe(true);
 }finally{await s.close();}
});
it('stars ordinary notes with optimistic locking and preserves their body and unknown metadata',async()=>{
 const s=await scratch();try{
  await s.write('Memory/Starred fixture.md','---\ntitle: Starred fixture\ncustom: preserved\n---\nExact fixture body.\n');await s.service.index.update('Memory/Starred fixture.md');
  const before=(await s.request('note?path=Memory/Starred%20fixture.md')).data;
  expect((await s.request('note','PATCH',{path:before.path,baseSha:before.sha,starred:true})).status).toBe(200);
  const after=(await s.request('note?path=Memory/Starred%20fixture.md')).data;expect(after.frontmatter).toMatchObject({starred:true,custom:'preserved'});expect(after.markdown).toContain('Exact fixture body.\n');
  expect((await s.request('note','PATCH',{path:before.path,baseSha:before.sha,starred:false})).status).toBe(409);
  expect((await s.request('note','PATCH',{path:'../outside.md',baseSha:'new',starred:true})).status).toBe(403);
  const mirror='Projects/Garrison/Memory/Claude Native/Star fixture.md';await s.write(mirror,'# Generated fixture');const read=(await s.request('note?path='+encodeURIComponent(mirror))).data;
  expect((await s.request('note','PATCH',{path:mirror,baseSha:read.sha,starred:true})).status).toBe(403);expect(await s.read(mirror)).toBe('# Generated fixture');
 }finally{await s.close();}
});

import {it,expect} from 'vitest';
import fs from 'node:fs/promises';import path from 'node:path';
import {scratch} from './archive-test-helpers';
it('stores bookmarks as searchable, editable Markdown, preserves unknown keys, locks edits and restores from Trash',async()=>{
 const s=await scratch({seed:false});try{
  const first=await s.request('bookmark','POST',{title:'Company registry',url:'https://example.invalid/registry'});expect(first.status).toBe(200);const p=first.data.path;
  expect(p).toBe('Archive/Bookmarks/Company registry.md');expect(await s.read(p)).toContain('garrison: bookmark');
  let note=(await s.request('note?path='+encodeURIComponent(p))).data;
  await s.write(p,note.markdown+'\nPersonal bookmark note.\n');note=(await s.request('note?path='+encodeURIComponent(p))).data;
  const changed=await s.request('bookmark','PATCH',{path:p,baseSha:note.sha,title:'Official registry',starred:true});expect(changed.status).toBe(200);expect(await s.read(p)).toContain('Personal bookmark note.');expect(await s.read(p)).toContain('starred: true');
  expect((await s.request('bookmark','PATCH',{path:p,baseSha:note.sha,url:'https://example.invalid/stale'})).status).toBe(409);
  const found=await s.request('search?q=registry&kind=bookmark');expect(found.data.hits).toHaveLength(1);expect(found.data.hits[0].title).toBe('Official registry');
  const rows=(await s.request('tree?path=Archive%2FBookmarks&depth=0')).data.children;expect(rows[0]).toMatchObject({kind:'bookmark',starred:true,frontmatter:{url:'https://example.invalid/registry'}});
  expect((await s.request('bookmark','POST',{title:'Company registry',url:'https://example.invalid/second'})).data.path).toBe('Archive/Bookmarks/Company registry (2).md');
  const deleted=await s.request('note','DELETE',{path:p});expect(deleted.status).toBe(200);expect((await s.request('search?q=Official&kind=bookmark')).data.total).toBe(0);expect((await s.request('trash/restore','POST',{entry:deleted.data.trashedTo})).data.path).toBe(p);
  expect((await s.request('search?q=Official&kind=bookmark')).data.total).toBe(1);
 }finally{await s.close();}
});
it.each(['javascript:alert(1)','file:///tmp/private','https://user:password@example.invalid/','invalid'])('refuses bookmark URL %s without creating a folder',async url=>{
 const s=await scratch({seed:false});try{expect((await s.request('bookmark','POST',{title:'Rejected',url})).status).toBe(400);expect(await fs.stat(path.join(s.vaultDir,'Archive/Bookmarks')).catch(()=>null)).toBeNull();}finally{await s.close();}
});
it('confines bookmark writes, requires locks and leaves unrelated notes intact',async()=>{
 const s=await scratch();try{
  for(const folder of ['../outside','Archive/.git','Archive/.obsidian','Archive/.env','Memory'])expect((await s.request('bookmark','POST',{folder,title:'Bad',url:'https://example.invalid'})).status).toBeGreaterThanOrEqual(400);
  expect((await s.request('bookmark','PATCH',{path:'Memory/Welcome.md',title:'No lock'})).status).toBe(400);
  const before=await s.read('Memory/Welcome.md');expect((await s.request('bookmark','PATCH',{path:'Memory/Welcome.md',baseSha:'new',title:'Wrong type'})).status).toBe(400);expect(await s.read('Memory/Welcome.md')).toBe(before);
 }finally{await s.close();}
});
it('stars a document without changing its source files and preserves the flag through move/rename',async()=>{
 const s=await scratch();try{
  const p='Archive/House/House maintenance',before=await fs.readFile(path.join(s.vaultDir,p,'sample-document.jpg'));
  let doc=(await s.request('card?path='+encodeURIComponent(p))).data;
  const star=await s.request('card','PATCH',{path:p,baseSha:doc.sha,starred:true});expect(star.status).toBe(200);
  expect((await s.request('card','PATCH',{path:p,baseSha:doc.sha,starred:false})).status).toBe(409);
  const move=await s.request('card','PATCH',{path:p,baseSha:star.data.sha,title:'Reference document',moveToList:'Archive/Finance'});expect(move.status).toBe(200);
  doc=(await s.request('card?path='+encodeURIComponent(move.data.path))).data;expect(doc.frontmatter.starred).toBe(true);expect(await fs.readFile(path.join(s.vaultDir,move.data.path,'sample-document.jpg'))).toEqual(before);
 }finally{await s.close();}
});
it('does not recreate Inbox and accepts uploads only into existing documents',async()=>{
 const s=await scratch({seed:false});try{
  const form=()=>{const data=new FormData();data.set('target','Archive/Inbox');data.append('files[]',new Blob(['Fixture']),'file.txt');return data;};
  expect((await s.request('upload','POST',form())).status).toBe(404);expect(await fs.stat(path.join(s.vaultDir,'Archive/Inbox')).catch(()=>null)).toBeNull();
  const created=await s.request('card','POST',{list:'Archive',title:'Direct document'});expect(created.data.path).toBe('Archive/Direct document');const data=form();data.set('target',created.data.path);expect((await s.request('upload','POST',data)).status).toBe(200);
  await s.write('Archive/Inbox/legacy.txt','Recoverable legacy file');const removed=await s.request('list','DELETE',{path:'Archive/Inbox'});expect(removed.status).toBe(409);
  // @ts-ignore ESM core
  const {trash}=await import('../packages/archive/src/ops.mjs');const entry=await trash(s.ctx,'Archive/Inbox');expect(await s.read('Archive/.trash/'+entry.trashedTo+'/content/legacy.txt')).toBe('Recoverable legacy file');
 }finally{await s.close();}
});

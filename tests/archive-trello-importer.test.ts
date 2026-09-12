import { it,expect,vi } from 'vitest';import fs from 'node:fs/promises';import path from 'node:path';import { execFileSync,fork } from 'node:child_process';import { scratch,fixture } from './archive-test-helpers';
// @ts-ignore
import { importBoard } from '../packages/archive/src/trello/importer.mjs';
// @ts-ignore
import { TrelloClient } from '../packages/archive/src/trello/client.mjs';
const init=(dir:string)=>{for(const args of [['init'],['config','user.name','Archive fixture'],['config','user.email','archive@example.invalid'],['add','.'],['commit','--allow-empty','-m','Fixture baseline']])execFileSync('git',['-C',dir,...args],{stdio:'pipe'});};
it('tags before import, recovers after card four, skips IDs and never overwrites an authored name collision',async()=>{const s=await scratch({seed:false});try{
 init(s.vaultDir);s.service.queue.close();const board=JSON.parse(await fs.readFile(path.join(fixture,'trello-board.json'),'utf8'));const client={download:vi.fn(async()=>fs.readFile(path.join(fixture,'sample-document.jpg')))};const jobs=s.service.jobs;const row=await jobs.create('import-trello',{board,includeArchived:true});await expect(importBoard(s.ctx,jobs,row,{client,afterCard:(n:number)=>{if(n===4)throw new Error('Simulated process crash');}})).rejects.toThrow('Simulated');expect(row.summary.imported).toBe(4);expect(execFileSync('git',['-C',s.vaultDir,'tag','--list','archive/pre-import-*'],{encoding:'utf8'})).toContain(row.summary.tag);
 const next=await jobs.create('import-trello',{board,includeArchived:true});const recovered=await importBoard(s.ctx,jobs,next,{client});expect(recovered).toMatchObject({imported:5,skipped:4});const again=await importBoard(s.ctx,jobs,await jobs.create('import-trello',{board,includeArchived:true}),{client});expect(again).toMatchObject({imported:0,skipped:9});expect((await fs.readdir(path.join(s.vaultDir,'Archive'),{recursive:true})).some(n=>String(n).includes('.archive-import-'))).toBe(false);
 const one={...board,cards:[{...board.cards[0],id:'ffffffff0000000000000001'}]};const before=await s.read('Archive/Personal documents/Cartão de Cidadão/index.md');await importBoard(s.ctx,jobs,await jobs.create('import-trello',{board:one}),{client});expect(await s.read('Archive/Personal documents/Cartão de Cidadão/index.md')).toBe(before);expect(await s.read('Archive/Personal documents/Cartão de Cidadão (2)/index.md')).toContain('trello:ffffffff');
}finally{await s.close();}},15000);
it('authenticates Trello downloads only, bounds bytes, and respects Retry-After',async()=>{
 const fetchImpl=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://cdn.example.org/fixture'}})).mockResolvedValueOnce(new Response('fixture'));const client=new TrelloClient({key:'fixture-key',token:'fixture-token',fetchImpl});expect((await client.download('https://trello.com/attachment',{maxBytes:100})).toString()).toBe('fixture');expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('OAuth oauth_consumer_key="fixture-key", oauth_token="fixture-token"');expect(fetchImpl.mock.calls[1][1].headers).toEqual({});await expect(client.download('https://example.org/file')).rejects.toThrow('Only Trello');
 const sleep=vi.fn(),log=vi.fn(),limited=new TrelloClient({key:'fixture-key',token:'fixture-token',sleep,log,fetchImpl:vi.fn().mockResolvedValueOnce(new Response(null,{status:429,headers:{'retry-after':'2'}})).mockResolvedValueOnce(Response.json([]))});await limited.boards();expect(sleep).toHaveBeenCalledWith(2000);expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-token');
 const huge=new TrelloClient({key:'x',token:'y',fetchImpl:async()=>new Response('large',{headers:{'content-length':'300'}})});await expect(huge.download('https://trello.com/file',{maxBytes:20})).rejects.toMatchObject({oversize:true});
});

async function runImportWorker(vault:string,home:string,mode:string){
 return new Promise<any>((resolve,reject)=>{
  const child=fork(path.join(fixture,'import-worker.mjs'),[vault,home,mode],{silent:true});let message:any,stderr='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Import worker timed out'));},15000);
  child.stderr?.on('data',chunk=>{stderr+=chunk;});
  child.on('message',(value:any)=>{message=value;if(value.committed===4)child.kill('SIGKILL');});
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',(code,signal)=>{clearTimeout(timer);if(message&&(code===0||signal==='SIGKILL'))resolve({...message,signal});else reject(new Error(`Import worker failed (${code}): ${stderr}`));});
 });
}
async function importTree(vault:string){const rows=['Archive/'];async function walk(dir:string){for(const item of await fs.readdir(path.join(vault,dir),{withFileTypes:true})){const name=dir+'/'+item.name;rows.push(name+(item.isDirectory()?'/':''));if(item.isDirectory())await walk(name);}}await walk('Archive');return rows.sort().join('\n')+'\n';}
it('survives an actual SIGKILL after four committed cards and produces the exact golden tree',async()=>{
 const s=await scratch({seed:false});try{
  await s.service.close();init(s.vaultDir);
  expect(await runImportWorker(s.vaultDir,s.home,'interrupt')).toMatchObject({committed:4,signal:'SIGKILL'});
  const partial=(await fs.readdir(path.join(s.vaultDir,'Archive'),{recursive:true})).filter(n=>String(n).endsWith('/index.md'));
  expect(partial).toHaveLength(4);for(const file of partial)expect(await s.read('Archive/'+file)).toMatch(/^---\ngarrison: card\n/);
  const resumed=await runImportWorker(s.vaultDir,s.home,'resume');expect(resumed.summary).toMatchObject({imported:5,skipped:4});
  expect(await importTree(s.vaultDir)).toBe(await fs.readFile(path.join(fixture,'trello-expected.txt'),'utf8'));
  const repeated=await runImportWorker(s.vaultDir,s.home,'resume');expect(repeated.summary).toMatchObject({imported:0,skipped:9});
  expect(await importTree(s.vaultDir)).toBe(await fs.readFile(path.join(fixture,'trello-expected.txt'),'utf8'));
 }finally{await s.close();}
},30000);
it('retries attachment throttling and server failures without forwarding OAuth to the CDN',async()=>{
 const fetchImpl=vi.fn().mockResolvedValueOnce(new Response(null,{status:429,headers:{'retry-after':'0'}})).mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://cdn.example.org/document'}})).mockResolvedValueOnce(new Response(null,{status:429,headers:{'retry-after':'1'}})).mockResolvedValueOnce(new Response('fixture'));
 const sleep=vi.fn(async()=>{}),log=vi.fn(),client=new TrelloClient({key:'fixture-key',token:'fixture-token',fetchImpl,sleep,log});
 expect((await client.download('https://trello.com/document',{maxBytes:20})).toString()).toBe('fixture');
 expect(sleep.mock.calls).toEqual([[0],[1000],[1000]]);for(const call of fetchImpl.mock.calls.slice(0,3))expect(call[1].headers.Authorization).toContain('fixture-token');for(const call of fetchImpl.mock.calls.slice(3))expect(call[1].headers).toEqual({});expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-token');
 const delayed=new TrelloClient({key:'x',token:'y',sleep,fetchImpl:vi.fn().mockResolvedValueOnce(new Response(null,{status:429,headers:{'retry-after':'180'}})).mockResolvedValueOnce(Response.json([]))});await delayed.boards();expect(sleep).toHaveBeenLastCalledWith(180000);
});
it('cancels an attachment while waiting for Retry-After',async()=>{
 const controller=new AbortController();let started!:()=>void;const waiting=new Promise<void>(resolve=>{started=resolve;});
 const client=new TrelloClient({key:'x',token:'y',fetchImpl:async()=>{started();return new Response(null,{status:429,headers:{'retry-after':'120'}});}});
 const pending=client.download('https://trello.com/document',{signal:controller.signal,maxBytes:20});await waiting;controller.abort();await expect(pending).rejects.toThrow();
});

it('limits simultaneous board requests to four across nested callers',async()=>{
 let active=0,peak=0;const client=new TrelloClient({key:'x',token:'y',fetchImpl:async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return Response.json([]);}});
 await Promise.all(Array.from({length:20},(_,i)=>client.request('/fixture/'+i)));expect(peak).toBe(4);expect(active).toBe(0);
});

it('previews available comments while skipping cards whose badge is zero',async()=>{
 const board=JSON.parse(await fs.readFile(path.join(fixture,'trello-board.json'),'utf8'));
 const cards=board.cards.map((c:any)=>({...c,badges:{comments:board.actions.filter((a:any)=>a.data.card.id===c.id).length}}));
 const fetchImpl=vi.fn(async(value:any)=>{const url=new URL(value);if(url.pathname.endsWith('/lists'))return Response.json(board.lists);if(url.pathname.includes('/lists/'))return Response.json(cards.filter((c:any)=>c.idList===url.pathname.split('/')[3]));if(url.pathname.endsWith('/actions'))return Response.json(board.actions.filter((a:any)=>a.data.card.id===url.pathname.split('/')[3]));return Response.json({id:board.id,name:board.name,shortLink:board.shortLink});});
 const client=new TrelloClient({key:'fixture-key',token:'fixture-token',fetchImpl});const result=await client.preview(board.id,{includeArchived:true});expect(result.counts).toMatchObject({lists:3,cards:9,comments:board.actions.length,attachments:9,links:2,oversize:1});expect(fetchImpl).toHaveBeenCalledTimes(5+cards.filter((c:any)=>c.badges.comments>0).length);fetchImpl.mockClear();await client.preview(board.id,{includeArchived:true,includeComments:false});expect(fetchImpl).toHaveBeenCalledTimes(5);cards[0].badges.comments=100;expect((await client.preview(board.id,{includeArchived:true})).counts.comments).toBe(board.actions.length);
});

it('persists credential-free request paths in the import job through the real service client',async()=>{
 const board=JSON.parse(await fs.readFile(path.join(fixture,'trello-board.json'),'utf8'));
 const fetchImpl=async(url:string|URL)=>{
  const p=new URL(url).pathname;
  if(p.endsWith('/lists'))return Response.json([]);
  if(p.endsWith('/customFields'))return Response.json([]);
  return Response.json({id:board.id,name:board.name,shortLink:board.shortLink});
 };
 const s=await scratch({seed:false,credentials:async()=>({TRELLO_KEY:'fixture-secret-key',TRELLO_TOKEN:'fixture-secret-token'}),clientFactory:()=>new TrelloClient({key:'fixture-secret-key',token:'fixture-secret-token',fetchImpl})});
 try{
  init(s.vaultDir);const out=await s.request('import/trello/run','POST',{boardId:board.id});expect(out.status).toBe(200);
  const row=s.service.jobs.get(out.data.jobId);await vi.waitFor(()=>expect(row.state).toBe('done'));
  const raw=await fs.readFile(path.join(s.home,'archive/jobs',row.id+'.json'),'utf8');const messages=JSON.parse(raw).log.map((x:any)=>x.message);
  expect(messages).toContain(`/boards/${board.id}`);expect(messages).toContain(`/boards/${board.id}/lists`);expect(messages).toContain(`/boards/${board.id}/customFields`);
  expect(raw).not.toContain('fixture-secret');expect(raw).not.toContain('token=');
 }finally{await s.close();}
});

it('keeps removed task lists and cards in Trash across imports, including new tasks, until a list is restored',async()=>{
 const s=await scratch({seed:false});
 try{
  init(s.vaultDir);const board=JSON.parse(await fs.readFile(path.join(fixture,'trello-board.json'),'utf8'));
  const run=async()=>importBoard(s.ctx,s.service.jobs,await s.service.jobs.create('import-trello',{board,includeArchived:true}),{});
  expect((await run()).imported).toBe(9);
  // @ts-ignore Existing shell operations, with a synthetic vault only.
  const {trash,restore}=await import('../packages/archive/src/ops.mjs');
  const removed=await trash(s.ctx,'Archive/Personal documents');
  await trash(s.ctx,'Archive/House/Fixture card 4');
  board.cards.push({...board.cards[0],id:'ffffffff0000000000000042',name:'A newly added task'});
  const result=await run();expect(result).toMatchObject({imported:0,skipped:10});
  await expect(fs.stat(path.join(s.vaultDir,'Archive/Personal documents'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(fs.stat(path.join(s.vaultDir,'Archive/House/Fixture card 4'))).rejects.toMatchObject({code:'ENOENT'});
  await restore(s.ctx,removed.trashedTo);
  expect(await run()).toMatchObject({imported:1,skipped:9});
  expect(await s.read('Archive/Personal documents/A newly added task/index.md')).toContain('trello:ffffffff0000000000000042');
  await expect(fs.stat(path.join(s.vaultDir,'Archive/House/Fixture card 4'))).rejects.toMatchObject({code:'ENOENT'});
 }finally{await s.close();}
});

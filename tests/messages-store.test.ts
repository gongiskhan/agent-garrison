import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStateService, type StateHarness } from './state-service-harness';
import { StateClient } from '@garrison/state-client';
import { filterToSql, ftsPrefix } from '../packages/messages/filter.mjs';
import { acquireIngestLease, authenticateIngest } from '../services/state/src/messages/store.mjs';
import { openDb } from '../services/state/src/db.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const capabilities={read:true,send:true,reply:true,markRead:true,archive:true,delete:true,groups:true,threads:true,attachments:true,audioReceive:true,audioSend:true,markdown:true,code:true,reactionsRead:false,openInProvider:true};
const descriptor={id:'fixture',kind:'mail',label:'Fixture',badge:{text:'Fixture',glyph:'Mail',color:'sage'},accounts:[{id:'one',label:'One'}],capabilities,sync:{mode:'poll',intervalSeconds:120},setupHint:null};
const conversation={id:'conversation-a',provider:'fixture',account:'one',externalId:'thread-a',kind:'mail-thread',title:'Fixture mail',participants:[],lastMessageTs:'2026-09-13T12:00:00.000Z'};
const message={id:'message-a',provider:'fixture',account:'one',conversationId:'conversation-a',externalId:'external-a',direction:'in',sender:{id:'sender',name:'Ana Example',address:'ana@example.invalid',isMe:false},bodyText:'A deterministic message',subject:'Project update',ts:'2026-09-13T12:00:00.000Z',attachments:[{id:'audio-a',kind:'audio',name:'recording.m4a',mime:'audio/mp4',size:10,path:null,thumbPath:null,playbackPath:null,durationMs:12000,transcript:'banana meeting',transcriptStatus:'done'}]};
let h:StateHarness & {tokens:Record<string,string>}, client:StateClient, ingest:StateClient, fence:number;
const req=(method:string,route:string,body?:unknown)=>client.request(method,`/v1/messages${route}`,{body});
beforeAll(async()=>{ h=await startStateService({nodes:['test-node','peer-node']}); client=h.client; await req('POST','/providers/register',{descriptor}); const lease:any=await req('POST','/lease/acquire',{}); fence=lease.fence; ingest=new StateClient({url:h.url,token:lease.token,node:'test-node'}); },30_000);
afterAll(async()=>{await h?.stop();});
const batch=(messages=[message],cursor:any={page:1},conversations=[conversation])=>ingest.request('POST','/v1/messages/ingest',{body:{provider:'fixture',account:'one',fence,messages,conversations,cursor}});
describe('Messages shared store',()=>{
  it('upserts one external identity and advances cursor in the same batch',async()=>{
    const first:any=await batch(); expect(first.changed).toBe(1);
    const second:any=await batch([{...message,id:'other-local-id'}]); expect(second.changed).toBe(0);
    const result:any=await req('GET',''); expect(result.messages).toHaveLength(1); expect(result.messages[0].id).toBe('message-a');
    const sync:any=await req('GET','/sync'); expect(sync.sync[0].cursor).toEqual({page:1});
  });
  it('indexes attachment transcripts and safely quotes FTS prefix searches',async()=>{
    const result:any=await req('GET',`?filter=${encodeURIComponent(JSON.stringify({text:'ban mee'}))}`); expect(result.messages).toHaveLength(1);
    expect(ftsPrefix('" OR * banana')).toBe('"OR"* AND "banana"*');
    const compiled=filterToSql({from:"x' OR 1=1--"}); expect(compiled.sql).not.toContain("x'"); expect(compiled.params).toContain("%x' OR 1=1--%");
  });
  it('uses AND across fields and OR within lists',async()=>{
    const f={providers:['fixture','slack'],kinds:['mail'],unread:true,attachmentKind:'audio',from:'ANA',text:'ban'};
    const result:any=await req('GET',`?filter=${encodeURIComponent(JSON.stringify(f))}`); expect(result.messages).toHaveLength(1);
    const hidden:any=await req('GET',`?filter=${encodeURIComponent(JSON.stringify({...f,kinds:['chat']}))}`); expect(hidden.messages).toHaveLength(0);
  });
  it('denies ingest credentials vault, sends, user state and other message actions',async()=>{
    for (const route of ['/v1/secrets','/v1/messages/outbox','/v1/messages/message-a/state']) await expect(ingest.request(route.endsWith('state')?'POST':'GET',route,{body:route.endsWith('state')?{read:true}:undefined})).rejects.toMatchObject({status:403});
    const peer=new StateClient({url:h.url,token:h.tokens['peer-node'],node:'peer-node'});
    const lease:any=await peer.request('POST','/v1/messages/lease/acquire',{body:{}}); expect(lease.granted).toBe(false);
    await expect(ingest.request('POST','/v1/messages/ingest',{body:{provider:'fixture',account:'one',fence:fence+1,messages:[message],cursor:{bad:true}}})).rejects.toMatchObject({status:409});
  });
  it('rolls back the entire batch and cursor on invalid input',async()=>{
    await expect(batch([{...message,id:'bad',externalId:'bad',ts:'not-a-date'}],{page:99})).rejects.toMatchObject({status:422});
    const sync:any=await req('GET','/sync'); expect(sync.sync[0].cursor).toEqual({page:1});
  });
  it('keeps local Hide through resync and updates unread counts',async()=>{
    await req('POST','/message-a/state',{deleted:true});
    await batch([{...message,bodyText:'An updated body'}]);
    const result:any=await req('GET','/message-a'); expect(result.message.deleted).toBe(true);
    await req('POST','/message-a/state',{deleted:false,read:true}); const result2:any=await req('GET','/counts'); expect(result2.counts.all).toBe(0);
  });
  it('emits one system message per source event and closes needs-me only after signal success',async()=>{
    const input={category:'card.needs-input',title:'Choose a path',body:'Fixture only',idempotencyKey:'card-event-one',conversationRef:'test-conversation',action:{kind:'question',prompt:'Choose?',options:['Yes','No'],answeredAt:null,answer:null,revertUntil:null,target:{conversationId:'test-conversation',questionId:'handoff-1'}}};
    const a:any=await req('POST','/system',input),b:any=await req('POST','/system',input); expect(a.message.id).toBe(b.message.id); expect(b.changed).toBe(false);
    const before:any=await req('GET','/needs-me'); expect(before.messages.map((m:any)=>m.id)).toContain(a.message.id);
    const claim:any=await req('POST',`/${a.message.id}/answer/begin`,{answer:'Yes'});
    const pending:any=await req('GET','/needs-me'); expect(pending.messages.map((m:any)=>m.id)).toContain(a.message.id);
    await req('POST',`/${a.message.id}/answer/finish`,{claimToken:claim.claimToken});
    const after:any=await req('GET','/needs-me'); expect(after.messages).toHaveLength(0);
  });
  it('supports rule ordering, stop, suppression, idempotent actions and dry-run counts',async()=>{
    const a:any=await req('POST','/rules',{name:'Label and stop',order:1,match:{from:'ana'},actions:[{type:'label',label:'client'},{type:'mute'},{type:'suppressNotification'}],stopProcessing:true});
    await req('POST','/rules',{name:'Do not run',order:2,match:{from:'ana'},actions:[{type:'star'}]});
    await batch([{...message,id:'message-b',externalId:'external-b',bodyText:'Rules sample'}],{page:2});
    const b:any=await req('GET','/message-b'); expect(b.message.labels).toEqual(['client']); expect(b.message.starred).toBe(false); expect(b.message.suppressNotification).toBe(true);
    await batch([{...message,id:'message-b',externalId:'external-b',bodyText:'Rules sample changed'}],{page:3});
    const rules:any=await req('GET','/rules'); expect(rules.rules[0].matchedCount).toBe(1);
    const test:any=await req('POST','/rules/test',a.rule); const applied:any=await req('POST',`/rules/${a.rule.id}/run`,{}); expect(applied.count).toBe(test.count);
  });
  it('persists user views and protects built-ins',async()=>{
    const saved:any=await req('POST','/views',{name:'Clients',icon:'Mail',filter:{from:'Ana'},order:10});
    const views:any=await req('GET','/views'); expect(views.views.at(-1).id).toBe(saved.view.id);
    await expect(req('DELETE','/views/all')).rejects.toMatchObject({status:422});
  });
  it('keeps attachment metadata on its owner and indexes completed transcripts',async()=>{
    const attachment={...message.attachments[0],transcript:'clementine owner transcript',path:'attachments/fixture/one/2026-09/audio-a.m4a'};
    const peer=new StateClient({url:h.url,token:h.tokens['peer-node'],node:'peer-node'});
    await expect(peer.request('POST','/v1/messages/message-a/media',{body:{attachment}})).rejects.toMatchObject({status:403});
    await expect(req('POST','/message-a/media',{attachment:{...attachment,path:'../vault.json'}})).rejects.toMatchObject({status:422});
    await req('POST','/message-a/media',{attachment});
    const matches:any=await req('GET',`?filter=${encodeURIComponent(JSON.stringify({text:'clemen'}))}`);expect(matches.messages.map((m:any)=>m.id)).toContain('message-a');
  });
  it('persists the agent hold and allows cancellation before a send claim',async()=>{
    const result:any=await req('POST','/outbox',{id:'send-one',provider:'fixture',account:'one',to:{address:'self@example.invalid'},body:{markdown:'Fixture'},origin:'agent'});
    expect(Date.parse(result.item.holdUntil)-Date.now()).toBeGreaterThan(58000);
    const claim:any=await req('POST','/work/outbox/claim',{}); expect(claim.item).toBeNull();
    const cancelled:any=await req('POST','/outbox/send-one/cancel',{}); expect(cancelled.item.status).toBe('cancelled');
  });
});
it('hands a lease to a second node only after expiry and invalidates the first token',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'messages-lease-')); const db=openDb(path.join(dir,'state.db'));
  try { const start=Date.now(); const a=acquireIngestLease(db,'one',{at:start}); expect(a.granted).toBe(true); expect(acquireIngestLease(db,'two',{at:start+89999}).granted).toBe(false); const b=acquireIngestLease(db,'two',{at:start+90001}); expect(b.granted).toBe(true); expect(b.fence).toBe(a.fence!+1); expect(authenticateIngest(db,a.token,start+90002)).toBeNull(); expect(authenticateIngest(db,b.token,start+90002)?.name).toBe('two'); }
  finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

import {afterAll,beforeAll,expect,it} from 'vitest';
import {StateClient} from '@garrison/state-client';
import {startStateService,type StateHarness} from './state-service-harness';

let h:StateHarness,ingest:StateClient,fence:number;
const req=(method:string,route:string,body?:unknown)=>h.client.request(method,`/v1/messages${route}`,{body}) as Promise<any>;
const seed=async(id:string)=>{
  const ts=new Date().toISOString();
  await ingest.request('POST','/v1/messages/ingest',{body:{provider:'receipt-fixture',account:'self',fence,cursor:{id},
    conversations:[{id:`thread-${id}`,provider:'receipt-fixture',account:'self',externalId:`thread-${id}`,kind:'mail-thread',title:'Fixture',participants:[],lastMessageTs:ts}],
    messages:[{id,provider:'receipt-fixture',account:'self',conversationId:`thread-${id}`,externalId:`external-${id}`,direction:'in',sender:{id:'sender',name:'Private fixture',address:'private@example.invalid',isMe:false},bodyText:'Private message body',ts,read:false,attachments:[]}]}});
};
beforeAll(async()=>{
  h=await startStateService();
  await req('POST','/providers/register',{descriptor:{id:'receipt-fixture',kind:'mail',label:'Fixture',badge:{text:'Fixture',glyph:'Mail',color:'sage'},accounts:[{id:'self',label:'Self'}],capabilities:{read:true,markRead:true,delete:true},sync:{mode:'poll',intervalSeconds:120}}});
  const lease=await req('POST','/lease/acquire',{});fence=lease.fence;
  ingest=new StateClient({url:h.url,token:lease.token,node:'test-node'});
},30_000);
afterAll(async()=>{await h?.stop();});

it('requires node authentication and refuses restricted ingest credentials',async()=>{
  expect((await fetch(`${h.url}/v1/messages/missing/effects`)).status).toBe(401);
  expect((await fetch(`${h.url}/v1/messages/missing/effects`,{headers:{authorization:'Bearer invalid'}})).status).toBe(401);
  await expect(ingest.request('GET','/v1/messages/missing/effects')).rejects.toMatchObject({status:403});
});

it('distinguishes an absent message from an existing message without provider actions',async()=>{
  await expect(req('GET','/missing/effects')).rejects.toMatchObject({status:404});
  await seed('empty');
  expect(await req('GET','/empty/effects')).toEqual({effects:[]});
});

it('shows pending, running and acknowledged completion without exposing private payloads',async()=>{
  await seed('success');await req('POST','/success/state',{read:true,labels:['private-label-value']});
  const pending=await req('GET','/success/effects');
  expect(pending.effects).toHaveLength(1);
  expect(pending.effects[0]).toMatchObject({type:'providerState',status:'pending',finishedAt:null,error:null,patchFields:['read','labels']});
  expect(Object.keys(pending.effects[0]).sort()).toEqual(['createdAt','error','finishedAt','id','patchFields','revision','status','type']);
  const claim=await req('POST','/work/effects/claim',{});
  expect(claim.item.messageId).toBe('success');
  expect((await req('GET','/success/effects')).effects[0].status).toBe('running');
  await req('POST',`/work/effects/${claim.item.id}/finish`,{claimToken:claim.claimToken});
  const complete=await req('GET','/success/effects');
  expect(complete.effects[0]).toMatchObject({id:claim.item.id,status:'done',error:null,finishedAt:expect.any(String)});
  expect(Date.parse(complete.effects[0].finishedAt)).toBeGreaterThanOrEqual(Date.parse(complete.effects[0].createdAt));
  expect(JSON.stringify(complete)).not.toMatch(/private@example|Private message|private-label-value|claimToken|sender|before|payload/);
  expect(await req('GET','/success/effects')).toEqual(complete);
});

it('reports provider failure after rollback without reflecting sensitive error text',async()=>{
  await seed('failure');await req('POST','/failure/state',{read:true});
  const claim=await req('POST','/work/effects/claim',{});
  expect(claim.item.messageId).toBe('failure');
  await req('POST',`/work/effects/${claim.item.id}/finish`,{claimToken:claim.claimToken,error:'Bearer fixture-secret for private@example.invalid: Private message body'});
  const receipts=await req('GET','/failure/effects');
  expect(receipts.effects[0]).toMatchObject({status:'failed',error:'Provider action failed',finishedAt:expect.any(String),patchFields:['read']});
  expect((await req('GET','/failure')).message.read).toBe(false);
  expect(JSON.stringify(receipts)).not.toMatch(/fixture-secret|private@example|Private message/);
});

it('returns only the latest fifty receipts and omits other effect kinds',async()=>{
  await seed('bounded');
  await req('POST','/bounded/card',{});
  expect(await req('GET','/bounded/effects')).toEqual({effects:[]});
  const revisions:number[]=[];
  for(let index=0;index<55;index++)revisions.push((await req('POST','/bounded/state',{read:index%2===0})).message.revision);
  const {effects}=await req('GET','/bounded/effects');
  expect(effects).toHaveLength(50);
  expect(effects.every((effect:any)=>effect.type==='providerState')).toBe(true);
  expect(effects.map((effect:any)=>effect.revision)).toEqual(revisions.reverse().slice(0,50));
});

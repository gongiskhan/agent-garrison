import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../services/state/src/db.mjs';
// @ts-ignore State implementation uses plain JavaScript.
import { registerProvider, listProviders, setProviderHealth, acquireIngestLease, enqueueOutbox } from '../services/state/src/messages/store.mjs';
let db:any,root:string;
const descriptor={id:'callback',kind:'chat',label:'Fixture',badge:{text:'Fixture',color:'sage',glyph:'MessageCircle'},accounts:[{id:'one',label:'One'}],capabilities:{read:true,send:true},sync:{mode:'stream'},setupHint:null,retentionDays:90,holdSeconds:60};
beforeEach(()=>{root=mkdtempSync(path.join(os.tmpdir(),'messages-registry-'));db=openDb(path.join(root,'state.db'));});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});});
it('keeps the connected fitting owner when an unpaired peer advertises the same provider',()=>{
  registerProvider(db,'paired-owner',{descriptor,callbackBaseUrl:'http://127.0.0.1:8090/messages-adapter'});
  const result=registerProvider(db,'unpaired-peer',{descriptor:{...descriptor,setupHint:'Pair in fitting',accounts:[]},callbackBaseUrl:'http://127.0.0.1:8091/messages-adapter'});
  expect(result.changed).toBe(false);expect(listProviders(db)[0]).toMatchObject({ownerNode:'paired-owner',accounts:descriptor.accounts,setupHint:null});
});
it('preserves user settings across descriptor refresh and keeps the callback owner on settings changes',()=>{
  registerProvider(db,'owner',{descriptor,callbackBaseUrl:'http://127.0.0.1:8090/messages-adapter'});
  registerProvider(db,'owner',{descriptor:{...descriptor,retentionDays:30,holdSeconds:120,sendReadReceipts:false},callbackBaseUrl:'http://127.0.0.1:8090/messages-adapter',settingsUpdate:true});
  registerProvider(db,'owner',{descriptor,callbackBaseUrl:'http://127.0.0.1:8090/messages-adapter'});
  expect(listProviders(db)[0]).toMatchObject({ownerNode:'owner',retentionDays:30,holdSeconds:120,sendReadReceipts:false});
});
it('keeps a healthy account usable while preserving another account failure',()=>{
  const accounts=[...descriptor.accounts,{id:'two',label:'Two'}];
  registerProvider(db,'owner',{descriptor:{...descriptor,accounts}});acquireIngestLease(db,'ingest');
  expect(()=>setProviderHealth(db,'stranger','callback',{ok:false})).toThrow('Only the provider owner');
  setProviderHealth(db,'ingest','callback',{ok:false,reason:'Temporary failure',account:'one'});
  setProviderHealth(db,'ingest','callback',{ok:true,account:'two'});
  registerProvider(db,'owner',{descriptor:{...descriptor,accounts,health:{ok:true}}});
  expect(listProviders(db)[0].health).toEqual({ok:true});
  expect(listProviders(db)[0].accountHealth.one).toMatchObject({ok:false,reason:'Temporary failure'});
  const send={provider:'callback',to:{address:'self@example.invalid'},body:{markdown:'Fixture'}};
  expect(()=>enqueueOutbox(db,'owner',{...send,account:'one'})).toThrow('Account cannot send');
  expect(enqueueOutbox(db,'owner',{...send,account:'two'}).item.status).toBe('held');
  expect(()=>setProviderHealth(db,'ingest','callback',{ok:true,account:'unknown'})).toThrow('Unknown provider account');
  setProviderHealth(db,'ingest','callback',{ok:true,account:'one'});expect(listProviders(db)[0].health).toEqual({ok:true});
});

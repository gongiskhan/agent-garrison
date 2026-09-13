import {expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {selfTarget,smokeOptions,runSmoke} from '../scripts/messages-live-smoke.mjs';

it('requires an HTTPS origin and an explicit send flag',()=>{
  expect(smokeOptions(['--base','https://fixture.tail.example'])).toMatchObject({send:false});
  expect(smokeOptions(['--base','https://fixture.tail.example','--send']).send).toBe(true);
  expect(()=>smokeOptions(['--base','https://token@fixture.example'])).toThrow();
  expect(()=>smokeOptions(['--base','http://fixture.example'])).toThrow();
});
it('derives destinations only from connected account identity',()=>{
  expect(selfTarget({id:'google'}, {id:'account',address:'self@example.invalid'})).toEqual({address:'self@example.invalid'});
  expect(selfTarget({id:'slack'}, {id:'workspace',address:'U123ABC'})).toEqual({channel:'U123ABC'});
  expect(selfTarget({id:'whatsapp-web'}, {id:'351000000000:3@s.whatsapp.net'})).toEqual({jid:'351000000000@s.whatsapp.net'});
  expect(()=>selfTarget({id:'slack'},{id:'workspace',address:'COTHER'})).toThrow('verified self');
  expect(()=>selfTarget({id:'google'},{id:'account',address:'self@example.invalid',setupHint:'Reconnect'})).toThrow('Reconnect');
});
it('discovery writes redacted readiness evidence without any send or attachment request',async()=>{
  const out=await fs.mkdtemp(path.join(os.tmpdir(),'smoke-plan-'));
  try{
    const fetchImpl=vi.fn(async (_input:RequestInfo|URL)=>Response.json({providers:[{id:'google',accounts:[{id:'private-account',address:'self@example.invalid'}]}]}));
    const report=await runSmoke({base:'https://fixture.example',send:false,out,providers:['google'],assets:out},{fetchImpl,log:()=>{}});
    expect(report.accounts[0].status).toBe('ready');expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://fixture.example/api/messages/providers');
    const evidence=await fs.readFile(path.join(out,(await fs.readdir(out))[0]),'utf8');
    expect(evidence).not.toContain('self@example.invalid');expect(evidence).not.toContain('private-account');
  }finally{await fs.rm(out,{recursive:true,force:true});}
});

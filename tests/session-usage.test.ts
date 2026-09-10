import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexUsage, claudeUsage, readCodexAccount } from '../src/lib/session-usage';
import { classifyPeerPath } from '../src/lib/mesh/peer-proxy';

describe('owner account usage', () => {
  it('uses all Codex buckets, ignores absent and malformed windows, and never returns credentials or credit controls', () => {
    const result = codexUsage({rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{primary:{usedPercent:41,windowDurationMins:10080,resetsAt:1789451134},secondary:null},spark:{limitName:'Spark',primary:{usedPercent:0,windowDurationMins:300},secondary:{usedPercent:null}}},rateLimitResetCredits:{credits:[{id:'private-credit'}]},token:'SECRET'}, {email:'person@example.test',planType:'pro',accessToken:'SECRET'});
    expect(result.windows).toEqual([{label:'Codex · Weekly',usedPercent:41,resetsAt:'2026-09-15T05:45:34.000Z'},{label:'Spark · 5 hours',usedPercent:0,resetsAt:null}]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private-credit/);
    expect(codexUsage({rateLimits:{primary:{usedPercent:'0'},secondary:{usedPercent:NaN}}},null)).toMatchObject({status:'unavailable',windows:[]});
  });
  it('preserves measured Claude limits with an explicit stale status after a failed probe', () => {
    expect(claudeUsage({fiveHour:{pct:23,resetAt:null,status:null},weekly:{pct:18,resetAt:null,status:null},probedAt:new Date().toISOString(),status:null,error:'private diagnostic'},'Machine login')).toMatchObject({status:'stale',windows:[{usedPercent:23},{usedPercent:18}]});
    expect(JSON.stringify(claudeUsage({fiveHour:{pct:23,resetAt:null,status:null},weekly:{pct:18,resetAt:null,status:null},probedAt:new Date().toISOString(),status:null,error:'private diagnostic'},'Machine login'))).not.toContain('private diagnostic');
  });
  it('allows only read-only owner usage routes', () => {
    expect(classifyPeerPath('GET',['session-usage','codex']).ok).toBe(true);
    expect(classifyPeerPath('POST',['session-usage','codex']).ok).toBe(false);
    expect(classifyPeerPath('GET',['session-usage','..']).ok).toBe(false);
  });
  it('initializes before reading and terminates a bounded app-server without starting a thread', async () => {
    const tmp=mkdtempSync(path.join(os.tmpdir(),'garrison-usage-test-'));
    const script=path.join(tmp,'codex');
    writeFileSync(script, `#!/usr/bin/env node
const rl=require('readline').createInterface({input:process.stdin});let initialized=false;
rl.on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize'){console.log(JSON.stringify({id:r.id,result:{}}));return;}
if(r.method==='initialized'){initialized=true;return;}
if(!initialized||!r.method.startsWith('account/'))process.exit(3);
if(r.method==='account/read') console.log(JSON.stringify({id:r.id,result:{account:{email:'test@example.test'}}}));
if(r.method==='account/rateLimits/read') console.log(JSON.stringify({id:r.id,result:{rateLimits:{primary:{usedPercent:17,windowDurationMins:300}}}}));});`);
    chmodSync(script,0o700);
    try {
      expect(await readCodexAccount(tmp,script,2000)).toMatchObject({status:'available',account:'test@example.test',windows:[{usedPercent:17}]});
      writeFileSync(script,'#!/usr/bin/env node\nsetInterval(()=>{},1000);');
      expect(await readCodexAccount(tmp,script,100)).toMatchObject({status:'unavailable',detail:'The Codex account check timed out.'});
    } finally {rmSync(tmp,{recursive:true,force:true});}
  });
});

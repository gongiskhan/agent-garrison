import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Existing routed substrate: Phase 0 proof without Archive product code.
// @ts-expect-error Existing ESM runtime adapter has no TypeScript declaration.
import { AgentSdkAdapter } from '../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs';

describe.skipIf(process.env.GARRISON_INTEGRATION !== '1')('Archive image binding (real runtime)', () => {
  it('reads the fixture without memory settings or persistence and reports usage', async () => {
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'archive-binding-'));
    const adapter=new AgentSdkAdapter();const usage:any[]=[];const tools:string[]=[];
    const session=await adapter.spawn({compositionDir:home,provider:'anthropic',model:'claude-sonnet-5',promptMode:'lean',
      leanPrompt:'Use Read on the synthetic image. Return ONLY JSON with text and fields [{label,value}]. Include the printed reference as a field.',
      tools:['Read'],allowedTools:['Read'],disallowedTools:[],mcpServers:{},strictMcpConfig:true,maxTurns:3,
      permissionMode:'bypassPermissions',persistSession:false,env:{...process.env,GARRISON_HOME:home,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});
    const timer=setTimeout(()=>void adapter.cancel(session),120_000);
    try {
      expect(session.queryAssembly.persistSession).toBe(false);expect(session.queryAssembly.settingSources).toEqual([]);
      expect(session.queryAssembly.tools).toEqual(['Read']);
      await adapter.sendTurn(session,`Read the image at ${JSON.stringify(path.join(process.cwd(),'tests/fixtures/archive/sample-document.jpg'))}.`,{
        onUsage:(r:any)=>usage.push(r),onTool:(r:any)=>tools.push(r.name)});
      const result=await adapter.awaitResponse(session);
      const json=JSON.parse(result.text.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));
      expect(json.text).toContain('TEST-48392017');expect(json.fields.some((f:any)=>f.value==='TEST-48392017')).toBe(true);
      expect(tools).toContain('Read');expect(tools.every(n=>n==='Read')).toBe(true);
      expect(usage.find(r=>r.source==='result')?.usage.output_tokens).toBeGreaterThan(0);
    } finally { clearTimeout(timer);await adapter.teardown(session);fs.rmSync(home,{recursive:true,force:true}); }
  },130_000);
});

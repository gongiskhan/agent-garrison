import { it, expect } from 'vitest';
import path from 'node:path';
import { agentArchiveFixture } from './archive-agent-fixture';
// @ts-ignore Existing routed runtime, with its ordinary account delivery.
import { AgentSdkAdapter } from '../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs';
// @ts-ignore Actual working-session tool inventory.
import { DUTY_MCP_TOOLS } from '../fittings/seed/http-gateway/scripts/lib/harness-profiles.mjs';

it.skipIf(process.env.GARRISON_INTEGRATION !== '1')('Zeca finds the correct company certificate through real Archive search/read tools', async () => {
  const app = await agentArchiveFixture(), adapter = new AgentSdkAdapter();
  let session: any;
  const calls: string[] = [];
  try {
    const before = await app.snapshot();
    // An explicitly authorized account may be delivered in memory by the
    // integration launcher. No credential or runtime settings file is created.
    const account = process.env.ARCHIVE_INTEGRATION_ACCOUNT;
    const token = process.env.ARCHIVE_INTEGRATION_TOKEN;
    if (account && !token) throw new Error('The selected integration account was not delivered');
    session = await adapter.spawn({ compositionDir: app.root, provider: 'anthropic', model: 'claude-sonnet-5',
      ...(account ? { account, secrets: { ['ANTHROPIC_ACCOUNT__' + account]: token } } : {}),
      promptMode: 'lean', leanPrompt: 'You are Zeca, the user’s assistant. Answer their question accurately using your available tools. The Archive holds documents and knowledge. Kanban holds tasks. Cite the matching document; do not guess or persist its content. These are synthetic test documents.',
      tools: [], allowedTools: ['mcp__garrison__garrison_archive_search', 'mcp__garrison__garrison_archive_read'],
      disallowedTools: [], mcpServers: { garrison: { command: process.execPath,
        args: [path.resolve('fittings/seed/mcp-gateway/scripts/gateway.mjs'), 'stdio'],
        env: { GARRISON_HOME: app.home, GARRISON_COMPOSITION_DIR: app.root, GARRISON_APP_URL: app.base,
          GARRISON_MCP_TOOLS: DUTY_MCP_TOOLS.dialogue.join(',') } } }, strictMcpConfig: true,
      maxTurns: 12, permissionMode: 'bypassPermissions', persistSession: false,
      env: { ...process.env, GARRISON_HOME: app.home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    const timer = setTimeout(() => void adapter.cancel(session), 120_000);
    try {
      await adapter.sendTurn(session, 'Qual é o número da certidão comercial da minha empresa Example Orchard? Está nos meus documentos pessoais. Mostra-me a fonte.', {
        onTool: (event: any) => calls.push(event.name),
      });
      const result = await adapter.awaitResponse(session);
      expect(result.text).toContain('FIXTURE-7391-4826');
      expect(result.text).not.toContain('WRONG-COMPANY-1111');
      expect(result.text).toMatch(/archive\/card|garrison:\/\/archive/);
      expect(calls).toContain('mcp__garrison__garrison_archive_search');
      expect(calls).toContain('mcp__garrison__garrison_archive_read');
      expect(calls.every(name => name.includes('garrison_archive_'))).toBe(true);
      expect(app.requests.every(r => r.startsWith('GET '))).toBe(true);
      expect(await app.snapshot()).toEqual(before);
      expect(session.queryAssembly.persistSession).toBe(false);
      expect(session.queryAssembly.settingSources).toEqual([]);
    } finally { clearTimeout(timer); }
  } finally { if (session) await adapter.teardown(session); await app.close(); }
}, 140_000);

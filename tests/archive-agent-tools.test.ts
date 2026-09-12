import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { agentArchiveFixture } from './archive-agent-fixture';
// @ts-ignore Fitting public ESM tools
import { callArchiveSearch, callArchiveRead, ARCHIVE_TOOL_DEFINITIONS } from '../fittings/seed/mcp-gateway/scripts/lib/archive-tools.mjs';
// @ts-ignore Working session's actual inventory
import { SHARED_MCP_TOOLS, DUTY_MCP_TOOLS, applyDutyHarnessProfile } from '../fittings/seed/http-gateway/scripts/lib/harness-profiles.mjs';
const require = createRequire(path.resolve('fittings/seed/mcp-gateway/package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

it('searches a sensitive company certificate, reads the extracted number and preserves its source without writes', async () => {
  const app = await agentArchiveFixture();
  const deps = { env: { GARRISON_APP_URL: app.base } };
  try {
    const before = await app.snapshot();
    const result = await callArchiveSearch({ query: 'certidao Example Orchard' }, deps);
    const hit = result.hits.find((h: any) => h.path === app.source);
    expect(hit).toMatchObject({ kind: 'card', sensitive: true, snippet: 'Sensitive card, open to view' });
    expect(JSON.stringify(result)).not.toContain('FIXTURE-7391-4826');
    const read = await callArchiveRead({ path: hit.path, kind: hit.kind }, deps);
    expect(read.attachments[0].extraction.sections.fields).toContainEqual({ label: 'Commercial certificate number', value: 'FIXTURE-7391-4826' });
    expect(read.url).toBe('/archive/card?path=' + encodeURIComponent(app.source));
    expect(read.description).not.toContain('WRONG-COMPANY');
    expect((await callArchiveSearch({ query: 'TRASH-DECOY' }, deps)).total).toBe(0);
    expect(await app.snapshot()).toEqual(before);
    expect(app.requests.every(r => r.startsWith('GET '))).toBe(true);
    expect(ARCHIVE_TOOL_DEFINITIONS.every((d: any) => d.annotations.readOnlyHint)).toBe(true);
  } finally { await app.close(); }
});

it('rejects escaping, hidden, sensitive and symlink paths through the actual confined API; reports missing sources', async () => {
  const app = await agentArchiveFixture();
  const deps = { env: { GARRISON_APP_URL: app.base } };
  try {
    await fs.writeFile(path.join(app.root, 'outside.md'), 'OUTSIDE-FIXTURE');
    await fs.symlink(path.join(app.root, 'outside.md'), path.join(app.vaultDir, 'escape.md'));
    for (const p of ['../outside.md', '/etc/passwd', 'Archive/.trash/removed/content/index.md', '.git/config', '.obsidian/workspace', 'escape.md', 'Memory/.env'])
      await expect(callArchiveRead({ path: p, kind: 'note' }, deps)).rejects.toThrow();
    await expect(callArchiveRead({ path: 'Memory/missing.md' }, deps)).rejects.toThrow(/not found/);
    await expect(callArchiveSearch({ query: '' }, deps)).rejects.toThrow(/query/);
    await expect(callArchiveSearch({ query: 'certificate', limit: 1000 }, deps)).rejects.toThrow(/limit/);
    expect(app.requests.every(r => r.startsWith('GET '))).toBe(true);
  } finally { await app.close(); }
});

it('exposes both Archive tools in real stdio and every shared working profile, including dialogue', async () => {
  const app = await agentArchiveFixture();
  const names = ['garrison_archive_search', 'garrison_archive_read'];
  const client = new Client({ name: 'archive-fixture', version: '1' });
  try {
    for (const inventory of [SHARED_MCP_TOOLS, DUTY_MCP_TOOLS.dialogue, applyDutyHarnessProfile({ target: { runtime: 'agent-sdk' } }, 'discuss').target.mcpTools])
      expect(inventory).toEqual(expect.arrayContaining(names));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.resolve('fittings/seed/mcp-gateway/scripts/gateway.mjs'), 'stdio'],
      env: { ...process.env, GARRISON_HOME: app.home, GARRISON_COMPOSITION_DIR: app.root, GARRISON_APP_URL: app.base, GARRISON_MCP_TOOLS: names.join(',') } }));
    expect((await client.listTools()).tools.map((t: any) => t.name).sort()).toEqual([...names].sort());
    const response = await client.callTool({ name: names[0], arguments: { query: 'certidao Example Orchard' } });
    const hit = JSON.parse(response.content[0].text).hits[0];
    const read = await client.callTool({ name: names[1], arguments: { path: hit.path, kind: hit.kind } });
    expect(read.isError).not.toBe(true);
    expect(read.content[0].text).toContain('FIXTURE-7391-4826');
    expect((await client.callTool({ name: 'garrison_archive_write', arguments: { path: app.source } })).isError).toBe(true);
  } finally { await client.close(); await app.close(); }
}, 20_000);

it('reads notes and unfiled attachment text and returns usable source links',async()=>{
 const app=await agentArchiveFixture(),deps={env:{GARRISON_APP_URL:app.base}};
 try{
  expect(await callArchiveRead({path:'Projects/Garrison/Memory/Architecture.md',kind:'note'},deps)).toMatchObject({url:'/archive/notes?path=Projects%2FGarrison%2FMemory%2FArchitecture.md'});
  const file=await callArchiveRead({path:'Archive/Inbox/sample-document.jpg',kind:'file'},deps);
  expect(file.markdown).toContain('TEST-48392017');expect(file.url).toBe('/archive/inbox?highlight=Archive%2FInbox%2Fsample-document.jpg');
  await expect(callArchiveRead({path:'Archive/Inbox/sample-document.jpg',kind:'note'},deps)).rejects.toThrow(/kind=file/);
 }finally{await app.close();}
});

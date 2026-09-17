import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
// @ts-expect-error Standalone Node module without declarations.
import { CursorStore, stripCursorToken } from '../packages/talk/src/cursor/store.mjs';
// @ts-expect-error Standalone Node module without declarations.
import { createCursorHttp } from '../packages/talk/src/cursor/http.mjs';
// @ts-expect-error Standalone Node module without declarations.
import { installCursorHooks, uninstallCursorHooks, CURSOR_HOOK_MARKER } from '../scripts/cursor-desktop/install.mjs';
import { groupSessionTurns, presentSessionTurn, sessionActivityBeats } from '../packages/claude-chat/src/journal';
import { mergeCursorRows } from '../packages/talk/ui/cursor-sessions';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-ingest-'));
  cleanup.push(() => fs.rmSync(userHome, { recursive: true, force: true }));
  const home = path.join(userHome, '.garrison');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'internal-token'), 'test-token', { mode: 0o600 });
  const store = new CursorStore({ home, nodeId: 'test-node' });
  return { userHome, home, store };
}
const payload = (event: string, extra = {}) => ({
  hook_event_name: event, node_id: 'test-node', conversation_id: 'chat-one',
  generation_id: '12345678-1234-1234-1234-123456789abc', model: 'test-model',
  workspace_roots: ['/scratch/alpha', '/scratch/beta'], cursor_version: 'test-version',
  received_at: 1, ...extra,
});
async function serverFixture() {
  const fixtureData = fixture();
  const cursor = createCursorHttp({ home: fixtureData.home, nodeId: 'test-node', store: fixtureData.store });
  const server = http.createServer(async (req, res) => { if (!await cursor.handle(req, res, req.url)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { cursor.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (p: unknown, token: string | null = 'test-token', route = '/cursor/hooks/event') => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-garrison-internal': token } : {}) }, body: JSON.stringify(p) });
  return { ...fixtureData, server, cursor, url, post };
}
async function runHook(envFile: string, mode: string, data: unknown) {
  const start = performance.now();
  const child = spawn(process.execPath, [path.resolve('scripts/cursor-desktop/hook.mjs'), mode], { env: { ...process.env, GARRISON_CURSOR_ENV_FILE: envFile } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  child.stdin.end(JSON.stringify(data));
  const [code] = await once(child, 'close');
  return { code, stdout, stderr, elapsed: performance.now() - start };
}

describe('Cursor desktop ingestion', () => {
  it('maps full responses, thought and tools into the shared conversation vocabulary', () => {
    const { store } = fixture();
    store.ingest(payload('sessionStart'));
    store.ingest(payload('beforeSubmitPrompt', { prompt: 'Build the parser [grs:abcd1234]' }));
    store.ingest(payload('afterAgentThought', { text: 'Checking the grammar.' }));
    store.ingest(payload('beforeShellExecution', { command: 'printf done', cwd: '/scratch/alpha' }));
    store.ingest(payload('afterShellExecution', { command: 'printf done', cwd: '/scratch/alpha', output: 'done', duration: 4 }));
    const response = 'Complete response. '.repeat(4000);
    store.ingest(payload('afterAgentResponse', { text: response }));
    store.ingest(payload('stop', { status: 'completed' }));
    const entries = store.entries('chat-one');
    expect(entries.find((e: any) => e.role === 'user')).toMatchObject({ origin: 'desk', blocks: [{ type: 'text', text: 'Build the parser' }] });
    expect(entries.some((e: any) => e.blocks.some((b: any) => b.type === 'thinking'))).toBe(true);
    expect(entries.find((e: any) => e.event === 'assistant.message').blocks[0].text).toBe(response);
    const turns = groupSessionTurns(entries);
    expect(presentSessionTurn(turns.at(-1)!, false).primaryText).toBe(response);
    expect(sessionActivityBeats(turns.at(-1)!.assistantEvents).some(b => b.type === 'status')).toBe(true);
    expect(store.get('chat-one')).toMatchObject({ state: 'released', attached: false, model: 'test-model' });
    expect(store.rows()[0].cursor.state).toBe('released');
  });
  it('deduplicates repeated deliveries and base/suffixed thought generations across restart', () => {
    const { home, store } = fixture();
    const thought = payload('afterAgentThought', { text: 'one thought' });
    store.ingest(thought);
    store.ingest({ ...thought, generation_id: `${thought.generation_id}-second`, received_at: 2 });
    expect(store.entries('chat-one')).toHaveLength(1);
    const reopened = new CursorStore({ home, nodeId: 'test-node' });
    reopened.ingest(thought);
    expect(reopened.entries('chat-one')).toHaveLength(1);
  });
  it('settles the matching tool card even when the completion omits cwd', () => {
    const { store } = fixture();
    store.ingest(payload('beforeShellExecution', { command: 'printf test', cwd: '/scratch/alpha' }));
    store.ingest(payload('afterShellExecution', { command: 'printf test', output: 'test' }));
    expect(store.entries('chat-one')).toHaveLength(1);
    expect(store.entries('chat-one')[0]).toMatchObject({ revision: 1, blocks: [{ status: 'completed', result: 'test', input: { cwd: '/scratch/alpha', command: 'printf test' } }] });
  });
  it('recovers complete UTF-8 journal records and removes only an incomplete tail', () => {
    const { home, store } = fixture();
    store.ingest(payload('beforeSubmitPrompt', { prompt: 'Olá 🌿' }));
    const file = path.join(store.root, fs.readdirSync(store.root)[0]);
    const valid = fs.readFileSync(file);
    fs.appendFileSync(file, '{"partial":');
    const recovered = new CursorStore({ home, nodeId: 'test-node' });
    expect(recovered.entries('chat-one')[0].blocks[0].text).toBe('Olá 🌿');
    expect(fs.readFileSync(file)).toEqual(valid);
  });
  it.each(['sessionEnd', 'stop'])('settles %s without leaving Working', event => {
    const { store } = fixture(); store.ingest(payload('beforeSubmitPrompt', { prompt: 'test' }));
    expect(store.get('chat-one').state).toBe('working');
    store.ingest(payload(event, { status: 'aborted' }));
    expect(store.get('chat-one').state).toBe(event === 'sessionEnd' ? 'ended' : 'released');
  });
  it('strips only a trailing eight-character display token', () => {
    expect(stripCursorToken('Keep [grs:abcd1234] inside')).toBe('Keep [grs:abcd1234] inside');
    expect(stripCursorToken('Text [grs:abcd1234]')).toBe('Text');
    expect(stripCursorToken('Text [grs:short]')).toBe('Text [grs:short]');
  });
  it('prefers the live row over the historical identity on the same node only', () => {
    const { store } = fixture(); store.ingest(payload('sessionStart'));
    const live = store.rows()[0];
    const rows = mergeCursorRows([{ ...live, cursor: undefined, statusSource: 'history' }, { ...live, node: 'peer' }], [live]);
    expect(rows).toHaveLength(2); expect(rows[0].statusSource).toBe('cursor-hooks');
  });
  it('requires the token and correct owning node, then acknowledges a hook in under 200 ms', async () => {
    const { post, store } = await serverFixture();
    expect((await post(payload('sessionStart'), null)).status).toBe(401);
    expect((await post(payload('sessionStart'), 'wrong')).status).toBe(401);
    expect((await post(payload('sessionStart', { node_id: 'peer' }))).status).toBe(400);
    expect(store.rows()).toHaveLength(0);
    const start = performance.now(); const result = await post(payload('sessionStart'));
    expect(await result.json()).toEqual({ ok: true });
    expect(performance.now() - start).toBeLessThan(200);
  });
  it('replays the captured event field shapes through the authenticated endpoint', async () => {
    const { post, store } = await serverFixture();
    const events = ['sessionStart', 'beforeSubmitPrompt', 'afterAgentThought', 'beforeReadFile', 'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'afterMCPExecution', 'preToolUse', 'postToolUse', 'afterFileEdit', 'afterAgentResponse', 'stop', 'sessionEnd'];
    for (const event of events) {
      const result = await post(payload(event, { prompt: 'Synthetic prompt', text: 'Synthetic response', command: 'printf test', output: 'test', file_path: '/scratch/alpha/probe.txt', edits: [], tool_name: 'read', mcp_server_name: 'local', tool_input: { path: '/scratch/alpha/probe.txt' }, result_json: { text: 'test' } }));
      expect(result.status).toBe(200);
    }
    const kinds = store.entries('chat-one').map((e: any) => e.event);
    for (const kind of ['session.started', 'user.message', 'assistant.thought', 'assistant.message', 'tool.call.started', 'tool.call.completed', 'session.released', 'session.ended']) expect(kinds).toContain(kind);
    expect(store.get('chat-one').state).toBe('ended');
  });
  it('publishes a live row over the existing SSE channel without waiting for an index timer', async () => {
    const { url, post } = await serverFixture();
    const abort = new AbortController(); cleanup.push(() => abort.abort());
    const response = await fetch(url + '/cursor/events', { headers: { 'x-garrison-internal': 'test-token' }, signal: abort.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"rows":[]');
    await post(payload('beforeSubmitPrompt', { prompt: 'live prompt' }));
    const change = new TextDecoder().decode((await reader.read()).value);
    expect(change).toContain('live prompt'); expect(change).toContain('"state":"working"');
    await reader.cancel();
  });
  it('installs idempotently, preserves foreign gates and uninstalls only owned entries', () => {
    const { userHome, home } = fixture();
    fs.mkdirSync(path.join(userHome, '.cursor'));
    const file = path.join(userHome, '.cursor', 'hooks.json');
    const foreign = { command: 'foreign', failClosed: true, timeout: 9 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, extra: true, hooks: { stop: [foreign] } }));
    const args = { userHome, home, nodeId: 'test-node', nodeUrl: 'http://127.0.0.1:8098' };
    const result = installCursorHooks(args);
    const first = fs.readFileSync(file, 'utf8'); installCursorHooks(args);
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
    expect(fs.statSync(result.envFile).mode & 0o777).toBe(0o600);
    const hooks = JSON.parse(first);
    expect(hooks.hooks.stop[0]).toEqual(foreign);
    expect(hooks.hooks.stop[1]).toMatchObject({ _garrison: CURSOR_HOOK_MARKER, failClosed: false, loop_limit: null, timeout: 30000 });
    uninstallCursorHooks({ userHome, home });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, extra: true, hooks: { stop: [foreign] } });
  });
  it('delivers the raw payload unchanged with local metadata and returns the allow shape', async () => {
    const { home, userHome, url, store } = await serverFixture();
    const installed = installCursorHooks({ userHome, home, nodeId: 'test-node', nodeUrl: url });
    const result = await runHook(installed.envFile, 'event', payload('beforeSubmitPrompt', { prompt: 'from hook' }));
    expect(result).toMatchObject({ code: 0, stdout: '{"continue":true}\n', stderr: '' });
    expect(store.get('chat-one').state).toBe('working');
    expect(result.elapsed).toBeLessThan(2000);
  });
  it('fails open within two seconds when the server accepts but never answers', async () => {
    const { home, userHome } = fixture();
    const server = http.createServer(() => {}); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const installed = installCursorHooks({ userHome, home, nodeId: 'test-node', nodeUrl: `http://127.0.0.1:${(server.address() as any).port}` });
    const result = await runHook(installed.envFile, 'stop', payload('stop'));
    expect(result).toMatchObject({ code: 0, stdout: '{}\n', stderr: '' });
    expect(result.elapsed).toBeLessThan(2000);
  });
  it('refuses a non-loopback node URL before sending a payload', async () => {
    const { home } = fixture();
    const file = path.join(home, 'cursor-hook.env');
    fs.writeFileSync(file, 'GARRISON_CURSOR_URL=http://192.0.2.1:8098\nGARRISON_CURSOR_TOKEN=test\nGARRISON_CURSOR_NODE_ID=test-node\n', { mode: 0o600 });
    const result = await runHook(file, 'event', payload('beforeSubmitPrompt'));
    expect(result.stdout).toBe('{}\n'); expect(result.elapsed).toBeLessThan(2000);
  });
});

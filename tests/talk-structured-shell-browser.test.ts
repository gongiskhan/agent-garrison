import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, webkit, type Browser } from 'playwright';

let browser: Browser;
let bundle: string;
const events = [
  { id: 'question', role: 'user', blocks: [{ type: 'text', text: 'Check the build status.' }] },
  { id: 'call', role: 'assistant', blocks: [{ type: 'tool_use', toolUseId: 'bash-1', name: 'Bash', input: '{"command":"echo status"}' }] },
  { id: 'result', role: 'user', toolResultsOnly: true, blocks: [{ type: 'tool_result', toolUseId: 'bash-1', text: 'at 14:49: 15 prompts', isError: false }] },
  { id: 'answer', role: 'assistant', blocks: [{ type: 'text', text: 'The build completed.' }] },
];
beforeAll(async () => {
  const built = await build({ stdin: { sourcefile: 'structured-shell-fixture.tsx', resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ExternalSessionView} from './packages/talk/ui/session-view';
    import {ShellPanel} from './packages/talk/ui/shell-panel';
    import {SessionsRail} from './packages/talk/ui/sessions-rail';
    const root = createRoot(document.getElementById('root'));
    window.mount = (mode, props) => root.render(mode === 'native' ? <ExternalSessionView {...props}/> : mode === 'shell' ? <ShellPanel {...props}/> : <SessionsRail {...props} onSelect={()=>{}} onToggleList={()=>{}} onNewLocal={()=>{}} onOpenRemote={()=>{}} onOpenRemoteShell={()=>{}} onDeleteLocal={()=>{}} onRenameLocal={()=>{}} />);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); });

async function fixture(target = browser, mobile = false, sidebar: object = {}) {
  const context = await target.newContext({ viewport: mobile ? { width: 393, height: 852 } : { width: 1280, height: 900 } });
  const page = await context.newPage();
  let failed = false;
  const inputs: unknown[] = [];
  let sockets = 0;
  let streamFailures = 0;
  let streamReads = 0;
  await page.route('http://talk.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width,initial-scale=1"><div class="talk-host"><div class="wc-shell wc-shell--compact"><div id="root" style="height:100dvh;display:flex;flex-direction:column;min-width:0"></div></div></div>' });
    if (url.pathname === '/api/sidebar') return route.fulfill({ json: { groups: [], archived: [], membership: {}, order: {}, read: {}, ...sidebar } });
    if (url.pathname === '/stream') {
      streamReads++;
      if (streamFailures-- > 0) return route.fulfill({status:502,body:'Temporary owner failure'});
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({type:'init', available:true, live:false, events})}\n\ndata: {"type":"end"}\n\n` });
    }
    if (url.pathname.endsWith('/input')) {
      inputs.push(route.request().postDataJSON());
      return route.fulfill({ status: failed ? 502 : 200, json: failed ? {error:'Shell temporarily unavailable'} : {ok:true} });
    }
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket('ws://talk.test/io', ws => {
    sockets++;
    ws.onMessage(message => {
      const init = JSON.parse(String(message));
      if (init.type === 'init') {
        ws.send(JSON.stringify({type:'init_ack', tmux:true, state:'idle'}));
        ws.send('Existing shell output\r\n');
      }
    });
  });
  await page.goto('http://talk.test/');
  await page.addStyleTag({ content: ['body{margin:0}', ...['packages/claude-chat/src/claude-chat.css', 'packages/talk/ui/styles.css', 'node_modules/@xterm/xterm/css/xterm.css'].map(file => readFileSync(path.resolve(file), 'utf8'))].join('\n') });
  await page.addScriptTag({ content: bundle });
  return { page, context, inputs, fail: (value: boolean) => { failed = value; }, sockets: () => sockets, streamReads: () => streamReads, failStreams: (n: number) => { streamFailures = n; } };
}

it.each(['chromium', 'webkit'])('renders human prompts and collapsed tools in the native conversation on %s', async engine => {
  const target = engine === 'webkit' ? await webkit.launch({headless:true}) : browser;
  const f = await fixture(target, true);
  try {
    await f.page.evaluate(() => (window as any).mount('native', { row: {id:'native-one', node:'mini', runtime:'claude', kind:'cli', status:'idle', title:'Build check'}, streamUrl:'/stream' }));
    await expect.poll(() => f.page.locator('.cc-session-turn.user').count()).toBe(1);
    expect(await f.page.locator('.cc-session-turn.user').textContent()).toContain('Check the build status.');
    expect(await f.page.locator('.cc-session-turn.user').textContent()).not.toContain('15 prompts');
    expect(await f.page.getByText('The build completed.', {exact:true}).isVisible()).toBe(true);
    // Expand existing activity disclosures until the tool result can be read.
    expect(await f.page.getByText('at 14:49: 15 prompts', {exact:true}).isVisible()).toBe(false);
    await f.page.locator('.wc-sess-conversation details').evaluateAll(nodes => nodes.forEach(node => (node as HTMLDetailsElement).open = true));
    await expect.poll(() => f.page.getByText('at 14:49: 15 prompts', {exact:true}).isVisible()).toBe(true);
    expect(await f.page.locator('.xterm').count()).toBe(0);
    await f.page.getByRole('button', {name:'Plain output',exact:true}).click();
    await expect.poll(() => f.page.locator('.xterm-rows').textContent()).toContain('TOOL OUTPUT');
    await f.page.getByRole('button', {name:'Conversation view',exact:true}).click();
    await expect.poll(() => f.page.locator('.cc-session-turn.user').count()).toBe(1);
    expect(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  } finally { await f.context.close(); if (target !== browser) await target.close(); }
}, 30_000);

it('sends prompts to the existing shell while its terminal is hidden, keeps the socket on toggle, and retains a failed draft', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => (window as any).mount('shell', {threadId:'owned-thread', title:'Build check', binding:{node:'mini', transport:'local', tmuxSession:'owned', sessionId:'existing'}, origin:'http://talk.test', streamUrl:'/stream', originError:null, onRetryOrigin:()=>{}}));
    await expect.poll(f.sockets).toBe(1);
    await expect.poll(() => f.page.locator('.cc-session-turn.user').count()).toBe(1);
    expect(await f.page.locator('.wc-shell-terminal').isVisible()).toBe(false);
    await f.page.getByRole('button', {name:'Show shell',exact:true}).click();
    expect(await f.page.locator('.wc-shell-terminal').isVisible()).toBe(true);
    await f.page.getByRole('button', {name:'Hide shell',exact:true}).click();
    expect(f.sockets()).toBe(1);
    const input = f.page.getByTestId('wb-composer-input');
    await input.fill('Please summarize the build.');
    f.fail(true);
    await f.page.getByTestId('wb-composer-send').click();
    await expect.poll(() => f.page.getByRole('alert').textContent()).toContain('Shell temporarily unavailable');
    expect(await input.inputValue()).toBe('Please summarize the build.');
    f.fail(false);
    await f.page.getByTestId('wb-composer-send').click();
    await expect.poll(() => input.inputValue()).toBe('');
    expect(f.inputs).toEqual([{text:'Please summarize the build.'},{text:'Please summarize the build.'}]);
    expect(f.sockets()).toBe(1);
  } finally { await f.context.close(); }
}, 30_000);

it('hides all running and selected rows in collapsed groups except Zeca and remembers machine collapse', async () => {
  const f = await fixture(browser, false, {groups:[{id:'work',name:'Work',collapsed:true}],membership:{'local:grouped':'work'},ungroupedCollapsed:true});
  try {
    const now = new Date().toISOString();
    const props = {self:{node:'pro'}, meshNodes:[], transports:[], listOpen:true, pinnedId:'zeca', activeId:'selected', activeSessionId:'native',
      threads:[{id:'zeca',title:'Zeca',source:'zeca'},{id:'grouped',title:'Grouped running',runningSince:now},{id:'selected',title:'Selected running',runningSince:now}],
      sessions:[{id:'native',node:'mini',runtime:'claude',kind:'cli',title:'Native running',status:'working',lastActivityAt:now}],
    };
    await f.page.evaluate(() => localStorage.setItem('wc.sessions.collapsed.v2','1'));
    await f.page.evaluate(props => (window as any).mount('rail', props), props);
    await expect.poll(() => f.page.locator('.wc-thread').count()).toBe(1);
    expect(await f.page.getByTestId('wc-pinned').textContent()).toContain('Zeca');
    expect(await f.page.getByRole('status', {name:'Running in Work'}).count()).toBe(1);
    expect(await f.page.getByRole('status', {name:'Running in Ungrouped'}).count()).toBe(1);
    await f.page.getByTestId('rail-sessions-toggle').click();
    await expect.poll(() => f.page.locator('[data-key^="session:"]').count()).toBe(1);
    const node = f.page.getByTestId('rail-node-mini');
    await node.click();
    expect(await node.getAttribute('aria-expanded')).toBe('false');
    expect(await f.page.locator('[data-key^="session:"]').count()).toBe(0);
    expect(await node.getByRole('status').count()).toBe(1);
    expect(await f.page.evaluate(() => JSON.parse(localStorage.getItem('wc.sessions.nodes.collapsed.v1')!))).toEqual(['mini']);
    await f.page.evaluate(props => (window as any).mount('rail', {...props, sessions:[{...props.sessions[0],lastActivityAt:new Date().toISOString()}]}),props);
    expect(await f.page.locator('[data-key^="session:"]').count()).toBe(0);
    await node.click();
    expect(await f.page.locator('[data-key^="session:"]').count()).toBe(1);
  } finally { await f.context.close(); }
}, 30_000);

 it('recovers idle native output after CLOSED HTTP failures without reopening a completed stream', async () => {
  const f = await fixture();
  try {
    f.failStreams(2);
    await f.page.clock.install();
    await f.page.evaluate(() => (window as any).mount('native', {row:{id:'idle',node:'pro',runtime:'claude',kind:'cli',status:'idle'},streamUrl:'/stream'}));
    await expect.poll(f.streamReads).toBe(1);
    await expect.poll(() => f.page.locator('.cc-session-head').textContent()).toContain('transcript unavailable');
    await f.page.clock.fastForward(1000);
    await expect.poll(f.streamReads).toBe(2);
    await expect.poll(() => f.page.locator('.cc-session-head').textContent()).toContain('transcript unavailable');
    await f.page.clock.fastForward(2000);
    await expect.poll(() => f.page.locator('.cc-session-turn.user').count()).toBe(1);
    await f.page.clock.fastForward(20000);
    expect(f.streamReads()).toBe(3);
  } finally { await f.context.close(); }
}, 30_000);

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
    import {NewShellModal} from './packages/talk/ui/new-shell-modal';
    import {SessionsRail} from './packages/talk/ui/sessions-rail';
    const root = createRoot(document.getElementById('root'));
    window.mount = (mode, props) => root.render(mode === 'new' ? <NewShellModal {...props}/> : mode === 'native' ? <ExternalSessionView {...props}/> : mode === 'shell' ? <ShellPanel {...props}/> : <SessionsRail {...props} onSelect={()=>{}} onToggleList={()=>{}} onNewLocal={()=>{}} onOpenRemote={()=>{}} onOpenRemoteShell={()=>{}} onDeleteLocal={()=>{}} onRenameLocal={()=>{}} />);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' });
  bundle = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); });

it('retries a remote Cursor launch through the current node with the same request identity',async()=>{
  const f=await fixture(); const launches:any[]=[];
  try {
    await f.page.route('**/api/mesh/nodes/mini/remote-shell/**',async r=>{
      const u=new URL(r.request().url());
      if(u.pathname.endsWith('/runtimes')) return r.fulfill({json:{runtimes:[{id:'cursor',label:'Cursor',available:true}]}});
      if(u.pathname.endsWith('/projects')) return r.fulfill({json:{projects:[]}});
      launches.push(r.request().postDataJSON());
      return r.fulfill(launches.length===1 ? {status:504,json:{error:'signal timed out'}} : {json:{session:{id:'same-shell',tmuxSession:'retry-shell'}}});
    });
    await f.page.evaluate(()=>(window as any).mount('new',{self:{node:'madrid',shellOrigin:'https://madrid.test'},nodes:[{node:'mini',shellOrigin:'https://mini.test'}],initialNode:'mini',onClose:()=>{},onStarted:(x:any)=>{(window as any).started=x;}}));
    await f.page.getByRole('button',{name:'mini',exact:true}).click();
    await f.page.getByRole('button',{name:'Cursor',exact:true}).click();
    await f.page.getByPlaceholder('~/dev/my-project').fill('~/dev/indy-api');
    await f.page.getByRole('button',{name:'Start',exact:true}).click();
    await expect.poll(()=>f.page.locator('[role="dialog"]').textContent()).toContain('not answering');
    await f.page.getByRole('button',{name:'Start',exact:true}).click();
    await expect.poll(()=>f.page.evaluate(()=>(window as any).started?.session.id)).toBe('same-shell');
    expect(launches).toHaveLength(2);
    expect(launches[0]).toMatchObject({runtime:'cursor',cwd:'~/dev/indy-api',transport:'local'});
    expect(launches[0].requestId).toBe(launches[1].requestId);
  }finally{await f.context.close();}
});

it('keeps an editable composer on a busy attachable Dev Env session',async()=>{
  const f=await fixture();
  try {
    await f.page.evaluate(() => {
      (window as any).sent=[];
      (window as any).mount('native',{row:{id:'native-dev-env',node:'mini',runtime:'claude',kind:'cli',status:'working',attachable:true,terminalRef:'native-dev-env'},streamUrl:'/stream',onContinue:()=>{},onSend:async(text:string)=>{(window as any).sent.push(text);}});
    });
    await f.page.getByTestId('wb-composer-input').fill('First line\nSecond line');
    await f.page.getByTestId('wb-composer-send').click();
    await expect.poll(()=>f.page.evaluate(()=>(window as any).sent)).toEqual(['First line\nSecond line']);
    expect(await f.page.getByRole('button',{name:'Open existing terminal'}).isEnabled()).toBe(true);
  }finally{await f.context.close();}
});

it('queues a message while the original client is busy and sends it once when idle',async()=>{
  const f=await fixture();
  try {
    await f.page.evaluate(() => {
      (window as any).sent=[];
      (window as any).props={row:{id:'busy-native',node:'mini',runtime:'codex',kind:'cli',status:'working',resumable:true},streamUrl:'/stream',onSend:async(text:string)=>{(window as any).sent.push(text);}};
      (window as any).mount('native',(window as any).props);
    });
    await f.page.getByTestId('wb-composer-input').fill('Check the result after this turn.');
    await f.page.getByRole('button',{name:'Queue message'}).click();
    expect(await f.page.getByText('Message queued',{exact:true}).isVisible()).toBe(true);
    expect(await f.page.evaluate(()=>(window as any).sent)).toEqual([]);
    await f.page.evaluate(()=>{const p=(window as any).props;p.row={...p.row,status:'idle'};(window as any).mount('native',p);});
    await expect.poll(()=>f.page.evaluate(()=>(window as any).sent)).toEqual(['Check the result after this turn.']);
  }finally{await f.context.close();}
});

it('uses the same-origin terminal and input when the direct WebSocket fails',async()=>{
  const f=await fixture();const raw:string[]=[];
  try {
    await f.page.routeWebSocket('ws://unavailable.test/io',ws=>ws.close());
    await f.page.route('**/sessions/existing/screen?*',r=>r.fulfill({json:{text:'Recovered terminal\n',state:'idle'}}));
    await f.page.route('**/sessions/existing/bytes',r=>{raw.push(r.request().postDataJSON().data);return r.fulfill({json:{ok:true}});});
    await f.page.evaluate(() => (window as any).mount('shell',{threadId:'fallback',title:'Remote',binding:{node:'mini',transport:'local',sessionId:'existing'},origin:'http://unavailable.test',controlBase:'/api/mesh/nodes/mini/remote-shell',originError:null,onRetryOrigin:()=>{}}));
    // The production pane builds /io from the supplied origin; force that
    // direct socket to close while the ordinary Garrison API remains alive.
    await expect.poll(()=>f.page.locator('.xterm-rows').textContent(),{timeout:12000}).toContain('Recovered terminal');
    await f.page.locator('.xterm-helper-textarea').focus();
    await f.page.keyboard.type('hello');
    await f.page.keyboard.press('Enter');
    await expect.poll(()=>raw.join('')).toContain('hello\r');
    await f.page.getByTestId('wb-composer-input').fill('Send through Garrison');
    await f.page.getByTestId('wb-composer-send').click();
    await expect.poll(()=>f.inputs).toEqual([{text:'Send through Garrison'}]);
  }finally{await f.context.close();}
},20000);

async function fixture(target = browser, mobile = false, sidebar: object = {}) {
  const context = await target.newContext({ hasTouch: mobile, viewport: mobile ? { width: 393, height: 852 } : { width: 1280, height: 900 } });
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
    await expect.poll(() => f.page.locator('.cc-session-turn.user').count(), { timeout: 5000 }).toBe(1);
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
    await expect.poll(() => f.page.locator('.cc-session-turn.user').count(), { timeout: 5000 }).toBe(1);
    expect(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  } finally { await f.context.close(); if (target !== browser) await target.close(); }
}, 30_000);

it('sends prompts to the existing shell while its terminal is hidden, keeps the socket on toggle, and retains a failed draft', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => (window as any).mount('shell', {threadId:'owned-thread', title:'Build check', binding:{node:'mini', transport:'local', tmuxSession:'owned', sessionId:'existing'}, origin:'http://talk.test', streamUrl:'/stream', originError:null, onRetryOrigin:()=>{}}));
    await expect.poll(f.sockets).toBe(1);
    await expect.poll(() => f.page.locator('.cc-session-turn.user').count(), { timeout: 5000 }).toBe(1);
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
    await expect.poll(() => f.page.locator('.cc-session-turn.user').count(), { timeout: 5000 }).toBe(1);
    await f.page.clock.fastForward(20000);
    expect(f.streamReads()).toBe(3);
  } finally { await f.context.close(); }
}, 30_000);

it('offers a real shell for a busy Cursor IDE on mobile and shows failures beside that session', async () => {
  const target=await webkit.launch({headless:true});
  const f=await fixture(target,true);
  try {
    await f.page.evaluate(() => (window as any).mount('native',{row:{id:'cursor',node:'mini',runtime:'cursor',kind:'desktop',status:'working',cwd:'/projects/work',title:'Client workspace',resumable:false},streamUrl:'/stream',onOpenShell:()=>{(window as any).opened=true;},error:'The shell could not connect.'}));
    const open=f.page.getByTestId('sess-open-shell');
    expect(await open.isEnabled()).toBe(true);
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await open.tap();
    expect(await f.page.evaluate(()=>(window as any).opened)).toBe(true);
    expect(await f.page.getByRole('status').textContent()).toContain('The shell could not connect.');
    await f.page.evaluate(() => (window as any).mount('shell',{threadId:'phone',title:'Shell',binding:{node:'mini',transport:'local',sessionId:'existing'},origin:'http://talk.test',originError:null,onRetryOrigin:()=>{}}));
    await expect.poll(f.sockets).toBe(1);
    await expect.poll(()=>f.page.locator('.xterm-rows').textContent()).toContain('Existing shell output');
    await f.page.getByTestId('wb-composer-input').fill('printf MOBILE_SHELL_OK');
    await f.page.getByTestId('wb-composer-send').tap();
    await expect.poll(()=>f.inputs).toEqual([{text:'printf MOBILE_SHELL_OK'}]);
    expect(await f.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  } finally {await f.context.close();await target.close();}
},30_000);

it('grays disconnected owners, stops every aggregate spinner, and restores the same rows on reconnect', async()=>{
  const f=await fixture(browser,false,{ungroupedCollapsed:false});
  f.page.setDefaultTimeout(5000);
  try {
    const props={self:{node:'pro',accentColor:'#4a7d5f'},meshNodes:[{node:'mini',accentColor:'#527c91',connection:'connected',threads:[{id:'remote',title:'Remote work',runningSince:new Date().toISOString()}]}],nodeConnections:{mini:'connected'},transports:[],listOpen:true,
      threads:[{id:'owned',title:'Owned shell',shell:{node:'mini'},runningSince:new Date().toISOString()}],
      sessions:[{id:'cursor',node:'mini',nodeAccent:'#527c91',runtime:'cursor',kind:'desktop',title:'Cursor work',status:'working',connection:'connected'}]};
    await f.page.evaluate(p=>(window as any).mount('rail',p),props);
    await expect.poll(()=>f.page.locator('.wc-thread-spinner').count()).toBeGreaterThan(0);
    await f.page.evaluate(p=>(window as any).mount('rail',{...p,nodeConnections:{mini:'disconnected'},meshNodes:p.meshNodes.map(n=>({...n,connection:'disconnected'})),sessions:p.sessions.map(s=>({...s,connection:'disconnected'}))}),props);
    await expect.poll(()=>f.page.locator('.wc-thread-spinner').count()).toBe(0);
    expect(await f.page.locator('[data-key="session:mini:cursor"] .wc-row-dot').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(129, 135, 130)');
    expect(await f.page.locator('.wc-thread:has(button[title="Owned shell"]) .wc-row-dot').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(129, 135, 130)');
    expect(await f.page.getByText('Cursor work',{exact:true}).isVisible()).toBe(true);
    await f.page.evaluate(p=>(window as any).mount('rail',p),props);
    await expect.poll(()=>f.page.locator('[data-key="session:mini:cursor"] .wc-thread-spinner').count()).toBe(1);
    await f.page.evaluate(()=> (window as any).mount('native',{row:{id:'cursor',node:'mini',runtime:'cursor',status:'working',connection:'disconnected'},streamUrl:'/stream',onOpenShell:()=>{}}));
    expect(await f.page.getByTestId('sess-open-shell').isEnabled()).toBe(false);
    expect(await f.page.getByRole('status').textContent()).toContain("Can't connect to mini");
  }finally {await f.context.close();}
},30_000);

it('loads owner usage only on demand while the shell composer stays usable',async()=>{
  const f=await fixture();let reads=0;
  try {
    await f.page.route('http://talk.test/api/mesh/nodes/mini/session-usage/codex',route=>{reads++;return route.fulfill({json:{accounts:[{provider:'codex',account:'Machine login',status:'available',windows:[{label:'Weekly',usedPercent:42,resetsAt:null}],checkedAt:null}]}});});
    await f.page.evaluate(()=>(window as any).mount('shell',{threadId:'usage',title:'Shell',binding:{node:'mini',transport:'local',sessionId:'existing',runtime:'codex'},origin:'http://talk.test',originError:null,onRetryOrigin:()=>{},usageBase:'/api/mesh/nodes/mini'}));
    expect(reads).toBe(0);
    await f.page.getByLabel('Account usage',{exact:true}).click();
    await expect.poll(()=>f.page.getByText('42% used').isVisible()).toBe(true);
    expect(reads).toBe(1);
    await f.page.getByTestId('wb-composer-input').fill('Please summarize.');
    await f.page.getByTestId('wb-composer-send').click();
    expect(f.inputs).toEqual([{text:'Please summarize.'}]);
    await expect.poll(()=>f.page.locator('.wc-usage-panel').count()).toBe(0);
  }finally{await f.context.close();}
},30_000);


it('lets a phone dismiss usage by touch, including its visible Close button',async()=>{
  const target=await webkit.launch({headless:true});const f=await fixture(target,true);
  try {
    await f.page.evaluate(()=>(window as any).mount('native',{row:{id:'native',node:'pro',runtime:'codex',status:'idle',title:'Session title'},streamUrl:'/stream',usageBase:'/api'}));
    await f.page.locator('.wc-usage summary').tap();
    await f.page.getByRole('button',{name:'Close account usage',exact:true}).tap();
    await expect.poll(()=>f.page.locator('.wc-usage-panel').count()).toBe(0);
    await f.page.locator('.wc-usage summary').tap();
    await f.page.getByTestId('sess-head').tap({position:{x:100,y:10}});
    await expect.poll(()=>f.page.locator('.wc-usage-panel').count()).toBe(0);
  }finally{await f.context.close();await target.close();}
},30_000);

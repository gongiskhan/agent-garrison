import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

let browser: Browser;
let server: http.Server;
let base: string;
const evidence = path.resolve('test-results/cursor-desktop');
beforeAll(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const built = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ExternalSessionView } from './packages/talk/ui/session-view';
    const row = { id:'test-chat', node:'indy', nodeAccent:'#527c91', nodeStatus:'online', connection:'connected', runtime:'cursor', kind:'desktop', cwd:'/scratch/alpha', project:'Indy workspace', title:'Build the parser', status:'working', statusSource:'cursor-hooks', resumable:false, attachable:false, cursor:{node_id:'indy', conversation_id:'test-chat', model:'auto-smart', state:'working', attached:false, workspace_roots:['/scratch/alpha']} };
    window.__sources=[];
    window.EventSource=class { constructor(url){this.url=url;window.__sources.push(this)} close(){} };
    const root=createRoot(document.getElementById('root'));
    window.renderCursor=(patch={})=>root.render(<div className='wc-app talk-host'><ExternalSessionView row={{...row,...patch,cursor:{...row.cursor,...patch.cursor}}} streamUrl='/cursor-test-stream' /></div>);
    window.renderCursor();
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"test"' } });
  const bundle = built.outputFiles[0].text;
  const css = fs.readFileSync('packages/claude-chat/src/claude-chat.css', 'utf8') + fs.readFileSync('packages/talk/ui/styles.css', 'utf8');
  server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle); }
    else if (req.url === '/host-map') { res.setHeader('Content-Type', 'application/json'); res.end('{"map":{}}'); }
    else { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nhtml,body,#root{margin:0;height:100%;} .wc-app{height:100%;width:100%;} .wc-sess{height:100%;width:100%;}</style><div id="root"></div><script src="/bundle.js"></script>`); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

describe('Cursor conversation at phone size', () => {
  it('renders the shared conversation, header badges, desk origin and Working indicator', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => (window as any).__sources.length > 0);
    await page.evaluate(() => {
      const source = (window as any).__sources.find((s: any) => s.url === '/cursor-test-stream');
      source.onmessage({ data: JSON.stringify({ type:'init', available:true, live:true, events:[
        { id:'user-1', role:'user', ts:1, turnId:'turn-1', origin:'desk', blocks:[{type:'text',text:'Build the parser and add a test.'}] },
        { id:'tool-1', role:'assistant', ts:2, turnId:'turn-1', blocks:[{type:'tool_use',name:'Shell',toolUseId:'tool-1',input:{command:'npm test'},status:'running'}] },
        { id:'text-1', role:'assistant', ts:3, turnId:'turn-1', blocks:[{type:'text',text:'The parser handles empty input. I am checking the new test.'}] }
      ] }) });
    });
    await page.getByText('Build the parser and add a test.', { exact: true }).waitFor();
    const header = page.getByTestId('sess-head');
    for (const text of ['Cursor', 'indy', 'Indy workspace', 'auto-smart', 'Working']) expect(await header.getByText(text, { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText('desk', { exact: true }).isVisible()).toBe(true);
    expect(await page.getByTestId('native-conversation-view').isVisible()).toBe(true);
    expect(await page.locator('.wc-wb-lamp--running').count()).toBe(1);
    await page.screenshot({ path: path.join(evidence, 'p1-phone-conversation.png'), fullPage: true });
    for (const badge of await header.locator('span').all()) {
      const box = await badge.boundingBox();
      if (box) expect(box.x + box.width, (await badge.textContent()) ?? undefined).toBeLessThanOrEqual(391);
    }
    await page.screenshot({ path: path.join(evidence, 'p1-phone-conversation.png'), fullPage: true });
    expect(errors).toEqual([]);
    await page.close();
  });
});

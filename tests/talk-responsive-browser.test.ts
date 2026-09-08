import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const root = path.resolve(__dirname, "..");
const css = ["packages/claude-chat/src/claude-chat.css", "packages/talk/ui/styles.css"]
  .map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
let browser: Browser;
let context: BrowserContext;
let page: Page;
let bundle: string;

beforeAll(async () => {
  const output = await build({
    stdin: { resolveDir: root, sourcefile: "talk-responsive-fixture.tsx", loader: "tsx", contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { SessionsRail } from './packages/talk/ui/sessions-rail';
      import { useConversationLayout } from './packages/talk/ui/use-conversation-layout';
      import { ConversationView } from './packages/claude-chat/src/ConversationView';
      const threads = [
        {id:'zeca',title:'Zeca',source:'chat',updatedAt:null},
        {id:'plan',title:'Migration plan',source:'chat',updatedAt:'2026-09-06T09:00:00Z'},
        {id:'phone',title:'Phone layout',source:'chat',updatedAt:'2026-09-05T09:00:00Z'},
      ];
      const sessions = [
        {id:'old',title:'Old shell',project:'website',node:'dev-madrid',runtime:'claude',status:'idle'},
        {id:'working',title:'Current review',project:'garrison',node:'dev-madrid',runtime:'codex',status:'working'},
      ];
      const transport = {connect(fn){fn({type:'connection',state:'open'});return()=>{};},async sendMessage(){},async sendKey(){},async sendCommand(){},async fetchCommands(){return [];},async setMode(mode){return {mode,reached:true};},async interrupt(){}};
      function App() {
        const [open,setOpen] = React.useState(false);
        const [active,setActive] = React.useState('zeca');
        const close = React.useCallback(()=>setOpen(false),[]);
        const layout = useConversationLayout(open,close);
        return <div style={{width:'calc(100% - 260px)',height:'100dvh',marginLeft:260}} id="host" className="talk-host">
          <div ref={layout.shellRef} className={'wc-shell'+(layout.compact?' wc-shell--compact':'')+(open?' wc-shell--open':'')}>
            <aside ref={layout.sidebarRef} id={layout.sidebarId} className="wc-sidebar" aria-label="Conversations">
              <SessionsRail threads={threads} pinnedId="zeca" meshNodes={[]} self={{node:'dev-madrid',accentColor:null}} transports={[]}
                activeId={active} listOpen onToggleList={()=>{}} onNewLocal={()=>{}} onSelect={id=>{setActive(id);close();}}
                onOpenRemote={()=>{}} onOpenRemoteShell={()=>{}} onDeleteLocal={()=>{}} onRenameLocal={async()=>{}}
                sessions={sessions} onClose={close}/>
            </aside>
            <div className="wc-sidebar-scrim" onClick={close}/>
            <main ref={layout.mainRef} className="wc-main">
              <ConversationView key={active} conversationId={active} title={threads.find(t=>t.id===active).title} transport={transport}
                draftKey={active} placeholder="Write a message…" headerLeading={<button className="wc-threads-toggle" aria-label="Show conversations" onClick={()=>setOpen(v=>!v)}>☰</button>}/>
            </main>
          </div>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    ` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  });
  bundle = output.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => { await context?.close(); await browser?.close(); });
beforeEach(async () => {
  await context?.close();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => console.error('Conversations fixture:', error.message));
  await page.route("http://talk.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({contentType:"text/html",body:'<div id="root"></div>'});
    if (url.pathname.endsWith("/stream")) {
      const events = [{id:'long-path-prompt',role:'user',ts:null,blocks:[{type:'text',text:'Inspect /Users/ggomes/dev/garrison/'+'long-project-directory'.repeat(18)+' and describe the result.'}]}];
      return route.fulfill({contentType:"text/event-stream",body:'data: '+JSON.stringify({type:'init',available:true,live:false,events})+'\n\n'});
    }
    return route.fulfill({contentType:"application/json",body:JSON.stringify(url.pathname === '/api/sidebar' ? {groups:[],archived:[],membership:{},order:{},read:{}} : {hits:[]})});
  });
  await page.goto("http://talk.test/");
  await page.addStyleTag({content:'html,body,#root{margin:0;height:100%;}'+css});
  await page.addScriptTag({content:bundle});
  await page.getByPlaceholder("Write a message…").waitFor();
});

describe("Conversations navigation and responsive composer", () => {
  it("keeps Zeca above shells and working sessions visible when idle sessions collapse", async () => {
    const plan = await page.getByRole('button',{name:/^Migration plan/}).boundingBox();
    const shells = await page.getByTestId('rail-section-sessions').boundingBox();
    expect(plan!.y).toBeLessThan(shells!.y);
    await expect.poll(()=>page.getByTestId('rail-sessions-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(await page.getByRole('button',{name:/Old shell/}).isVisible()).toBe(true);
    await page.getByTestId('rail-sessions-toggle').click();
    await expect.poll(()=>page.getByTestId('rail-sessions-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(await page.getByRole('button',{name:/Current review/}).isVisible()).toBe(true);
    expect(await page.getByRole('button',{name:/Old shell/}).count()).toBe(0);
    const pinned = await page.getByTestId('wc-pinned').boundingBox();
    const sessions = await page.getByTestId('rail-section-sessions').boundingBox();
    expect(pinned!.y).toBeLessThan(sessions!.y);
  });

  it("finds conversation names and sessions by project without losing the draft", async () => {
    await page.getByPlaceholder('Write a message…').fill('Keep my draft while I find history');
    const search = page.getByRole('searchbox',{name:'Find conversations and sessions'});
    await search.fill('migration');
    expect(await page.getByRole('button',{name:/^Migration plan/}).isVisible()).toBe(true);
    expect(await page.getByRole('button',{name:/^Phone layout/}).count()).toBe(0);
    await search.fill('website');
    expect(await page.getByRole('button',{name:/Old shell/}).isVisible()).toBe(true);
    await search.fill('no-such-conversation');
    expect(await page.getByRole('status').filter({hasText:'No matches'}).isVisible()).toBe(true);
    await page.getByRole('button',{name:'Clear conversation search'}).click();
    expect(await page.getByPlaceholder('Write a message…').inputValue()).toBe('Keep my draft while I find history');
  });

  it("uses the available pane width and makes its drawer keyboard accessible", async () => {
    // A 1024px laptop/tablet has only 764px after the Garrison sidebar.
    await page.setViewportSize({width:1024,height:768});
    await expect.poll(()=>page.locator('.wc-shell').getAttribute('class')).toContain('wc-shell--compact');
    expect(await page.locator('.wc-sidebar').getAttribute('inert')).not.toBeNull();
    const toggle = page.getByRole('button',{name:'Show conversations'});
    await toggle.click();
    await expect.poll(()=>page.getByRole('searchbox',{name:'Find conversations and sessions'}).evaluate(el=>el===document.activeElement)).toBe(true);
    expect(await page.locator('.wc-main').getAttribute('inert')).not.toBeNull();
    await page.getByRole('searchbox',{name:'Find conversations and sessions'}).press('Escape');
    await expect.poll(()=>page.locator('.wc-sidebar').getAttribute('inert')).not.toBeNull();
    expect(await toggle.evaluate(el=>el===document.activeElement)).toBe(true);
  });

  for (const width of [320,390,768]) it('keeps the composer inside a '+width+'px pane with long input',async()=>{
    await page.setViewportSize({width,height:844});
    await page.locator('#host').evaluate(el=>{(el as HTMLElement).style.width='100%';(el as HTMLElement).style.marginLeft='0';});
    const input = page.getByPlaceholder('Write a message…');
    await input.fill('A long message '.repeat(120));
    const box = await input.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x+box!.width).toBeLessThanOrEqual(width);
    expect(box!.y+box!.height).toBeLessThan(844);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    const longPrompt = page.locator('.cc-session-longtext');
    await longPrompt.waitFor();
    expect(await longPrompt.evaluate(el=>el.scrollWidth)).toBeLessThanOrEqual(await longPrompt.evaluate(el=>el.clientWidth));
    const send = await page.getByRole('button',{name:'Send',exact:true}).boundingBox();
    expect(send!.height).toBeGreaterThanOrEqual(44);
    expect(send!.y+send!.height).toBeLessThanOrEqual(844);
  });
});

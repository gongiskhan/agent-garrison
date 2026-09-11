import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
let browser: Browser, script: string, css: string;
beforeAll(async () => {
  const result = await build({ stdin: { sourcefile: "listening-fixture.tsx", resolveDir: process.cwd(), loader: "tsx", contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ListeningControl,ListeningBadge} from './src/components/capture/ListeningControl';
    const callbacks = {}; window.intents=[]; window.haptics=0;
    const record = {device_id:'test-phone-device',device_name:'iPhone',source:'phone',intent:'off',actual:'off',reason:null,last_seen_at:'2026-09-11T12:00:00Z',intent_changed_at:'2026-09-11T12:00:00Z',actual_changed_at:'2026-09-11T12:00:00Z',stall_episode_id:null,stall_pushes_sent:0,app_version:'1'};
    window.current={device_id:record.device_id,records:[record],paired:false};
    window.Capacitor={isNativePlatform:()=>true,Plugins:{GarrisonCapture:{
      listeningState:async()=>window.current, listeningIntent:async x=>{window.intents.push(x);return window.current},
      haptic:async()=>{window.haptics++},openSettings:async()=>{},
      addListener:async(name,fn)=>{callbacks[name]=fn;return {remove(){}}}
    }}};
    window.state=(actual,reason=null)=>{window.current={...window.current,records:[{...record,actual,intent:actual==='off'?'off':'listening',reason,actual_changed_at:new Date().toISOString()}]};callbacks.listeningState(window.current)};
    createRoot(document.getElementById('root')).render(<><ListeningControl/><ListeningBadge/></>);
  ` }, bundle: true, write: false, outfile: "fixture.js", platform: "browser", format: "iife", jsx: "automatic",
    plugins: [{ name: "fixture-link", setup(b) { b.onResolve({filter:/^next\/link$/}, () => ({path:"link",namespace:"fixture"})); b.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:"import React from 'react';export default function Link(p){return React.createElement('a',p,p.children)}",loader:"js",resolveDir:process.cwd()})); } }] });
  script = result.outputFiles.find(f => f.path.endsWith(".js"))!.text;
  css = result.outputFiles.find(f => f.path.endsWith(".css"))!.text;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); });
async function fixture() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent('<div id="root"></div>'); await page.addStyleTag({content:css}); await page.addScriptTag({content:script});
  await page.getByRole("button",{name:"Start listening",exact:true}).waitFor(); return page;
}
async function state(page: Page, actual: string, reason: string | null = null) {
  await page.evaluate(([a,r]) => (window as any).state(a,r),[actual,reason]);
  await expect.poll(() => page.getByTestId("listening-phone").getAttribute("data-actual")).toBe(actual);
}
it("renders every row and badge state through the native subscription", async () => {
  const page = await fixture();
  try {
    for (const [actual,label,button,badge] of [["off","Not listening","Start listening",null],["starting","Starting","Starting","Paused"],["listening","Listening","Hold to stop","Listening"],["interrupted","Paused by another app","Hold to stop","Paused"],["stalled","Stopped listening","Resume","Stopped"],["failed","Microphone unavailable","Try again","Stopped"]]) {
      await state(page,actual!,actual === "failed" ? "engine_error" : null);
      expect(await page.getByTestId("listening-phone").textContent()).toContain(label);
      expect(await page.getByRole("button",{name:button!,exact:true}).isDisabled()).toBe(actual === "starting");
      expect(await page.getByTestId("listening-badge").count()).toBe(badge ? 1 : 0);
      if (badge) expect(await page.getByTestId("listening-badge").textContent()).toBe(badge);
    }
    await state(page,"failed","permission_denied"); expect(await page.getByRole("button",{name:"Microphone permission is off. Open Settings."}).isVisible()).toBe(true);
  } finally { await page.close(); }
});
it("shows optimistic starting, cancels early hold, haptics once on completion and hides badge after off", async () => {
  const page = await fixture();
  try {
    await page.getByRole("button",{name:"Start listening",exact:true}).click();
    await expect.poll(()=>page.getByTestId("listening-phone").getAttribute("data-actual")).toBe("starting");
    await state(page,"listening");
    const button=page.getByRole("button",{name:"Hold to stop",exact:true});
    await button.click(); expect(await page.getByRole("tooltip").textContent()).toBe("Hold to stop");
    const bounds=(await button.boundingBox())!;
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2); await page.mouse.down(); await page.waitForTimeout(1000); await page.mouse.up();
    expect(await page.evaluate(()=>(window as any).intents)).toEqual([{source:"phone",intent:"listening"}]);
    await page.mouse.down(); await expect.poll(()=>page.evaluate(()=>(window as any).haptics), { timeout: 3000 }).toBe(1); await page.mouse.up();
    expect(await page.evaluate(()=>(window as any).intents)).toEqual([{source:"phone",intent:"listening"},{source:"phone",intent:"off"}]);
    await state(page,"off"); expect(await page.getByTestId("listening-badge").count()).toBe(0);
  } finally { await page.close(); }
});

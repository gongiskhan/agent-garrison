import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { startTalkApp, freePort, scratchHome, type TalkApp } from '../fixtures/talk-app';
import { seed } from './fixtures';
let app:TalkApp;
test.beforeAll(async()=>{app=await startTalkApp({home:scratchHome('messages-settings-'),gatewayUrl:`http://127.0.0.1:${await freePort()}`,port:await freePort()});await fetch(`${app.base}/messages/providers`);});
test.afterAll(async()=>app?.stop());
test('provider health, account labels and settings are usable on the phone and desktop',async({page},info)=>{
  const fixture=seed(),google=fixture.providers.find(p=>p.id==='google')!;
  const whatsapp={...fixture.providers[1],id:'whatsapp-web',label:'WhatsApp',badge:{text:'WhatsApp',color:'#15803d',glyph:'MessageCircle'},accounts:[{id:'self',label:'Personal phone'}],sendReadReceipts:true,lastSync:'2026-09-13T12:00:00.000Z'};
  const slack={...fixture.providers[1],id:'slack',label:'Slack',badge:{text:'Slack',color:'#6b477b',glyph:'Hash'},health:{ok:false,reason:'A temporary connection error'},accounts:[{id:'work',label:'Work workspace'}]};
  const providers=[google,whatsapp,slack],updates:any[]=[],syncs:any[]=[];
  await page.route('**/api/messages**',async route=>{
    const url=new URL(route.request().url()),method=route.request().method();
    if(url.pathname.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
    if(url.pathname.endsWith('/providers'))return route.fulfill({json:{providers}});
    if(method==='POST'&&url.pathname.endsWith('/sync')){syncs.push(route.request().postDataJSON());return route.fulfill({json:{requested:true}});}
    if(method==='POST'&&url.pathname.includes('/providers/')){updates.push({id:url.pathname.split('/').pop(),...route.request().postDataJSON()});return route.fulfill({json:{ok:true}});}
    return route.fulfill({json:{counts:{all:0}}});
  });
  await page.goto(`${app.base}/messages/providers`);await expect(page.getByRole('heading',{name:'Providers',exact:true})).toBeVisible();
  await expect(page.getByText('Needs setup',{exact:true})).toBeVisible();await expect(page.getByText('Connected',{exact:true})).toBeVisible();await expect(page.getByText('Error',{exact:true})).toBeVisible();
  await expect(page.getByTestId('provider-badge')).toHaveCount(3);
  await fs.mkdir('evidence/messages/p7',{recursive:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`evidence/messages/p7/providers-${info.project.name}.png`});
  await page.getByRole('spinbutton',{name:'WhatsApp retention days'}).fill('30');await expect.poll(()=>updates).toContainEqual({id:'whatsapp-web',retentionDays:30});
  await page.getByRole('switch',{name:'WhatsApp send read receipts'}).uncheck();await expect.poll(()=>updates).toContainEqual({id:'whatsapp-web',sendReadReceipts:false});
  await page.getByRole('article',{name:'WhatsApp settings'}).getByRole('button',{name:'Sync now',exact:true}).click();expect(syncs).toEqual([{providers:['whatsapp-web']}]);
  await page.getByRole('status').click();
  await page.getByRole('article',{name:'WhatsApp settings'}).scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`evidence/messages/p7/provider-settings-${info.project.name}.png`});
});

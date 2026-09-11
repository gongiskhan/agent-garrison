import {test,expect,goto,checkpoint} from './fixture';
test('home lists, status, remembered selection and Garrison folders',async({page,app},info)=>{await goto(page,app);await expect(page.getByPlaceholder('Search the Archive')).toBeVisible();await expect(page.locator('.archive-status')).toContainText('fixture-node · synced');const chips=page.locator('.archive-list-chips');await expect(chips.locator('button').first()).toContainText('Inbox');await expect(page.locator('.archive-garrison')).toContainText('Projects');await expect(page.locator('.archive-tile').first()).toBeVisible();await checkpoint(page,info,'home',app);if(info.project.name==='phone'){await chips.getByRole('button',{name:'House',exact:true}).click();await page.reload();await expect(chips.getByRole('button',{name:'House',exact:true})).toHaveClass(/selected/);await expect(page.locator('.archive-column')).toContainText('House maintenance');}});

test('pending reads are cancelled on reload and polling resumes after page restoration',async({page,app})=>{
 await goto(page,app);await expect(page.locator('.archive-status')).toContainText('fixture-node');
 await page.evaluate(()=>{sessionStorage.removeItem('archive.readAborted');const original=window.fetch.bind(window);window.fetch=(input,init)=>{if(String(input).endsWith('/api/archive/status'))init?.signal?.addEventListener('abort',()=>sessionStorage.setItem('archive.readAborted','yes'),{once:true});return original(input,init);};});
 let held=false,requests=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const handler=async(route:any)=>{requests++;if(!held){held=true;await gate;}await route.continue().catch(()=>{});};
 await page.route('**/api/archive/status',handler);
 try{
  await expect.poll(()=>held,{timeout:7000}).toBe(true);await page.reload();
  expect(await page.evaluate(()=>sessionStorage.getItem('archive.readAborted'))).toBe('yes');await expect(page.locator('.archive-status')).toContainText('fixture-node');
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));const stoppedAt=requests;await page.waitForTimeout(3200);expect(requests).toBe(stoppedAt);
  const restored=page.waitForResponse(r=>r.url().endsWith('/api/archive/status')&&r.status()===200);await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await restored;
 }finally{release();await page.unroute('**/api/archive/status',handler);}
});

test('development remounts do not start duplicate initial reads',async({page,app})=>{
 await page.addInitScript(()=>{const original=fetch.bind(window);(window as any).archiveInitialReads=0;window.fetch=(input,init)=>{if(String(input).endsWith('/api/archive/status'))(window as any).archiveInitialReads++;return original(input,init);};});
 await goto(page,app);await expect(page.locator('.archive-status')).toContainText('fixture-node');
 expect(await page.evaluate(()=>(window as any).archiveInitialReads)).toBe(1);
});

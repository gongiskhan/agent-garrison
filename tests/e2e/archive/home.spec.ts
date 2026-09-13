import {test,expect,goto,checkpoint} from './fixture';
test('home shows both areas as folders, with no Inbox and shared display controls',async({page,app},info)=>{
 await goto(page,app);await expect(page.getByPlaceholder('Search the Archive')).toBeVisible();await expect(page.locator('.archive-status')).toContainText('fixture-node · synced');
 const yours=page.locator('.archive-yours .archive-entry strong');await expect(yours).toHaveText(['Finance','House','Personal documents']);
 await expect(page.locator('.archive-garrison')).toContainText('Projects');await expect(page.getByRole('link',{name:'Inbox',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'List view',exact:true})).toHaveAttribute('aria-pressed','true');await checkpoint(page,info,'home',app);
 await page.getByRole('button',{name:'Thumbnail view',exact:true}).click();await page.getByLabel('Sort by').selectOption('updated');await page.reload();
 await expect(page.getByRole('button',{name:'Thumbnail view',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByLabel('Sort by')).toHaveValue('updated');
});

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

test('slow polling requests never overlap and a failed folder request can be retried',async({page,app})=>{
 await goto(page,app);await expect(page.locator('.archive-status')).toContainText('fixture-node');
 let held=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 await page.route('**/api/archive/status',async route=>{held++;await gate;await route.continue().catch(()=>{});});
 try{await expect.poll(()=>held).toBe(1);await page.waitForTimeout(6500);expect(held).toBe(1);}finally{release();await page.unroute('**/api/archive/status');}
 let fail=true;await page.route('**/api/archive/tree?depth=0&path=Memory',async route=>{if(fail){fail=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Temporary fixture read failure'})});}return route.continue();});
 await goto(page,app,'/archive/notes?path=Memory');await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.locator('.archive-entries')).toContainText('Welcome');
});

test('Archive toolbar stays clickable beside the shell controls in light and dark',async({page,app},info)=>{
 await goto(page,app);await expect(page.locator('.archive-yours .archive-entry')).toHaveCount(3);
 const unobstructed=()=>page.locator('.archive-toolbar nav a').evaluateAll(links=>links.every(link=>{const r=link.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!hit&&(hit===link||link.contains(hit));}));
 expect(await unobstructed()).toBe(true);await page.emulateMedia({colorScheme:'dark'});expect(await unobstructed()).toBe(true);
 // WebKit paints native controls separately: dark text colours also require a
 // dark native colour scheme, otherwise the select keeps a white background.
 await expect(page.getByLabel('Sort by')).toHaveCSS('color-scheme','dark');await checkpoint(page,info,'home-dark',app);
});

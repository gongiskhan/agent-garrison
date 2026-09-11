import fs from 'node:fs/promises';import path from 'node:path';
import {test,expect,goto,checkpoint,fixtures,isolateShell} from './fixture';
test.use({video:process.env.ARCHIVE_WALKTHROUGH==='1'?'on':'off'});
test('narrated fixture journey through search, Inbox, real extraction and JSON import',async({page,app,browser},info)=>{
 test.setTimeout(240000);const start=Date.now(),beats:{at:number;text:string}[]=[];
 const narrate=async(text:string)=>{beats.push({at:(Date.now()-start)/1000,text});await page.waitForTimeout(1200);};
 await goto(page,app);await narrate('This is Archive on a phone. Everything in this demonstration is a synthetic fixture. Search covers personal cards and Garrison memory.');
 await checkpoint(page,info,'home',app);await page.getByPlaceholder('Search the Archive').fill('seguro');await page.locator('.archive-result').filter({hasText:'Seguro de saúde'}).click();
 await expect(page.getByRole('button',{name:'Show extracted text'}).first()).toBeVisible();await expect(page.locator('.archive-extracted-content')).toHaveCount(0);
 await narrate('The insurance result opens its card. Sensitive extracted text starts hidden. The recorded demonstration keeps it hidden.');await checkpoint(page,info,'sensitive-collapsed',app);
 // The required sensitive expansion assertion happens in a context with NO
 // video or screenshots. The recorded context remains collapsed throughout.
 const privateContext=await browser.newContext({viewport:{width:390,height:844}});try{
  const p=await privateContext.newPage();await isolateShell(p);await goto(p,app,new URL(page.url()).pathname+new URL(page.url()).search);await p.getByRole('button',{name:'Show extracted text'}).first().click();await expect(p.locator('.archive-extracted-content').first()).toBeVisible();
 }finally{await privateContext.close();}
 await page.goBack();await expect(page.getByPlaceholder('Search the Archive')).toHaveValue('seguro');
 await goto(page,app,'/archive/inbox');await narrate('Inbox collects unfiled uploads. A processed file can become a card, with its title suggested from the document type and holder.');
 await page.getByRole('button',{name:'New card from this',exact:true}).click();await expect(page.getByLabel('Card title')).toHaveValue('Test certificate Alex Example');await page.getByRole('button',{name:'Create card',exact:true}).click();await expect(page.getByRole('heading',{name:'Test certificate Alex Example',exact:true})).toBeVisible();
 const created=new URL(page.url()).searchParams.get('path')!;expect(await fs.stat(path.join(app.vault,created,'sample-document.jpg.md'))).toBeTruthy();
 await narrate('The source file and its sidecar moved together. Now a new sample image is uploaded directly to this card for a real model extraction.');
 const sample=await fs.readFile(path.join(fixtures,'sample-document.jpg')),uploadedAt=Date.now();await page.locator('input[type=file]').first().setInputFiles({name:'walkthrough-document.jpg',mimeType:'image/jpeg',buffer:sample});
 const side=()=>fs.readFile(path.join(app.vault,created,'walkthrough-document.jpg.md'),'utf8').catch(()=>'');await expect.poll(side,{timeout:60000}).toContain('status: ok');expect(Date.now()-uploadedAt).toBeLessThan(60000);expect(await side()).toContain('TEST-48392017');
 await expect(page.locator('.archive-attachment').filter({has:page.getByText('walkthrough-document.jpg',{exact:true})})).toContainText('Processed');
 const found=await(await page.request.get(app.base+'/api/archive/search?q=TEST-48392017')).json();expect(found.hits.some((h:any)=>h.path===created)).toBe(true);await narrate('Processing finished. The fake reference number is now searchable, and the original file remains alongside its regenerable sidecar.');await checkpoint(page,info,'processed',app);
 await goto(page,app,'/archive/import');await page.getByRole('tab',{name:'JSON export'}).click();await page.getByLabel('Trello board export').setInputFiles(path.join(fixtures,'trello-board.json'));await page.getByRole('checkbox',{name:'Include archived cards'}).check();await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.locator('.archive-import-preview')).toContainText('9');await narrate('The Trello JSON preview reports the fixture board before importing. Without credentials, attachments remain links. Existing imported card identifiers are safe to skip on a repeat run.');await checkpoint(page,info,'import-preview',app);
 await page.locator('.archive-import-preview').getByRole('button',{name:'Import',exact:true}).click();await expect(page.getByText('Imported 9 cards into 3 lists.',{exact:false})).toBeVisible();await checkpoint(page,info,'import-done',app);await narrate('Nine fixture cards have been imported into three lists. Open the board returns to the files you can also use in Obsidian.');
 await page.getByRole('link',{name:'Open the board',exact:true}).click();await expect(page.locator('.archive-columns')).toContainText('Personal documents');await page.waitForTimeout(3500);
 await fs.writeFile(info.outputPath('narration.json'),JSON.stringify({startedAt:start,endedAt:Date.now(),beats,fixtureOnly:true,expandedSensitiveRecorded:false},null,2));
});

import {Page,expect} from '@playwright/test';

export async function edit(page:Page,label:string,value:string,project:string){
 if(project==='phone'||project==='mobile'){
  const area=page.getByRole('textbox',{name:label,exact:true});
  await area.fill(value);await expect(area).toHaveValue(value);
 }else{
  const area=page.locator('.archive-monaco').getByRole('textbox',{name:label,exact:true});
  await expect(area).toBeAttached();await page.locator('.archive-monaco .view-lines').click();
  await expect(area).toBeFocused();
  // Monaco derives keybindings from the emulated user agent, which can differ
  // from the machine running Playwright's ControlOrMeta shortcut.
  const selectAll=await page.evaluate(()=>navigator.userAgent.includes('Macintosh')?'Meta+A':'Control+A');
  await page.keyboard.press(selectAll);await page.keyboard.insertText(value);
  // These short fixtures fit in the visible editor. The native input only
  // represents the current line, so check the rendered document instead.
  await expect.poll(()=>page.locator('.archive-monaco .view-lines .view-line')
   .evaluateAll(lines=>lines.map(line=>line.textContent??'').join('').replace(/[\s\u200b]/g,'')))
   .toBe(value.replace(/[\s\u200b]/g,''));
 }
}

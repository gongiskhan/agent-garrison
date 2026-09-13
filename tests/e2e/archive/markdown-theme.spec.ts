import fs from 'node:fs/promises';
import path from 'node:path';
import {test,expect,goto,checkpoint} from './fixture';

// Retina captures preserve small code glyphs for the real vision judge.
test.use({deviceScaleFactor:2});
const note = 'Memory/Readable code.md';
const markdown = `---
title: Readable code
---
# Readable code

The synthetic run used \`sample_lookup\` and returned \`TEST-48392017\`.

## What changed
- Account \`sample_user\` belongs to \`example_company\`.
- Revision \`abc123ef\` completed successfully.

> The reference is \`TEST-48392017\`.

| Setting | Value |
| --- | --- |
| Mode | \`preview_only\` |

\`\`\`text
sample_lookup --reference TEST-48392017
\`\`\`
`;

test('inline and fenced code stay readable in dark and light Archive notes',async({page,app},info)=>{
 await fs.writeFile(path.join(app.vault,note),markdown);
 await page.emulateMedia({colorScheme:'dark'});
 await goto(page,app,'/archive/notes?path='+encodeURIComponent(note));
 for(const theme of ['dark','light'] as const){
  await page.emulateMedia({colorScheme:theme});
  const code=page.locator('.archive-markdown code');await expect(code).toHaveCount(8);
  // Let the real media query update; no test-only palette or CSS overrides.
  await expect(page.locator('.archive-app')).toHaveCSS('color',theme==='dark'?'rgb(238, 234, 222)':'rgb(24, 33, 27)');
  const contrasts=await code.evaluateAll(elements=>{
   const rgb=(value:string)=>value.match(/[\d.]+/g)!.map(Number);
   const luminance=(value:string)=>rgb(value).slice(0,3).reduce((sum,v,i)=>{v/=255;return sum+(v<=.04045?v/12.92:((v+.055)/1.055)**2.4)*[.2126,.7152,.0722][i];},0);
   return elements.map(el=>{
    let parent:Element|null=el,background='';
    while(parent){background=getComputedStyle(parent).backgroundColor;const channels=rgb(background);if(channels.length===3||channels[3]===1)break;parent=parent.parentElement;}
    const color=getComputedStyle(el).color,fg=luminance(color),bg=luminance(background);
    return {text:el.textContent,color,background,ratio:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)};
   });
  });
  await info.attach('code-contrast-'+theme,{body:JSON.stringify(contrasts,null,2),contentType:'application/json'});
  await checkpoint(page,info,'notes-code-'+theme,app);
  for(const sample of contrasts)expect(sample.ratio,JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator('.archive-markdown pre code')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
 }
 await page.reload();await expect(page.locator('.archive-markdown')).toContainText('TEST-48392017');
 expect(await fs.readFile(path.join(app.vault,note),'utf8')).toBe(markdown);
});

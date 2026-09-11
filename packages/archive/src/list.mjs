import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.mjs';
import { confine } from './paths.mjs';
import { maybeRead, lockedWrite, sha } from './io.mjs';
import { readCard, writeCard } from './card.mjs';

export const alphabetical = (a,b) => a.localeCompare(b,'pt-PT',{sensitivity:'base'});
export function byOrder(a,b) {
  if(a.name==='Inbox')return -1;if(b.name==='Inbox')return 1;
  const ao=Number.isFinite(a.order)?a.order:Infinity,bo=Number.isFinite(b.order)?b.order:Infinity;
  return (ao-bo || alphabetical(a.title??a.name,b.title??b.name));
}
export async function readList(ctx, relative) {
  const raw=await maybeRead(confine(ctx.vaultDir,path.posix.join(relative,'_list.md')));
  const parsed=parseFrontmatter(raw??'');
  return {...parsed,raw,title:parsed.frontmatter.title || path.posix.basename(relative),order:parsed.frontmatter.order,path:relative};
}
export async function writeList(ctx,relative,changes) {
  const original=await readList(ctx,relative);
  await lockedWrite(ctx,confine(ctx.vaultDir,path.posix.join(relative,'_list.md')),stringifyFrontmatter({...original.frontmatter,garrison:'list',title:original.title,...changes},original.body,original),original.raw===null?'new':sha(original.raw));
}
export async function cardsInList(ctx,relative) {
  const entries=await fs.readdir(confine(ctx.vaultDir,relative),{withFileTypes:true});const cards=[];
  for(const e of entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.'))){try{const c=await readCard(ctx,path.posix.join(relative,e.name));cards.push({...c,order:c.frontmatter.order,title:c.frontmatter.title});}catch(error){if(error.status!==404)throw error;}}
  return cards.sort(byOrder);
}
export async function nextOrder(ctx,list) { const cards=await cardsInList(ctx,list);return Math.max(0,...cards.map(c=>Number.isFinite(c.order)?c.order:0))+10; }
export async function reorderCard(ctx,relative,index) {
  const folder=path.posix.dirname(relative);const cards=await cardsInList(ctx,folder);const moved=cards.find(c=>c.path===relative);if(!moved)return;
  const rest=cards.filter(c=>c!==moved);index=Math.max(0,Math.min(index,rest.length));rest.splice(index,0,moved);
  const prev=rest[index-1]?.order??0,next=rest[index+1]?.order??prev+20;
  if(!Number.isFinite(prev)||!Number.isFinite(next)||next-prev<0.001||next<=prev) {
    for(let n=0;n<rest.length;n++){const c=rest[n];c.frontmatter.order=(n+1)*10;await writeCard(ctx,c.path,c,c.sha);}
  } else {moved.frontmatter.order=(prev+next)/2;await writeCard(ctx,moved.path,moved,moved.sha);}
}

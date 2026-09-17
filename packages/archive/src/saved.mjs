import fs from 'node:fs/promises';
import path from 'node:path';
import {confine,fail} from './paths.mjs';
import {maybeRead,now} from './io.mjs';
import {parseFrontmatter,stringifyFrontmatter} from './frontmatter.mjs';

// A portable set of document shortcuts, separate from ordering stars. Keeping
// it here also lets the owner bookmark generated notes without editing them.
export const BOOKMARKS_PATH='Archive/_bookmarks.md';
export async function readSaved(ctx){
  const raw=await maybeRead(confine(ctx.vaultDir,BOOKMARKS_PATH));
  const parsed=parseFrontmatter(raw??'');
  if(raw!==null&&parsed.frontmatter.garrison!=='bookmarks')throw fail('The bookmark file contains a note. Rename it before saving bookmarks.',409);
  const entries=parsed.frontmatter.entries??[];
  if(!Array.isArray(entries)||entries.some(p=>typeof p!=='string'))throw fail('The bookmark file has invalid entries.',409);
  return {parsed,paths:[...new Set(entries)]};
}
async function writeSaved(ctx,state,paths){
  await ctx.write(confine(ctx.vaultDir,BOOKMARKS_PATH),stringifyFrontmatter({...state.parsed.frontmatter,garrison:'bookmarks',entries:paths,updated:now()},state.parsed.body,state.parsed));
}
export async function setSaved(ctx,{path:relative,bookmarked}){
  const full=confine(ctx.vaultDir,relative),state=await readSaved(ctx);
  if(!bookmarked){if(state.paths.includes(relative))await writeSaved(ctx,state,state.paths.filter(p=>p!==relative));return {path:relative,bookmarked:false};}
  const stat=await fs.stat(full);
  const source=stat.isDirectory()?confine(ctx.vaultDir,path.posix.join(relative,'index.md')):full;
  if(relative===BOOKMARKS_PATH||(!stat.isDirectory()&&!relative.endsWith('.md')))throw fail('Choose a document or note to bookmark',400);
  const raw=await maybeRead(source);if(raw===null)throw fail('Choose a document or note to bookmark',400);
  const parsed=parseFrontmatter(raw);
  if((stat.isDirectory()&&parsed.frontmatter.garrison!=='card')||['derived','list','bookmarks'].includes(parsed.frontmatter.garrison))throw fail('Choose a document or note to bookmark',400);
  if(state.paths.includes(relative))return {path:relative,bookmarked:true};
  const paths=state.paths.filter(p=>p!==relative);
  if(bookmarked)paths.push(relative);
  if(JSON.stringify(paths)!==JSON.stringify(state.paths))await writeSaved(ctx,state,paths);
  return {path:relative,bookmarked};
}
export async function relocateSaved(ctx,from,to){
  if(from===to)return;
  const state=await readSaved(ctx),paths=state.paths.map(p=>p===from||p.startsWith(from+'/')?to+p.slice(from.length):p);
  if(paths.some((p,i)=>p!==state.paths[i]))await writeSaved(ctx,state,[...new Set(paths)]);
}

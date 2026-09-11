import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.mjs';
import { confine, fail } from './paths.mjs';
import { sha, lockedWrite } from './io.mjs';

const reserved = ['Details','Links','Checklists','Comments'];
export function parseCard(raw, folderName = 'Untitled') {
  const parsed = parseFrontmatter(raw,folderName);
  const sections = { description: [], Details: [], Links: [], Checklists: [], Comments: [] };
  let active='description';
  for(const line of parsed.body.split('\n')) {
    const h=/^## (.+?)\s*$/.exec(line);
    if(h && reserved.includes(h[1])) { active=h[1]; continue; }
    if(h) active='description';
    sections[active].push(line);
  }
  const details=sections.Details.map(l=>/^- (.+?): (.*)$/.exec(l)).filter(Boolean).map(m=>({label:m[1],value:m[2]}));
  const links=sections.Links.map(l=>/^- \[(.*?)\]\((\S+?)(?:\s+".*?")?\)$/.exec(l)).filter(Boolean).map(m=>({title:m[1],url:m[2]}));
  const checklists=[];let list;
  for(const line of sections.Checklists){const h=/^### (.*)$/.exec(line);const i=/^- \[([ xX])\] (.*)$/.exec(line);if(h){list={title:h[1],items:[]};checklists.push(list);}else if(i){if(!list){list={title:'Checklist',items:[]};checklists.push(list);}list.items.push({text:i[2],done:i[1].toLowerCase()==='x'});}}
  const comments=[];let comment;
  for(const line of sections.Comments){const h=/^### (\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?:[^ ]*)?) · (.+)$/.exec(line);if(h){comment={at:h[1],author:h[2],markdown:''};comments.push(comment);}else if(comment)comment.markdown+=line+'\n';}
  for(const c of comments)c.markdown=c.markdown.trim();
  return { ...parsed, frontmatter:{...parsed.frontmatter,garrison:'card',title:parsed.frontmatter.title || folderName},description:sections.description.join('\n').trim(),details,links,checklists,comments };
}
export function serializeCard(card) {
  const blocks = [typeof card.description==='string'?card.description:card.description?.markdown || ''];
  if(card.details?.length)blocks.push('## Details\n'+card.details.map(f=>`- ${f.label}: ${f.value}`).join('\n'));
  if(card.links?.length)blocks.push('## Links\n'+card.links.map(l=>`- [${l.title.replaceAll(']','\\]')}](${l.url})`).join('\n'));
  if(card.checklists?.length)blocks.push('## Checklists\n'+card.checklists.map(l=>`### ${l.title}\n${l.items.map(i=>`- [${i.done?'x':' '}] ${i.text}`).join('\n')}`).join('\n\n'));
  if(card.comments?.length)blocks.push('## Comments\n'+[...card.comments].sort((a,b)=>b.at.localeCompare(a.at)).map(c=>`### ${commentDate(c.at)} · ${c.author}\n${c.markdown}`).join('\n\n'));
  return stringifyFrontmatter(card.frontmatter,blocks.filter(Boolean).join('\n\n'),card);
}
export function commentDate(at){if(/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(at))return at;const d=new Date(at);return Number.isNaN(+d)?String(at):`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}
export async function readCard(ctx, relative) {
  const file=confine(ctx.vaultDir,path.posix.join(relative,'index.md'));
  let raw;try {raw=await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')throw fail('Card not found',404);throw e;}
  return {...parseCard(raw,path.posix.basename(relative)),path:relative,sha:sha(raw)};
}
export async function writeCard(ctx, relative, card, baseSha) {
  return lockedWrite(ctx,confine(ctx.vaultDir,path.posix.join(relative,'index.md')),serializeCard(card),baseSha);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { confine, visibleName, areaOf, isMirror } from './paths.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { readCard } from './card.mjs';
import { readList, byOrder, alphabetical } from './list.mjs';
import { readSidecar,sidecarSummary } from './ingest/sidecar.mjs';
import {readMetadata} from './metadata.mjs';

export const IMAGE = /\.(?:png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i;
export const mimeOf = (name) => ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',avif:'image/avif',heic:'image/heic',heif:'image/heif',pdf:'application/pdf',md:'text/plain; charset=utf-8',txt:'text/plain; charset=utf-8',csv:'text/csv; charset=utf-8',json:'application/json',log:'text/plain; charset=utf-8',yaml:'text/plain; charset=utf-8',yml:'text/plain; charset=utf-8'})[name.split('.').at(-1).toLowerCase()] || 'application/octet-stream';
export const fileUrl = (p,thumb=false) => `/api/archive/file?path=${encodeURIComponent(p)}${thumb?'&thumb=1':''}`;
export async function walkVault(ctx,relative='',{includeTrash=false}={}) {
  const files=[];
  async function walk(p){
    const dir=confine(ctx.vaultDir,p,{trash:includeTrash});
    const entries=await fs.readdir(dir,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for(const e of entries){
      if(!visibleName(e.name)&&!(includeTrash&&p==='Archive'&&e.name==='.trash')||e.isSymbolicLink())continue;
      const child=path.posix.join(p,e.name);let full;try{full=confine(ctx.vaultDir,child,{trash:includeTrash});}catch{continue;}
      if(e.isDirectory())await walk(child);
      else if(e.isFile()){
        const st=await fs.stat(full).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!st)continue;
        files.push({path:child,name:e.name,size:st.size,mtime:st.mtimeMs,updated:st.mtime.toISOString()});
      }
    }
  }
  await walk(relative);return files;
}
export async function attachments(ctx,relative,{extracted=true,summary=false}={}) {
  const result=[];
  for(const e of await fs.readdir(confine(ctx.vaultDir,relative),{withFileTypes:true})){if(!e.isFile()||!visibleName(e.name)||e.name.endsWith('.md'))continue;const p=path.posix.join(relative,e.name);let full;try{full=confine(ctx.vaultDir,p);}catch{continue;}const stat=await fs.stat(full).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!stat)continue;result.push({name:e.name,path:p,mime:mimeOf(e.name),size:stat.size,thumb:IMAGE.test(e.name)?fileUrl(p,true):null,...(extracted?{sidecar:summary?await sidecarSummary(ctx,p):await readSidecar(ctx,p)}:{})});}
  return result.sort((a,b)=>alphabetical(a.name,b.name));
}
export async function cardView(ctx,relative,{extracted=true}={}) {
  const card=await readCard(ctx,relative);const files=await attachments(ctx,relative,{summary:!extracted});
  const cover=files.find(f=>f.name===card.frontmatter.cover&&IMAGE.test(f.name))??files.find(f=>IMAGE.test(f.name));
  return {path:relative,sha:card.sha,frontmatter:card.frontmatter,parseWarning:card.parseWarning,description:{markdown:card.description,html:ctx.render(card.description)},details:card.details,links:card.links,checklists:card.checklists,comments:card.comments.map(c=>({...c,html:ctx.render(c.markdown)})),attachments:files,cover:cover?.name??null};
}
export async function tree(ctx,relative='',depth=2) {
  const full=confine(ctx.vaultDir,relative);const entries=await fs.readdir(full,{withFileTypes:true});const children=[];
  async function child(e){if(!visibleName(e.name)||e.isSymbolicLink())return;const p=path.posix.join(relative,e.name);let confined;try{confined=confine(ctx.vaultDir,p);}catch{return;}const stat=await fs.stat(confined).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!stat)return;const base={name:e.name,path:p,title:e.name,created:(stat.birthtimeMs>0?stat.birthtime:stat.mtime).toISOString(),updated:stat.mtime.toISOString(),area:areaOf(p)};
    if(e.isDirectory()){
      let card;try{if(areaOf(p)==='yours')card=await readCard(ctx,p);}catch(error){if(error.status!==404)throw error;}
      if(card){const files=await attachments(ctx,p,{extracted:false});const m=card.frontmatter;const cover=files.find(f=>f.name===m.cover&&IMAGE.test(f.name))??files.find(f=>IMAGE.test(f.name));children.push({...base,kind:'card',title:m.title,order:m.order,updated:m.updated??base.updated,created:m.created??base.updated,starred:m.starred===true,sha:card.sha,cover:cover?fileUrl(cover.path,true):null,description:card.description.slice(0,180),sensitive:m.sensitive===true,due:m.due??null,tags:m.tags??[],counts:{attachments:files.length,comments:card.comments.length,checklists:card.checklists.length,links:card.links.length}});}
      else {const list=relative==='Archive'||(await fs.stat(path.join(confined,'_list.md')).catch(()=>null));const meta=list?await readList(ctx,p):null;const nested=depth>0?await tree(ctx,p,depth-1):null;children.push({...base,kind:list?'list':'folder',title:meta?.title??e.name,order:meta?.order,notes:meta?.body??'',children:nested?.children,counts:{notes:nested?.children?.reduce((n,c)=>n+(c.kind==='note'?1:c.counts?.notes??0),0)??0,files:nested?.children?.filter(c=>c.kind==='file').length??0}});}
    }else if(e.isFile()){
      if(e.name.endsWith('.md')){if(areaOf(p)==='yours'&&['index.md','_list.md'].includes(e.name))return;const parsed=await readMetadata(ctx,p,stat);if(e.name==='_list.md'&&parsed.frontmatter.garrison==='list')return;const derived=parsed.frontmatter.garrison==='derived';children.push({...base,kind:derived?'sidecar':parsed.frontmatter.garrison==='bookmark'?'bookmark':'note',title:parsed.frontmatter.title||e.name.slice(0,-3),created:parsed.frontmatter.created??base.created,starred:parsed.frontmatter.starred===true,frontmatter:parsed.frontmatter,provenance:isMirror(p)?'mirror':areaOf(p)==='yours'?'you':'garrison',readOnly:isMirror(p)||derived});}
      else children.push({...base,kind:'file',size:stat.size,mime:mimeOf(e.name),thumb:IMAGE.test(e.name)?fileUrl(p,true):null,sidecar:await sidecarSummary(ctx,p)});
    }
  }
  // Bound parallel header reads. Opening a folder never starts one request per
  // descendant, and a concurrent editor/git removal cannot break the listing.
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(depth===0?16:1,entries.length)},async()=>{
    while(cursor<entries.length){const entry=entries[cursor++];try{await child(entry);}catch(error){if(error.code!=='ENOENT'&&error.status!==404)throw error;}}
  }));
  children.sort((a,b)=>{const folder=k=>['list','folder'].includes(k)?0:k==='card'?1:2;return folder(a.kind)-folder(b.kind)||byOrder(a,b)});
  let kind=relative===''||relative==='Archive'?'area':relative.startsWith('Archive/')&&relative.split('/').length===2?'list':'folder';
  if(areaOf(relative)==='yours'&&entries.some(e=>e.name==='index.md'))kind='card';
  if(ctx.index?.state==='ready'){const stats=ctx.index.folderStats();for(const child of children){if(!['folder','list'].includes(child.kind))continue;const summary=stats.get(child.path);child.counts.notes=summary?.notes??0;child.counts.documents=summary?.documents??0;child.counts.items=summary?.items??0;if(summary?.updated)child.updated=summary.updated;}}
  const meta=kind==='list'?await readList(ctx,relative):null;
  return {path:relative,name:path.posix.basename(relative),title:meta?.title??path.posix.basename(relative),order:meta?.order,notes:meta?.body??'',kind,children,counts:{files:children.filter(c=>c.kind==='file').length,notes:children.reduce((n,c)=>n+(c.kind==='note'?1:c.counts?.notes??0),0)}};
}

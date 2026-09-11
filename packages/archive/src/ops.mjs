import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { confine, fail, uniqueName, uniqueFileName, areaOf, isMirror } from './paths.mjs';
import { readCard, writeCard, serializeCard } from './card.mjs';
import { nextOrder, writeList, cardsInList } from './list.mjs';
import { now, sha, maybeRead } from './io.mjs';
import { IMAGE } from './tree.mjs';
import { assertNoteEditable } from './notes.mjs';
import { parseFrontmatter } from './frontmatter.mjs';

export function ownerPath(p){if(areaOf(p)!=='yours'||p==='Archive'||p.startsWith('Archive/.'))throw fail('Choose a list or card in Yours',400);}
export async function createList(ctx,title,parent='Archive'){
  if(parent!=='Archive'&&!parent.startsWith('Archive/'))throw fail('Invalid list parent',400);
  const name=uniqueName(confine(ctx.vaultDir,parent),title);const relative=path.posix.join(parent,name);await fs.mkdir(confine(ctx.vaultDir,relative));
  // Explicit user creation has a title; imported ordering is written separately.
  await writeList(ctx,relative,{title});return {path:relative};
}
export async function createCard(ctx,{list,title,description=''}){
  ownerPath(list);const listFull=confine(ctx.vaultDir,list);const st=await fs.stat(listFull);if(!st.isDirectory()||await maybeRead(path.join(listFull,'index.md'))!==null)throw fail('Choose a list',400);
  const name=uniqueName(listFull,title);const relative=path.posix.join(list,name);const at=now();
  const card={frontmatter:{garrison:'card',title,order:await nextOrder(ctx,list),created:at,updated:at},description,details:[],links:[],checklists:[],comments:[]};
  await fs.mkdir(confine(ctx.vaultDir,relative));await writeCard(ctx,relative,card,'new');return {path:relative};
}
export async function patchCard(ctx,input){
  ownerPath(input.path);let relative=input.path;const card=await readCard(ctx,relative);
  if(input.baseSha!==card.sha)throw fail('conflict',409,{current:{...card,markdown:serializeCard(card)}});
  for(const key of ['title','cover','tags','sensitive','due','order'])if(input[key]!==undefined)card.frontmatter[key]=input[key];
  for(const key of ['description','details','links','checklists','comments'])if(input[key]!==undefined)card[key]=input[key];
  if(input.cover){if(input.cover!==path.posix.basename(input.cover)||!IMAGE.test(input.cover))throw fail('Cover must be an image attachment',400);const st=await fs.stat(confine(ctx.vaultDir,path.posix.join(relative,input.cover))).catch(()=>null);if(!st?.isFile())throw fail('Cover not found',404);}
  let destination=relative;
  if(input.moveToList){ownerPath(input.moveToList);const target=confine(ctx.vaultDir,input.moveToList);if(!(await fs.stat(target)).isDirectory()||await maybeRead(path.join(target,'index.md'))!==null)throw fail('Choose a list',400);card.frontmatter.order=await nextOrder(ctx,input.moveToList);destination=path.posix.join(input.moveToList,uniqueName(target,card.frontmatter.title));}
  else if(input.title!==undefined){const parent=path.posix.dirname(relative);destination=path.posix.join(parent,uniqueName(confine(ctx.vaultDir,parent),input.title,path.posix.basename(relative)));}
  card.frontmatter.updated=now();const updatedSha=await writeCard(ctx,relative,card,input.baseSha);
  if(destination!==relative){await fs.rename(confine(ctx.vaultDir,relative),confine(ctx.vaultDir,destination));relative=destination;}
  return {path:relative,sha:updatedSha};
}
export async function addComment(ctx,{path:relative,text}){const card=await readCard(ctx,relative);card.comments.unshift({at:now(),author:ctx.config.author,markdown:text});card.frontmatter.updated=now();return {sha:await writeCard(ctx,relative,card,card.sha)};}
export async function patchList(ctx,{path:relative,title,order}){
  ownerPath(relative);if(relative==='Archive/Inbox'&&title&&title!=='Inbox')throw fail('Inbox keeps its name',400);
  await writeList(ctx,relative,{...(title!==undefined?{title}:{}),...(order!==undefined?{order}:{})});
  if(title!==undefined&&relative!=='Archive/Inbox'){const parent=path.posix.dirname(relative);const next=path.posix.join(parent,uniqueName(confine(ctx.vaultDir,parent),title,path.posix.basename(relative)));if(next!==relative)await fs.rename(confine(ctx.vaultDir,relative),confine(ctx.vaultDir,next));relative=next;}
  return {path:relative};
}
export async function trash(ctx,relative,{emptyList=false}={}){
  if(!relative||relative==='Archive'||relative==='Archive/Inbox'||relative.startsWith('Archive/.'))throw fail('This folder cannot be deleted',400);
  if(isMirror(relative))throw fail('Generated mirror. Edit the source note instead.',403);
  const source=confine(ctx.vaultDir,relative);const st=await fs.stat(source);
  if(emptyList){if((await fs.readdir(source)).some(n=>n!=='_list.md'))throw fail('Move or delete its cards first.',409);}
  const stamp=now().replace(/[:.]/g,'-');const entry=`${stamp} ${path.posix.basename(relative)} ${randomUUID().slice(0,8)}`;
  const root=confine(ctx.vaultDir,'Archive/.trash/'+entry,{trash:true});await fs.mkdir(root,{recursive:true});
  const stored=areaOf(relative)==='garrison'?path.posix.join('garrison',relative):'content';
  await ctx.write(path.join(root,'entry.json'),JSON.stringify({original:relative,at:now(),stored,isDirectory:st.isDirectory()},null,2));
  await fs.mkdir(path.dirname(path.join(root,stored)),{recursive:true});await fs.rename(source,path.join(root,stored));
  const side=await maybeRead(confine(ctx.vaultDir,relative+'.md'));
  if(!st.isDirectory()&&side&&parseFrontmatter(side).frontmatter.garrison==='derived')await fs.rename(confine(ctx.vaultDir,relative+'.md'),path.join(root,stored+'.md'));
  return {trashedTo:entry};
}
export async function listTrash(ctx){
  const root=confine(ctx.vaultDir,'Archive/.trash/',{trash:true});const entries=[];
  for(const e of await fs.readdir(root,{withFileTypes:true})){if(!e.isDirectory()||!e.name||e.name.startsWith('.'))continue;try{const meta=JSON.parse(await fs.readFile(confine(ctx.vaultDir,`Archive/.trash/${e.name}/entry.json`,{trash:true}),'utf8'));entries.push({entry:e.name,...meta});}catch{}}
  return entries.sort((a,b)=>b.at.localeCompare(a.at));
}
export async function restore(ctx,entry){
  if(entry!==path.posix.basename(entry))throw fail('Invalid trash entry',400);const relative=`Archive/.trash/${entry}`;
  const root=confine(ctx.vaultDir,relative,{trash:true});const meta=JSON.parse(await fs.readFile(confine(ctx.vaultDir,relative+'/entry.json',{trash:true}),'utf8'));
  const original=confine(ctx.vaultDir,meta.original);const source=confine(ctx.vaultDir,path.posix.join(relative,meta.stored),{trash:true});
  await fs.mkdir(path.dirname(original),{recursive:true});let name=uniqueName(path.dirname(original),path.basename(original));if(!meta.isDirectory){const ext=path.extname(original),stem=path.basename(original,ext);name=path.basename(original);let n=2;while(await fs.stat(path.join(path.dirname(original),name)).catch(()=>null)||await fs.stat(path.join(path.dirname(original),name+'.md')).catch(()=>null))name=`${stem} (${n++})${ext}`;}const result=path.posix.join(path.posix.dirname(meta.original),name);
  await fs.rename(source,confine(ctx.vaultDir,result));const side=await maybeRead(confine(ctx.vaultDir,path.posix.join(relative,meta.stored+'.md'),{trash:true}));
  if(side!==null){const {stringifyFrontmatter}=await import('./frontmatter.mjs');const parsed=parseFrontmatter(side);parsed.frontmatter.source=name;await ctx.write(confine(ctx.vaultDir,result+'.md'),stringifyFrontmatter(parsed.frontmatter,parsed.body,parsed));await fs.unlink(source+'.md');}
  await fs.rm(root,{recursive:true});return {path:result};
}
export async function moveFile(ctx,{path:relative,toCard,newCard}){
  ownerPath(relative);if(newCard)toCard=(await createCard(ctx,newCard)).path;
  await readCard(ctx,toCard);const source=confine(ctx.vaultDir,relative);if(relative.endsWith('.md'))throw fail('Choose a source attachment',400);if(!(await fs.stat(source)).isFile())throw fail('Choose a file',400);
  const targetDir=confine(ctx.vaultDir,toCard);let name=path.posix.basename(relative);const ext=path.extname(name);const stem=path.basename(name,ext);let n=2;
  while(await fs.stat(path.join(targetDir,name)).catch(()=>null)||await fs.stat(path.join(targetDir,name+'.md')).catch(()=>null))name=`${stem} (${n++})${ext}`;
  const result=path.posix.join(toCard,name);const side=await maybeRead(confine(ctx.vaultDir,relative+'.md'));
  // Move the pair before notifying the watcher; its debounce observes the end.
  await fs.rename(source,confine(ctx.vaultDir,result));
  if(side&&parseFrontmatter(side).frontmatter.garrison==='derived'){
    const {stringifyFrontmatter}=await import('./frontmatter.mjs');const parsed=parseFrontmatter(side);parsed.frontmatter.source=name;
    await ctx.write(confine(ctx.vaultDir,result+'.md'),stringifyFrontmatter(parsed.frontmatter,parsed.body,parsed));await fs.unlink(confine(ctx.vaultDir,relative+'.md'));
  }
  return {path:result,card:toCard};
}
export async function upload(ctx,target,files){
  ownerPath(target);if(target!=='Archive/Inbox')await readCard(ctx,target);
  const dir=confine(ctx.vaultDir,target),result=[];
  // Validate the whole batch before the first write.
  for(const file of files)if(file.bytes.length>ctx.config.max_file_mb*1024*1024)throw fail(`${file.name} is ${Math.round(file.bytes.length/1024/1024)} MB. The limit is ${ctx.config.max_file_mb} MB, so it was not added. Large files can be linked instead.`,413);
  for(const file of files){const ext=path.extname(file.name);let name=uniqueFileName(dir,file.name);if(file.name!==path.posix.basename(file.name)||file.name.startsWith('.'))throw fail('Invalid filename',400);let relative=path.posix.join(target,name);await ctx.write(confine(ctx.vaultDir,relative),file.bytes,{mode:0o600});
    if(/\.hei[cf]$/i.test(ext)&&ctx.convertHeic)relative=await ctx.convertHeic(relative);
    result.push({path:relative,size:file.bytes.length,queued:!relative.endsWith('.md')});
  }return {files:result};
}
export async function createFolder(ctx,parent,name){if(isMirror(parent))throw fail('Generated mirror. Edit the source note instead.',403);const dest=path.posix.join(parent,uniqueName(confine(ctx.vaultDir,parent),name));await fs.mkdir(confine(ctx.vaultDir,dest));return {path:dest};}
export async function moveNote(ctx,{path:relative,toFolder}){
  assertNoteEditable(relative,parseFrontmatter(await fs.readFile(confine(ctx.vaultDir,relative),'utf8')));if(isMirror(toFolder))throw fail('Generated mirror. Edit the source note instead.',403);
  const folder=confine(ctx.vaultDir,toFolder);if(!(await fs.stat(folder)).isDirectory())throw fail('Choose a folder',400);
  const ext='.md',stem=path.basename(relative,ext);let name=stem+ext,n=2;while(await fs.stat(path.join(folder,name)).catch(()=>null))name=`${stem} (${n++})${ext}`;
  const result=path.posix.join(toFolder,name);await fs.rename(confine(ctx.vaultDir,relative),confine(ctx.vaultDir,result));return {path:result};
}

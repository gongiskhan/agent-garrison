import fs from 'node:fs/promises';
import path from 'node:path';
import {confine,uniqueFileName,fail} from './paths.mjs';
import {readNote,writeNote} from './notes.mjs';
import {parseFrontmatter,stringifyFrontmatter} from './frontmatter.mjs';
import {now} from './io.mjs';

export function bookmarkUrl(value){
  let url;try{url=new URL(value);}catch{throw fail('Use an HTTP or HTTPS website address',400);}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('Use an HTTP or HTTPS website address without credentials',400);
  return url.href;
}
export async function saveBookmark(ctx,{path:relative,folder='Archive/Bookmarks',title,url,starred,baseSha='new'}){
  // Validate before creating a folder: rejected requests must leave no files.
  if(url!==undefined)url=bookmarkUrl(url);
  let original,created=now();
  if(relative){
    const before=await readNote(ctx,relative);original=parseFrontmatter(before.markdown);
    if(original.frontmatter.garrison!=='bookmark')throw fail('Choose a bookmark',400);
    created=original.frontmatter.created??created;
  }else{
    if(folder!=='Archive'&&!folder.startsWith('Archive/'))throw fail('Keep bookmarks in Yours',400);
    const parent=confine(ctx.vaultDir,folder);await fs.mkdir(parent,{recursive:true});
    relative=path.posix.join(folder,uniqueFileName(parent,title+'.md'));
  }
  if(!relative.startsWith('Archive/'))throw fail('Keep bookmarks in Yours',400);
  const meta={...original?.frontmatter,garrison:'bookmark',title:title??original?.frontmatter.title,url:bookmarkUrl(url??original?.frontmatter.url),created,updated:now(),...(starred===undefined?{}:{starred})};
  const markdown=stringifyFrontmatter(meta,original?.body??'',original);
  const result=await writeNote(ctx,{path:relative,markdown,baseSha});
  return {path:relative,...result};
}

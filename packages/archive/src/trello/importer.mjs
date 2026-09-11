import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mapBoard } from './mapper.mjs';
import { confine, uniqueName, sanitizeName } from '../paths.mjs';
import { walkVault } from '../tree.mjs';
import { parseFrontmatter } from '../frontmatter.mjs';
import { serializeCard } from '../card.mjs';
import { writeList } from '../list.mjs';
import { now } from '../io.mjs';

const exec=promisify(execFile);
export async function importBoard(ctx,jobs,row,{board,client,afterCard}={}){
  const controller=new AbortController();jobs.controllers.set(row.id,controller);
  const summary={lists:0,imported:0,skipped:0,attachments:0,links:0,oversize:0,tag:null};
  try{
    await jobs.update(row,{state:'running',startedAt:now()});
    board??=row.input.board??await client.board(row.input.boardId,{includeArchived:row.input.includeArchived,signal:controller.signal});
    const model=mapBoard(board,{...row.input,maxFileMb:ctx.config.max_file_mb,credentials:!!client});
    const stamp=now().replace(/[:.]/g,'-');summary.tag=`archive/pre-import-${String(model.shortLink).replace(/[^a-zA-Z0-9-]/g,'-')}-${stamp}-${randomUUID().slice(0,6)}`;
    await exec('git',['-C',ctx.vaultDir,'tag',summary.tag]);
    await jobs.log(row,`Pre-import tag: ${summary.tag}`);
    const existing=new Set();for(const file of await walkVault(ctx,'Archive'))if(file.name==='index.md'){const meta=parseFrontmatter(await fs.readFile(confine(ctx.vaultDir,file.path),'utf8')).frontmatter;if(meta.source)existing.add(meta.source);}
    await jobs.update(row,{progress:{done:0,total:model.counts.cards,label:model.name}});
    for(const list of model.lists){
      if(controller.signal.aborted)break;
      await fs.mkdir(confine(ctx.vaultDir,list.path),{recursive:true});if(!await fs.stat(confine(ctx.vaultDir,list.path+'/_list.md')).catch(()=>null))await writeList(ctx,list.path,{title:list.title,order:list.order});summary.lists++;
      for(const card of list.cards){
        if(controller.signal.aborted)break;
        if(existing.has(card.frontmatter.source)){summary.skipped++;await jobs.log(row,`Skipped ${card.frontmatter.source}`);await jobs.update(row,{progress:{done:summary.imported+summary.skipped,total:model.counts.cards,label:`${list.title} / ${card.frontmatter.title}`}});continue;}
        const dir=confine(ctx.vaultDir,list.path);const name=uniqueName(dir,path.posix.basename(card.path));const relative=path.posix.join(list.path,name);
        // A complete card becomes visible in one rename. A crash cannot leave a
        // partially written index.md, and unrelated same-name cards are preserved.
        const stage=path.join(dir,`.archive-import-${randomUUID()}`);await fs.mkdir(stage);
        try{
          for(const att of card.attachments){
            if(controller.signal.aborted)throw new Error('Import cancelled');
            try{const bytes=await client.download(att.url,{signal:controller.signal,maxBytes:ctx.config.max_file_mb*1024*1024});await ctx.write(path.join(stage,att.name),bytes,{mode:0o600});summary.attachments++;}
            catch(error){if(controller.signal.aborted)throw error;card.links.push({title:att.name+(error.oversize?` (too large: ${Math.round(att.size/1024/1024)} MB)`:' (download failed)'),url:att.url});await jobs.log(row,`Attachment retained as link: ${att.name}`);}
          }
          await ctx.write(path.join(stage,'index.md'),serializeCard(card),{mode:0o600});await fs.rename(stage,confine(ctx.vaultDir,relative));
        }finally{await fs.rm(stage,{recursive:true,force:true});}
        existing.add(card.frontmatter.source);summary.imported++;summary.links+=card.links.length;summary.oversize+=card.links.filter(l=>l.title.includes('(too large:')).length;
        await jobs.log(row,`Imported ${card.frontmatter.source}`);await jobs.update(row,{progress:{done:summary.imported+summary.skipped,total:model.counts.cards,label:`${list.title} / ${card.frontmatter.title}`},summary:{...summary}});
        for(const att of card.attachments)if(await fs.stat(confine(ctx.vaultDir,path.posix.join(relative,att.name))).catch(()=>null))await ctx.queue.enqueue(path.posix.join(relative,att.name));
        await afterCard?.(summary.imported);
      }
    }
    await ctx.index.build();await jobs.update(row,{state:controller.signal.aborted?'cancelled':'done',endedAt:now(),summary});
    if(!controller.signal.aborted)await ctx.syncNow?.();return summary;
  }catch(error){await jobs.update(row,{state:controller.signal.aborted?'cancelled':'failed',endedAt:now(),error:error.message,summary});throw error;}
  finally{jobs.controllers.delete(row.id);}
}

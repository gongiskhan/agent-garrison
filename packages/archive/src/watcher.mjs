import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { confine, visibleName } from './paths.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { maybeRead } from './io.mjs';

export function watchVault(ctx,index,queue){
  const pending=new Set();let timer;let chain=Promise.resolve();
  const watcher=chokidar.watch(ctx.vaultDir,{ignoreInitial:true,followSymlinks:false,ignored:p=>path.relative(ctx.vaultDir,p).split(path.sep).some((n,i)=>n&&(n.startsWith('.')&&n!=='.trash'||n==='node_modules')),awaitWriteFinish:{stabilityThreshold:50,pollInterval:20}});
  async function flush(){const paths=[...pending],updates=new Set(),files=[];pending.clear();for(const relative of paths){if(relative.includes('/.'))continue;
    try{
      const file=confine(ctx.vaultDir,relative);const st=await fs.stat(file).catch(()=>null);
      if(relative.endsWith('.md')&&st?.isFile()){
        const parsed=parseFrontmatter(await fs.readFile(file,'utf8'));
        if(parsed.frontmatter.garrison==='derived'){
          const source=parsed.frontmatter.source;if(typeof source!=='string'||source!==path.posix.basename(source))continue;
          const sourcePath=confine(ctx.vaultDir,path.posix.join(path.posix.dirname(relative),source));
          if(!await fs.stat(sourcePath).catch(()=>null)){await fs.unlink(file);updates.add(relative);updates.add(relative.slice(0,-3));continue;}
        }
      }
      if(!st&&!relative.endsWith('.md')){const raw=await maybeRead(confine(ctx.vaultDir,relative+'.md'));if(raw&&parseFrontmatter(raw).frontmatter.garrison==='derived')await fs.unlink(confine(ctx.vaultDir,relative+'.md'));}
      updates.add(relative);
      if(st?.isFile()&&!relative.endsWith('.md'))files.push(relative);
    }catch(error){ctx.onError?.(error);}
  }
    if(updates.size)try{await index.updateMany([...updates]);}catch(error){ctx.onError?.(error);}
    for(const relative of files)try{await queue.enqueue(relative);}catch(error){ctx.onError?.(error);}
  }
  const safeFlush=()=>ctx.serializeFiles?ctx.serializeFiles(flush):flush();
  watcher.on('all',(_event,full)=>{const relative=path.relative(ctx.vaultDir,full).split(path.sep).join('/');pending.add(relative);clearTimeout(timer);timer=setTimeout(()=>{chain=chain.then(safeFlush);},500);timer.unref?.();});
  watcher.on('error',error=>ctx.onError?.(error));
  return {ready:new Promise(r=>watcher.once('ready',r)),async close(){clearTimeout(timer);await watcher.close();await chain;},flush:()=>chain=chain.then(safeFlush)};
}

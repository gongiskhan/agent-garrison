import fs from 'node:fs/promises';
import {confine} from './paths.mjs';
import {parseFrontmatter} from './frontmatter.mjs';

// Folder browsing needs a header, never megabytes of note/extraction content.
// Stat signatures keep this bounded process-local cache fresh after editor/git
// writes, including same-length replacements. It is entirely reconstructible.
export async function readMetadata(ctx,relative,stat){
  const full=confine(ctx.vaultDir,relative);
  stat??=await fs.stat(full);
  const signature=[stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
  const cache=ctx.metadataCache??=new Map(),cached=cache.get(relative);
  if(cached?.signature===signature)return cached.value;
  const file=await fs.open(full,'r');let preview;
  try{const buffer=Buffer.alloc(16384);const {bytesRead}=await file.read(buffer,0,buffer.length,0);preview=buffer.subarray(0,bytesRead).toString('utf8');}
  finally{await file.close();}
  const value=parseFrontmatter(preview);
  cache.delete(relative);cache.set(relative,{signature,value});
  if(cache.size>2048)cache.delete(cache.keys().next().value);
  return value;
}

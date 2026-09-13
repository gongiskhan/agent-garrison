import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {confine} from './paths.mjs';

// Cache the content hash, never a trusted filesystem target. The file route
// rechecks confinement and the thumbnail cache on every request.
export async function fileHash(ctx,relative,stat){
  const file=confine(ctx.vaultDir,relative);stat??=await fs.stat(file);
  const signature=[stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
  const cache=ctx.hashCache??=new Map(),old=cache.get(relative);
  if(old?.signature===signature)return old.promise;
  const promise=(async()=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');})();
  const entry={signature,promise};cache.delete(relative);cache.set(relative,entry);
  if(cache.size>2048)cache.delete(cache.keys().next().value);
  try{return await promise;}catch(error){if(cache.get(relative)===entry)cache.delete(relative);throw error;}
}

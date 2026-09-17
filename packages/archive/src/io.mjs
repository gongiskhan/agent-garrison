import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from './paths.mjs';

export const sha = (data) => createHash('sha256').update(data).digest('hex');
export const now = () => new Date().toISOString();
export async function maybeRead(p) { try { return await fs.readFile(p, 'utf8'); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } }
// Standalone package/test fallback. The shell injects src/lib/atomic-write.ts.
export async function atomicWrite(p, data, options = {}) {
  await fs.mkdir(path.dirname(p), {recursive:true});
  const temp = path.join(path.dirname(p), `.${path.basename(p)}-${randomUUID()}`);
  const file = await fs.open(temp, 'wx', options.mode ?? 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  try {
    if (options.cas && await maybeRead(p) !== options.cas.priorContent) throw fail('conflict',409);
    await fs.rename(temp,p);
  } finally { await fs.rm(temp,{force:true}); }
}
export async function lockedWrite(ctx, p, data, baseSha, currentView) {
  const before = await maybeRead(p);
  const expected = before === null ? 'new' : sha(before);
  if (baseSha !== expected) throw fail('conflict', 409, { current: currentView ?? { markdown: before ?? '', sha: expected } });
  try { await ctx.write(p,data,{cas:{priorContent:before},mode:0o600}); }
  catch(e) { if(e.name === 'CasMismatchError' || e.status === 409) throw fail('conflict',409,{current:{markdown:await maybeRead(p),sha:sha(await maybeRead(p) ?? '')}}); throw e; }
  return sha(data);
}

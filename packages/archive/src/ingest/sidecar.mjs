import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from '../frontmatter.mjs';
import { confine } from '../paths.mjs';
import { maybeRead, sha, now } from '../io.mjs';

export async function readSidecar(ctx,relative) {
  const raw=await maybeRead(confine(ctx.vaultDir,relative+'.md'));if(!raw)return null;
  const parsed=parseFrontmatter(raw);if(parsed.frontmatter.garrison!=='derived')return null;
  const section=(name)=>{const m=new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,'m').exec(parsed.body);return m?.[1]?.trim()??'';};
  return {...parsed.frontmatter,sections:{what_it_is:section('What it is'),text:section('Text'),fields:section('Fields').split('\n').map(l=>/^- (.+?): (.*)$/.exec(l)).filter(Boolean).map(m=>({label:m[1],value:m[2]}))},error:section('Error')||null};
}
export async function sourceHash(ctx,relative) {return sha(await fs.readFile(confine(ctx.vaultDir,relative)));}
export async function validSidecar(ctx,relative) {const s=await readSidecar(ctx,relative);return !!s && s.sha256===await sourceHash(ctx,relative) && ['ok','unsupported'].includes(s.status);}
export async function writeSidecar(ctx,relative,result) {
  const meta={garrison:'derived',source:path.posix.basename(relative),sha256:result.sha256,kind:result.kind,pages:result.pages??1,generated:now(),target:result.target??ctx.config.extract_target,status:result.status};
  const sections=result.status==='failed'?`## Error\n${String(result.error).replace(/\s+/g,' ')}`:result.status==='unsupported'?'Supported kinds: images, PDF, text files, and DOCX when Pandoc is installed.':`## What it is\n${result.what_it_is??''}\n\n## Text\n${result.text??''}\n\n## Fields\n${(result.fields??[]).map(f=>`- ${f.label}: ${f.value}`).join('\n')}`;
  const target=confine(ctx.vaultDir,relative+'.md');const existing=await maybeRead(target);
  // Never replace an authored note that happens to have a sidecar-shaped name.
  if(existing && parseFrontmatter(existing).frontmatter.garrison!=='derived')throw new Error('An authored note already occupies the sidecar path');
  await ctx.write(target,stringifyFrontmatter(meta,`# ${path.posix.basename(relative)}\n\n${sections}`));
  return {...meta,sections:result};
}

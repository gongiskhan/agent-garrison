import fs from 'node:fs/promises';
import path from 'node:path';
import { confine, sanitizeName } from './paths.mjs';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.mjs';
import { atomicWrite } from './io.mjs';

const destination='Projects/Garrison/Documents';
const entries=async(dir)=>fs.readdir(dir,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
// The original artifacts are retained. Migrated files and their provenance are
// sufficient to rebuild the redirect table after deleting all derived data.
export async function migrateDocuments({vaultDir,home,artifactRoots=[],write=atomicWrite}){
  if(!vaultDir)return {migrated:0,redirects:{}};
  const redirects=Object.create(null);let migrated=0;
  const folder=confine(vaultDir,destination);
  for(const entry of await entries(folder)){
    if(!entry.isFile()||!entry.name.endsWith('.md'))continue;
    const relative=destination+'/'+entry.name,parsed=parseFrontmatter(await fs.readFile(confine(vaultDir,relative),'utf8'));
    const origin=parsed.frontmatter.migrated_from;
    if(typeof origin==='string'&&origin.startsWith('documents/'))redirects[origin.slice(10)]=relative;
  }
  for(const root of [...new Set(artifactRoots)]){
    const namespace=path.join(root,'documents');
    for(const entry of await entries(namespace)){
      if(!entry.isFile()||!entry.name.endsWith('.md.meta.json'))continue;
      const meta=JSON.parse(await fs.readFile(confine(root,'documents/'+entry.name),'utf8'));
      if(meta.namespace!=='documents'||typeof meta.id!=='string'||!meta.id)continue;
      if(redirects[meta.id])continue;
      const source=confine(root,'documents/'+entry.name.slice(0,-10));
      const raw=await fs.readFile(source,'utf8'),parsed=parseFrontmatter(raw),title=meta.title||parsed.frontmatter.title||entry.name.slice(0,-13);
      const stem=sanitizeName(title);let relative=destination+'/'+stem+'.md',suffix=1;
      while(await fs.lstat(confine(vaultDir,relative)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))relative=destination+'/'+stem+` (${++suffix}).md`;
      const stat=await fs.stat(source);
      const markdown=stringifyFrontmatter({...parsed.frontmatter,garrison:'note',title,migrated_from:'documents/'+meta.id,created:meta.created||stat.birthtime.toISOString(),updated:meta.updated||stat.mtime.toISOString()},parsed.body,parsed);
      await write(confine(vaultDir,relative),markdown,{cas:{priorContent:null},mode:0o600});
      redirects[meta.id]=relative;migrated++;
    }
  }
  // Do not create derived files on nodes without any legacy documents.
  if(Object.keys(redirects).length)await write(path.join(home,'archive/documents-redirects.json'),JSON.stringify(redirects,null,2)+'\n');
  return {migrated,redirects};
}
export function documentRedirect(redirects,id,vaultDir){
  if(!Object.hasOwn(redirects,id)||typeof redirects[id]!=='string')return null;
  confine(vaultDir,redirects[id]);
  return '/archive/notes?path='+encodeURIComponent(redirects[id]);
}

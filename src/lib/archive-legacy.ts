import fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import {COMPOSITIONS_DIR} from './paths';
import {garrisonDir} from './claude-home';
import {resolveActiveComposition} from './active-composition';
import {readComposition} from './compositions';
import {writeFileAtomic} from './atomic-write';
// @ts-ignore Standalone ESM core.
import {migrateDocuments,documentRedirect} from '../../packages/archive/src/documents-migration.mjs';
// @ts-ignore
import {vaultRoot} from '../../packages/archive/src/paths.mjs';

export async function legacyArtifactRoots(){
  const roots:string[]=[];
  for(const dir of await fs.readdir(COMPOSITIONS_DIR,{withFileTypes:true})){
    if(!dir.isDirectory()||dir.name.startsWith('.'))continue;
    const directory=path.join(COMPOSITIONS_DIR,dir.name);
    let manifest:any;try{manifest=parse(await fs.readFile(path.join(directory,'apm.yml'),'utf8'));}catch(e:any){if(e.code==='ENOENT')continue;throw e;}
    const selections=Object.values(manifest?.['x-garrison']?.composition?.selections??{}).flat() as any[];
    const legacy=selections.find(s=>s?.id==='documents')??selections.find(s=>s?.id==='artifact-store');
    roots.push(path.resolve(directory,legacy?.config?.storage_root??'artifacts'));
  }
  return roots;
}
let pending:Promise<any>|undefined;
export async function migrateLegacyDocuments(vaultDir:string,home=garrisonDir()){
  // Serialize requests: a migration/redirect pair must never create duplicate notes.
  const previous=pending??Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>migrateDocuments({vaultDir,home,artifactRoots:await legacyArtifactRoots(),write:writeFileAtomic}));pending=next;
  try{return await next;}finally{if(pending===next)pending=undefined;}
}
export async function legacyDocumentRedirect(id:string){
  const active=await resolveActiveComposition(),composition=await readComposition(active.id),vaultDir=vaultRoot(composition);
  if(!vaultDir)return '/archive';
  const {redirects}=await migrateLegacyDocuments(vaultDir);
  return documentRedirect(redirects,id,vaultDir)??'/archive';
}

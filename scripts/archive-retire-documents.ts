import fs from 'node:fs/promises';
import path from 'node:path';
import {COMPOSITIONS_DIR} from '../src/lib/paths';
import {resolveActiveComposition} from '../src/lib/active-composition';
import {readComposition} from '../src/lib/compositions';
import {migrateLegacyDocuments} from '../src/lib/archive-legacy';
import {retireDocumentsYaml} from '../src/lib/composition-migrate';
import {writeFileAtomic} from '../src/lib/atomic-write';
// @ts-ignore
import {vaultRoot} from '../packages/archive/src/paths.mjs';
async function main(){
 const active=await resolveActiveComposition(),vaultDir=vaultRoot(await readComposition(active.id));
 if(!vaultDir)throw new Error('Station basic-memory before migrating legacy documents.');
 const result=await migrateLegacyDocuments(vaultDir);let compositions=0;
 for(const entry of await fs.readdir(COMPOSITIONS_DIR,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
  const file=path.join(COMPOSITIONS_DIR,entry.name,'apm.yml');let before;try{before=await fs.readFile(file,'utf8');}catch(e:any){if(e.code==='ENOENT')continue;throw e;}
  const after=retireDocumentsYaml(before);if(after!==before){await writeFileAtomic(file,after,{cas:{priorContent:before}});compositions++;}
 }
 console.log(JSON.stringify({migrated:result.migrated,redirects:Object.keys(result.redirects).length,compositions}));
}
void main();

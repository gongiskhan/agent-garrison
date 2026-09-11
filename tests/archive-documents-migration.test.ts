import {it,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import {scratch} from './archive-test-helpers';
import {retireDocumentsYaml} from '../src/lib/composition-migrate';
// @ts-ignore
import {migrateDocuments,documentRedirect} from '../packages/archive/src/documents-migration.mjs';
// @ts-ignore
import {parseFrontmatter} from '../packages/archive/src/frontmatter.mjs';
async function legacy(root:string,id:string,title:string){
 await fs.mkdir(path.join(root,'documents'),{recursive:true});
 const name=id+'.md';await fs.writeFile(path.join(root,'documents',name),'---\ncustom: kept\n---\n# Synthetic legacy document\n\nPreserve the body.\n');
 await fs.writeFile(path.join(root,'documents',name+'.meta.json'),JSON.stringify({id,namespace:'documents',filename:'ignored-untrusted-name',title,created:'2026-01-02T00:00:00Z',updated:'2026-02-03T00:00:00Z'}));
}
it('migrates legacy markdown, preserves originals and collisions, then rebuilds redirects from files',async()=>{
 const s=await scratch({seed:false});try{
  const artifacts=path.join(s.root,'artifacts');await legacy(artifacts,'one','Cartão / casa');await legacy(artifacts,'two','Cartão / casa');
  await s.write('Projects/Garrison/Documents/Cartão - casa.md','Existing owner note');
  const options={vaultDir:s.vaultDir,home:s.home,artifactRoots:[artifacts]};
  const first=await migrateDocuments(options);expect(first.migrated).toBe(2);
  expect(first.redirects.one).toBe('Projects/Garrison/Documents/Cartão - casa (2).md');
  expect(first.redirects.two).toBe('Projects/Garrison/Documents/Cartão - casa (3).md');
  expect(parseFrontmatter(await s.read(first.redirects.one))).toMatchObject({frontmatter:{garrison:'note',title:'Cartão / casa',custom:'kept',migrated_from:'documents/one',created:'2026-01-02T00:00:00Z',updated:'2026-02-03T00:00:00Z'},body:'# Synthetic legacy document\n\nPreserve the body.\n'});
  expect(await s.read('Projects/Garrison/Documents/Cartão - casa.md')).toBe('Existing owner note');
  expect(await fs.readFile(path.join(artifacts,'documents/one.md'),'utf8')).toContain('custom: kept');
  await fs.rm(path.join(s.home,'archive'),{recursive:true,force:true});
  const again=await migrateDocuments(options);expect(again.migrated).toBe(0);expect(again.redirects).toEqual(first.redirects);
  expect(documentRedirect(again.redirects,'one',s.vaultDir)).toBe('/archive/notes?path='+encodeURIComponent(first.redirects.one));
  expect(documentRedirect(again.redirects,'__proto__',s.vaultDir)).toBeNull();
  expect(()=>documentRedirect({bad:'../outside.md'},'bad',s.vaultDir)).toThrow();
 }finally{await s.close();}
});
it('refuses source and destination symlink escapes and creates nothing for an empty store',async()=>{
 const s=await scratch({seed:false});try{
  const root=path.join(s.root,'artifacts');expect(await migrateDocuments({vaultDir:s.vaultDir,home:s.home,artifactRoots:[root]})).toEqual({migrated:0,redirects:{}});
  await expect(fs.stat(path.join(s.vaultDir,'Projects/Garrison/Documents'))).rejects.toMatchObject({code:'ENOENT'});
  await legacy(root,'one','Safe');await fs.unlink(path.join(root,'documents/one.md'));await fs.writeFile(path.join(s.root,'outside.md'),'outside');await fs.symlink(path.join(s.root,'outside.md'),path.join(root,'documents/one.md'));
  await expect(migrateDocuments({vaultDir:s.vaultDir,home:s.home,artifactRoots:[root]})).rejects.toThrow();
  await fs.unlink(path.join(root,'documents/one.md'));await legacy(root,'one','Safe');await fs.mkdir(path.join(s.vaultDir,'Projects/Garrison'),{recursive:true});await fs.symlink(s.root,path.join(s.vaultDir,'Projects/Garrison/Documents'));
  await expect(migrateDocuments({vaultDir:s.vaultDir,home:s.home,artifactRoots:[root]})).rejects.toThrow();
 }finally{await s.close();}
});
it('removes only the retired selection/dependency and preserves remaining authored configuration',()=>{
 const raw='# Keep this comment\ndependencies:\n  apm:\n    - path: ../../fittings/seed/documents\n    - path: ../../fittings/seed/roadmaps\nx-garrison:\n  composition:\n    schema: 4\n    selections:\n      knowledge:\n        - id: documents\n          config:\n            storage_root: custom\n        - id: roadmaps\n        - id: pdf\n        - id: project-viewer\n      memory:\n        - id: basic-memory\n    global_config:\n      archive:\n        author: Example\n';
 const migrated=retireDocumentsYaml(raw),value=parse(migrated);expect(migrated).toContain('# Keep this comment');
 expect(value['x-garrison'].composition.selections).toEqual({knowledge:[{id:'roadmaps'},{id:'pdf'},{id:'project-viewer'}],memory:[{id:'basic-memory'}]});
 expect(value.dependencies.apm).toEqual([{path:'../../fittings/seed/roadmaps'}]);expect(value['x-garrison'].composition.global_config.archive.author).toBe('Example');expect(retireDocumentsYaml(migrated)).toBe(migrated);expect(()=>retireDocumentsYaml('a: [bad')).toThrow();
});
it('has no retired fitting, loader, API writer or shipped selection; keeps neighboring capabilities',async()=>{
 await expect(fs.stat('fittings/seed/documents')).rejects.toMatchObject({code:'ENOENT'});
 expect(await fs.readFile('src/components/fitting-views/registry.tsx','utf8')).not.toContain('documents:');
 await expect(fs.stat('src/app/api/fittings/documents')).rejects.toMatchObject({code:'ENOENT'});
 for(const name of ['roadmaps','pdf','project-viewer','basic-memory','trello','vault-git-sync','file-browser'])expect((await fs.stat('fittings/seed/'+name)).isDirectory()).toBe(true);
 for(const entry of await fs.readdir('compositions',{withFileTypes:true})){if(!entry.isDirectory())continue;let raw;try{raw=await fs.readFile('compositions/'+entry.name+'/apm.yml','utf8');}catch{continue;}expect(retireDocumentsYaml(raw)).toBe(raw);}
});

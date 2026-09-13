#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const self=fileURLToPath(import.meta.url),driver='garrison-archive-derived';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
export function installDerivedMerge(cwd){
 const gitDir=path.resolve(cwd,git(cwd,'rev-parse','--git-dir'));
 git(cwd,'config','--local','merge.'+driver+'.name','Archive extractions of identical source files');
 // Git quotes substituted filenames itself, including %P. Quote only our
 // fixed executable paths so names containing shell syntax remain filenames.
 git(cwd,'config','--local','merge.'+driver+'.driver',quote(process.execPath)+' '+quote(self)+' merge %O %A %B %L %P');
 git(cwd,'config','--local','merge.'+driver+'.recursive','binary');
 const file=path.join(gitDir,'info','attributes');fs.mkdirSync(path.dirname(file),{recursive:true});
 const rule='Archive/**/*.md merge='+driver,original=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
 if(!original.split(/\r?\n/).includes(rule)){
  const temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,original+(original&&!original.endsWith('\n')?'\n':'')+'# Archive derived extraction merge\n'+rule+'\n',{mode:fs.existsSync(file)?fs.statSync(file).mode&0o777:0o600});fs.renameSync(temp,file);
 }
}
function preserveRefs(cwd){
 for(const ref of ['HEAD','ORIG_HEAD','REBASE_HEAD','MERGE_HEAD','CHERRY_PICK_HEAD']){
  let oid;try{oid=git(cwd,'rev-parse','--verify',ref+'^{commit}');}catch{continue;}
  const saved='refs/tags/archive/derived-merge/'+oid;let existing='';try{existing=git(cwd,'rev-parse','--verify',saved);}catch{}
  if(existing===oid)continue;
  if(existing)throw new Error('Recovery reference already names a different commit');
  git(cwd,'update-ref',saved,oid,'0'.repeat(oid.length));
 }
}
async function selector(){
 for(let root=path.dirname(self);;root=path.dirname(root)){
  const file=path.join(root,'packages/archive/src/ingest/merge.mjs');
  if(fs.existsSync(file))return (await import(pathToFileURL(file).href)).mergeDerived;
  if(path.dirname(root)===root)throw new Error('Archive package is unavailable');
 }
}
function sharedSource(cwd,file){
 if(!file.startsWith('Archive/')||file.split('/').some(p=>!p||p.startsWith('.'))||!file.endsWith('.md'))return;
 const source=file.slice(0,-3);
 try{
  const head=git(cwd,'rev-parse','HEAD');let other;
  for(const ref of ['REBASE_HEAD','MERGE_HEAD','CHERRY_PICK_HEAD','ORIG_HEAD']){try{const oid=git(cwd,'rev-parse','--verify',ref+'^{commit}');if(oid!==head){other=oid;break;}}catch{}}
  if(!other||git(cwd,'rev-parse',head+':'+source)!==git(cwd,'rev-parse',other+':'+source))return;
  return execFileSync('git',['show',head+':'+source],{cwd,maxBuffer:32*1024*1024,stdio:['ignore','pipe','pipe']});
 }catch{return;}
}
export async function runDerivedMerge([base,ours,theirs,marker,file],cwd=process.cwd()){
 const choose=await selector(),input={base:fs.readFileSync(base,'utf8'),ours:fs.readFileSync(ours,'utf8'),theirs:fs.readFileSync(theirs,'utf8'),file};
 let decision=choose(input);
 if(decision.kind==='conflict'){const sourceBytes=sharedSource(cwd,file);if(sourceBytes)decision=choose({...input,sourceBytes});}
 if(decision.kind==='derived'){preserveRefs(cwd);fs.writeFileSync(ours,decision.content);return 0;}
 if(decision.kind==='conflict')return 1;
 return spawnSync('git',['merge-file','--marker-size='+marker,ours,base,theirs],{cwd,stdio:'ignore'}).status??1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===self){
 try{if(process.argv[2]==='install')installDerivedMerge(process.argv[3]);else if(process.argv[2]==='merge')process.exitCode=await runDerivedMerge(process.argv.slice(3));else throw new Error('Expected install or merge');}
 catch{console.error('Archive derived merge unavailable; leaving the conflict unresolved.');process.exitCode=1;}
}

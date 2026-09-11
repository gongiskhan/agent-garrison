#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const MESSAGE='Archive/ is user-owned. Agents read it but never write it. If this belongs in the Archive, tell the user and let them file it.';
export const MATCHER='Write|Edit|MultiEdit|NotebookEdit|mcp__basic-memory__write_note|mcp__basic-memory__edit_note|mcp__basic-memory__move_note|mcp__basic-memory__delete_note';
const expand=p=>p?.replace(/^~(?=\/|$)/,os.homedir());
function real(p){const rest=[];let base=path.resolve(p);while(!fs.existsSync(base)){const parent=path.dirname(base);if(parent===base)break;rest.unshift(path.basename(base));base=parent;}return path.resolve(fs.realpathSync.native(base),...rest);}
const quote=s=>"'"+String(s).replaceAll("'","'\"'\"'")+"'";
function write(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);}
export function install(settings,vault,home,script){
  const data=fs.existsSync(settings)?JSON.parse(fs.readFileSync(settings,'utf8')):{};
  const hooks=data.hooks??={};const groups=hooks.PreToolUse??=[];
  hooks.PreToolUse=groups.flatMap(group=>{const kept=(group.hooks??[]).filter(h=>!h.command?.includes('archive-guard.mjs'));return kept.length?[{...group,hooks:kept}]:[];});
  // Compile the same stdlib functions into the hook command at setup time.
  // Node 20's file ESM loader alone costs ~9 ms; a plain eval starts within
  // the 30 ms budget without an extra resident process or a second source.
  const code=[`// ${script}\nconst fs=require('node:fs'),path=require('node:path'),os=require('node:os');`,
    `const MESSAGE=${JSON.stringify(MESSAGE)},expand=${expand.toString()};`,
    real.toString(),write.toString(),guardVault.toString(),blocked.toString(),
    `try{const payload=JSON.parse(fs.readFileSync(0,'utf8'));if(blocked(payload,guardVault(${JSON.stringify(settings)},${JSON.stringify(home)}))){process.stderr.write(MESSAGE+'\\n');process.exitCode=2;}}catch{process.stderr.write(MESSAGE+'\\n');process.exitCode=2;}`].join('\n');
  const cmd=`exec node --no-experimental-fetch -e ${quote(code)}`;
  hooks.PreToolUse.push({matcher:MATCHER,hooks:[{type:'command',command:cmd,timeout:5}]});
  write(path.join(home,'basic-memory/guard-config.json'),{vaultDir:expand(vault)});write(settings,data);
  fs.rmSync(path.join(home,'basic-memory/guard-cache.json'),{force:true});
}
export function guardVault(settings,home){
  const mtime=fs.existsSync(settings)?fs.statSync(settings).mtimeMs:0;const cacheFile=path.join(home,'basic-memory/guard-cache.json');
  try{const cached=JSON.parse(fs.readFileSync(cacheFile,'utf8'));if(cached.settings===settings&&cached.mtime===mtime)return cached.vaultDir;}catch{}
  let config;try{config=JSON.parse(fs.readFileSync(path.join(home,'basic-memory/guard-config.json'),'utf8'));}catch{}
  const vaultDir=real(expand(config?.vaultDir??process.env.BASIC_MEMORY_VAULT_DIR??'~/ObsidianVault'));
  try{write(cacheFile,{settings,mtime,vaultDir});}catch{/* A read-only cache must not disable protection. */}return vaultDir;
}
export function blocked(payload,vaultDir){
  const input=payload.tool_input??{},name=payload.tool_name??'';const candidates=[];
  const add=p=>{if(typeof p==='string'&&p)candidates.push(p);};
  if(/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)){add(input.file_path);add(input.notebook_path);add(input.new_path);for(const edit of input.edits??[]){add(edit.file_path);add(edit.new_path);}}
  else if(/mcp__basic-memory__(write_note|edit_note)$/.test(name)){add(path.join(input.folder??'',input.title??''));add(input.identifier);}
  else if(name==='mcp__basic-memory__move_note'){add(input.identifier);add(input.destination_path);}
  else if(name==='mcp__basic-memory__delete_note')add(input.identifier);
  return candidates.some(value=>{
    let clean=expand(value.replace(/^memory:\/\//,''));try{clean=decodeURIComponent(clean);}catch{}
    clean=clean.replace(/^main\//,'');
    // Basic Memory identifiers are lower-case permalinks; filename tools are absolute.
    if(/^archive(?:\/|$)/i.test(clean))return true;
    const target=real(path.isAbsolute(clean)?clean:path.resolve(vaultDir,clean));const rel=path.relative(real(path.join(vaultDir,'Archive')),target);
    return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
  if(args[0]==='--install'){install(...args.slice(1));}
  else{
    const settings=args.includes('--settings')?arg('--settings'):process.env.CLAUDE_SETTINGS_FILE??path.join(process.env.GARRISON_CLAUDE_HOME??path.join(os.homedir(),'.claude'),'settings.json');
    const home=args.includes('--home')?arg('--home'):process.env.GARRISON_HOME??path.join(os.homedir(),'.garrison');
    try{const payload=JSON.parse(fs.readFileSync(0,'utf8'));if(blocked(payload,guardVault(settings,home))){process.stderr.write(MESSAGE+'\n');process.exitCode=2;}}
    catch{process.stderr.write(MESSAGE+'\n');process.exitCode=2;}
  }
}

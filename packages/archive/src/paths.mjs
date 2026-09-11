import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ARCHIVE_LABEL = 'Archive';
export const DEFAULT_CONFIG = Object.freeze({ extract_target: 'cc-sonnet', max_file_mb: 25, pdf_max_pages: 30, author: 'Gonçalo' });
// Copied from the shell's confined same-origin file server.
export const SENSITIVE = /(?:^|\/)(?:\.env(?:\.|$)|id_rsa|id_ed25519|[^/]*\.pem|vault\.json)|\/\.git\//i;
export const fail = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
export function expandHome(p) { return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(p); }
export function vaultRoot(composition) {
  const memory = composition?.selections?.memory?.find(s => s.id === 'basic-memory');
  return memory ? expandHome(memory.config?.vault_dir || '~/ObsidianVault') : null;
}
// Automation consumers use the same rendered Basic Memory vault binding as the
// ownership hook; it can differ from this machine's default Obsidian folder.
export function automationVaultRoot(env=process.env){
  const home=env.GARRISON_HOME||path.join(os.homedir(),'.garrison');
  try{const config=JSON.parse(fs.readFileSync(path.join(home,'basic-memory/guard-config.json'),'utf8'));if(config.vaultDir)return expandHome(config.vaultDir);}catch{}
  return expandHome(env.BASIC_MEMORY_VAULT_DIR||'~/ObsidianVault');
}
export function archiveRoot(vaultDir) { return path.join(vaultDir, 'Archive'); }
export function within(root, candidate) { return candidate === root || candidate.startsWith(root + path.sep); }
// Resolve existing ancestors as well as complete files. Guards must cover new
// destinations and symlinked parents, not just already-created files.
export function realAncestor(p) {
  let at = path.resolve(p); const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(at), ...suffix); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (fs.existsSync(path.dirname(at))) {
        try { if (fs.lstatSync(at).isSymbolicLink()) throw fail('Broken symlink', 403); } catch (l) { if (l.code !== 'ENOENT') throw l; }
      }
      const parent = path.dirname(at); if (parent === at) throw e;
      suffix.unshift(path.basename(at)); at = parent;
    }
  }
}
export function isArchivePath(vaultDir, p) {
  if (!vaultDir || typeof p !== 'string') return false;
  let value = p.replace(/^memory:\/\//, '').replace(/\\/g, '/');
  try { value = decodeURIComponent(value); } catch { /* Literal path remains inspectable. */ }
  if (/^(?:main\/)?archive(?:\/|$)/i.test(value)) return true;
  try {
    const root = realAncestor(path.join(vaultDir, 'Archive'));
    return within(root, realAncestor(path.isAbsolute(value) ? value : path.join(vaultDir, value)));
  } catch { return false; }
}
export function areaOf(p) { return /^Archive(?:\/|$)/.test(p) ? 'yours' : 'garrison'; }
export function confine(vaultDir, relative = '', { trash = false } = {}) {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') || path.posix.isAbsolute(relative)) throw fail('Invalid vault-relative path', 403);
  const parts = relative.split('/').filter(Boolean);
  if (parts.some((s, i) => s === '..' || s === '.' || (s.startsWith('.') && !(trash && i === 1 && parts[0] === 'Archive' && s === '.trash'))) || parts.includes('node_modules') || SENSITIVE.test(relative)) throw fail('Forbidden path', 403);
  const root = fs.realpathSync(vaultDir);
  const result = realAncestor(path.join(root, ...parts));
  if (!within(root, result)) throw fail('Path is outside the vault', 403);
  const realRelative = path.relative(root, result).split(path.sep).join('/');
  if (SENSITIVE.test(realRelative) || realRelative.split('/').some((s,i)=>s.startsWith('.') && !(trash && i===1 && (realRelative==='Archive/.trash'||realRelative.startsWith('Archive/.trash/'))))) throw fail('Forbidden path', 403);
  return result;
}
export function sanitizeName(title) {
  return String(title).replace(/[\/\\:*?"<>|\x00-\x1f\x7f]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').slice(0, 80).trim().replace(/\.+$/, '') || 'Untitled';
}
export function uniqueName(parent, title, except) {
  const name = sanitizeName(title); let candidate = name; let n = 2;
  const names=new Set(fs.readdirSync(parent).filter(n=>n!==except).map(n=>n.toLocaleLowerCase('pt-PT')));
  while (names.has(candidate.toLocaleLowerCase('pt-PT'))) candidate = `${name} (${n++})`;
  return candidate;
}
export function isMirror(p) { return p.split('/').includes('Claude Native'); }
export function visibleName(n) { return !n.startsWith('.') && n !== 'node_modules' && !SENSITIVE.test(n); }

// Automatic consumers may inspect a path's provenance, never the owner's file.
// Drop an entire transcript when any turn references Archive: later replies can
// contain extracted text without repeating the originating tool path.
export function hasArchiveReference(vaultDir,value){
  if(value===null||value===undefined)return false;
  if(typeof value==='object')return Object.values(value).some(v=>hasArchiveReference(vaultDir,v));
  if(typeof value!=='string')return false;
  if(isArchivePath(vaultDir,value))return true;
  let text=value;try{text=decodeURIComponent(text);}catch{}
  return [...text.matchAll(/(?:memory:\/\/|garrison:\/\/)?(?:main\/)?Archive\/[^\s"'<>]*/gi)].some(m=>isArchivePath(vaultDir,m[0].replace(/^garrison:\/\//,'')));
}
export function automationInputAllowed(vaultDir,file){
  if(isArchivePath(vaultDir,file))return false;
  try {
    // Scan provenance over the complete transcript, not merely its tail. The
    // bounded excerpts used by collectors can follow a much earlier file read.
    const fd=fs.openSync(file,'r');const buffer=Buffer.alloc(64*1024);let carry='';
    try{for(;;){const n=fs.readSync(fd,buffer);if(!n)break;const text=carry+buffer.toString('utf8',0,n);if(hasArchiveReference(vaultDir,text))return false;carry=text.slice(-2048);}}finally{fs.closeSync(fd);}
    return true;
  }catch{return false;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
  const [mode,vault,...inputs]=process.argv.slice(2);
  if(mode==='--check-paths')process.exitCode=inputs.some(p=>isArchivePath(vault,p))?2:0;
  if(mode==='--check-inputs')process.exitCode=inputs.every(p=>automationInputAllowed(vault,p))?0:2;
}

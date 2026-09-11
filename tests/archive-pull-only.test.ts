import { it,expect,vi } from 'vitest';import fs from 'node:fs/promises';import path from 'node:path';import { spawnSync } from 'node:child_process';import { scratch } from './archive-test-helpers';
// @ts-ignore
import { isArchivePath,automationInputAllowed,hasArchiveReference,automationVaultRoot } from '../packages/archive/src/paths.mjs';
// @ts-ignore
import { collectDailyEvidence } from '../packages/improver/src/collect.mjs';
// @ts-ignore
import { transcriptOf,runZecaNightly } from '../packages/improver/src/zeca.mjs';
import { readClaudeMd } from '../src/lib/claude-md';
import { declaredFiles } from '../src/lib/quarters-runtimes';
const decoy='ARCHIVE-DECOY-9Q';
it('J1.3 excludes Archive files and entire referencing transcripts before capture and model evidence',async()=>{const s=await scratch({seed:false});try{
 const owned=path.join(s.vaultDir,'Archive/decoy.md');await s.write('Archive/decoy.md',decoy);const transcript=path.join(s.home,'conversations/session/events.jsonl');await fs.mkdir(path.dirname(transcript),{recursive:true});await fs.writeFile(transcript,[{timestamp:'2026-09-11T12:00:00.000Z',kind:'user-message',payload:{text:'Read Archive/decoy.md'}},{timestamp:'2026-09-11T12:01:00.000Z',kind:'note',payload:{text:decoy}}].map(r=>JSON.stringify(r)).join('\n'));
 expect(automationInputAllowed(s.vaultDir,owned)).toBe(false);expect(automationInputAllowed(s.vaultDir,transcript)).toBe(false);
 for(const source of [owned,transcript]){const out=spawnSync('python3',['fittings/seed/basic-memory/scripts/capture-session.py'],{input:JSON.stringify({session_id:'fixture',transcript_path:source,cwd:s.root}),env:{...process.env,BASIC_MEMORY_VAULT_DIR:s.vaultDir,GARRISON_HOME:s.home},encoding:'utf8'});expect(out.status).toBe(0);}
 expect(await fs.readdir(path.join(s.vaultDir,'Memory')).catch(()=>[])).toHaveLength(0);
 const evidence=await collectDailyEvidence({day:'2026-09-11',node:'fixture',home:s.home,env:{BASIC_MEMORY_VAULT_DIR:s.vaultDir,GARRISON_CLAUDE_HOME:path.join(s.vaultDir,'Archive'),CODEX_HOME:path.join(s.home,'empty')}});expect(JSON.stringify(evidence)).not.toContain(decoy);expect(evidence.sources).toHaveLength(0);
 const thread={messages:[{role:'user',text:'Read Archive/decoy.md'},{role:'assistant',text:decoy}]};expect(transcriptOf(thread,s.vaultDir)).not.toContain(decoy);const run=vi.fn();const result=await runZecaNightly({env:{BASIC_MEMORY_VAULT_DIR:s.vaultDir,GARRISON_HOME:s.home,GARRISON_APP_URL:'http://fixture'},fetchImpl:async(url:string)=>Response.json(url.endsWith('/api/zeca')?{conversationId:'fixture'}:{thread}),runFn:run});expect(run).not.toHaveBeenCalled();expect(result.reason).toContain('Archive');
}finally{await s.close();}});
it('rejects an Archive native mirror source before reading any note',async()=>{const s=await scratch({seed:false});try{
 await s.write('Archive/decoy.md',decoy);const module=path.join(process.cwd(),'packages/archive/src/paths.mjs');const out=spawnSync(process.execPath,[module,'--check-paths',s.vaultDir,path.join(s.vaultDir,'Archive')],{encoding:'utf8'});expect(out.status).toBe(2);expect(out.stdout).not.toContain(decoy);
 const script=await fs.readFile('fittings/seed/vault-git-sync/scripts/obsidian-vault-sync.sh','utf8');expect(script).toContain('node "$ARCHIVE_PATHS" --check-paths "$VAULT" "$MIRROR_SOURCE"');expect(script.indexOf('--check-paths')).toBeLessThan(script.indexOf('"$MEMORY_MIRROR" --source'));
}finally{await s.close();}});
it('keeps startup and Quarters context reads explicit, without walking the vault',async()=>{const s=await scratch({seed:false});try{
 await s.write('Archive/decoy.md',decoy);await fs.writeFile(path.join(s.root,'CLAUDE.md'),'Explicit project guidance');const result=await readClaudeMd('project',{projectDir:s.root});expect(result.content).toBe('Explicit project guidance');expect(result.content).not.toContain(decoy);
 const declared=declaredFiles({context_file:'AGENTS.md',home_dir:s.root} as any);expect(declared).toEqual([{kind:'context',path:path.join(s.root,'AGENTS.md')}]);for(const file of ['src/lib/claude-md.ts','src/lib/quarters-runtimes.ts']){const source=await fs.readFile(file,'utf8');expect(source).not.toMatch(/(?:glob|readdir)\([^)]*(?:vault|Archive)/i);}
}finally{await s.close();}});

it('uses the rendered custom vault for automatic exclusions',async()=>{const s=await scratch({seed:false});try{await fs.mkdir(path.join(s.home,'basic-memory'),{recursive:true});await fs.writeFile(path.join(s.home,'basic-memory/guard-config.json'),JSON.stringify({vaultDir:s.vaultDir}));expect(automationVaultRoot({GARRISON_HOME:s.home})).toBe(s.vaultDir);expect(isArchivePath(automationVaultRoot({GARRISON_HOME:s.home}),path.join(s.vaultDir,'Archive/decoy.md'))).toBe(true);}finally{await s.close();}});

import {afterEach,expect,it} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
// @ts-expect-error Archive is an ESM JavaScript package.
import {mergeDerived,sourceHashMatches} from '../packages/archive/src/ingest/merge.mjs';
// @ts-expect-error Fitting JavaScript entry point.
import {installDerivedMerge} from '../fittings/seed/vault-git-sync/scripts/git-derived-merge.mjs';
const source='Synthetic original bytes',sha=createHash('sha256').update(source).digest('hex');
const file="Archive/Fixture/O'Clock $(touch UNEXPECTED)/image.jpg.md";
const body=(status='ok',generated='2026-09-13T10:00:00Z',text='Synthetic extraction',hash=sha)=>`---\ngarrison: derived\nsource: image.jpg\nsha256: ${hash}\nstatus: ${status}\ngenerated: ${generated}\nkind: image\ncustom: preserved\n---\n${text}\n`;
const base=body('failed','2026-09-12T10:00:00Z');
it.each([['ok','failed'],['ok','unsupported'],['unsupported','failed']])('keeps %s over %s for identical sources regardless of merge direction',(best,worse)=>{
 const a=body(best),b=body(worse,'2026-09-14T10:00:00Z');expect(mergeDerived({base,ours:a,theirs:b,file})).toEqual({kind:'derived',content:a});expect(mergeDerived({base,ours:b,theirs:a,file})).toEqual({kind:'derived',content:a});
});
it('selects the newest complete extraction and resolves equal-time ties deterministically',()=>{
 const a=body('ok','2026-09-13T10:00:00Z','Older synthetic text'),b=body('ok','2026-09-14T10:00:00Z','New synthetic text');expect(mergeDerived({base,ours:a,theirs:b,file})).toEqual({kind:'derived',content:b});
 const c=body('ok','2026-09-14T10:00:00Z','Alternate synthetic text');expect(mergeDerived({base,ours:b,theirs:c,file})).toEqual(mergeDerived({base,ours:c,theirs:b,file}));
});
it.each([
 {ours:body(),theirs:body('ok',undefined,undefined,'f'.repeat(64))},
 {ours:body(),theirs:body().replace('source: image.jpg','source: ../image.jpg')},
 {ours:body(),theirs:body().replace('status: ok','status: surprise')},
 {ours:body(),theirs:body().replace('generated: 2026-09-13T10:00:00Z','generated: invalid')},
 {ours:body(),theirs:body().replace('generated: 2026-09-13T10:00:00Z','generated: 2026')},
 {ours:body(),theirs:'---\ngarrison: card\ntitle: Authored\n---\nUser text\n'},
 {ours:body(),theirs:body(),file:'Memory/image.jpg.md'},
 {ours:body(),theirs:body(),file:'Archive/.trash/image.jpg.md'},
])('refuses ambiguous source, provenance, date or path metadata %#',input=>expect(mergeDerived({base,file,...input})).toEqual({kind:'conflict'}));
it('leaves authored cards, notes and bookmarks to ordinary Git merge behavior',()=>{
 for(const kind of ['card','note','bookmarks'])expect(mergeDerived({base:'',ours:`---\ngarrison: ${kind}\n---\nA`,theirs:`---\ngarrison: ${kind}\n---\nB`,file})).toEqual({kind:'text'});
});
const roots:string[]=[];
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const write=(cwd:string,name:string,value:string)=>{fs.mkdirSync(path.dirname(path.join(cwd,name)),{recursive:true});fs.writeFileSync(path.join(cwd,name),value);};
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-merge-'));roots.push(root);const remote=path.join(root,'remote.git'),a=path.join(root,'a'),b=path.join(root,'b');git(root,'init','--bare','-q','-b','main',remote);git(root,'clone','-q',remote,a);
 for(const cwd of [a]){git(cwd,'config','user.name','Fixture');git(cwd,'config','user.email','fixture@example.invalid');git(cwd,'config','commit.gpgsign','false');}
 write(a,file,base);write(a,file.slice(0,-3),source);write(a,'Archive/Fixture/index.md','---\ngarrison: card\ntitle: Fixture\n---\nUnchanged authored document.\n');git(a,'add','-A');git(a,'commit','-qm','fixture base');git(a,'push','-q','origin','main');git(root,'clone','-q',remote,b);git(b,'config','user.name','Fixture');git(b,'config','user.email','fixture@example.invalid');git(b,'config','commit.gpgsign','false');return{root,remote,a,b};
}
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
it('recovers a real rebase conflict through vault-git-sync, keeps source bytes and saves both histories',()=>{
 const {root,a,b}=fixture(),older=body('ok','2026-09-13T10:00:00Z','First synthetic extraction'),newer=body('ok','2026-09-14T10:00:00Z','Second synthetic extraction');
 write(a,file,older);git(a,'add','-A');git(a,'commit','-qm','first extraction');const first=git(a,'rev-parse','HEAD');git(a,'push','-q','origin','main');
 write(b,file,newer);git(b,'add','-A');git(b,'commit','-qm','second extraction');const second=git(b,'rev-parse','HEAD');
 expect(()=>git(b,'pull','--rebase','origin','main')).toThrow();git(b,'rebase','--abort');expect(fs.readFileSync(path.join(b,file),'utf8')).toBe(newer);
 const home=path.join(root,'home');fs.mkdirSync(home);const script=path.resolve('fittings/seed/vault-git-sync/scripts/obsidian-vault-sync.sh');
 const run=spawnSync('bash',[script,'--require-fresh'],{env:{...process.env,HOME:home,GARRISON_HOME:home,GARRISON_USER_CLAUDE_HOME:path.join(home,'user'),CLAUDE_MEMORY_MIRROR:path.join(home,'missing'),OBSIDIAN_VAULT:b},encoding:'utf8'});
 expect(run.status,run.stderr).toBe(0);expect(JSON.parse(fs.readFileSync(path.join(home,'obsidian-vault-sync-status.json'),'utf8')).state).toBe('ok');
 expect(fs.readFileSync(path.join(b,file),'utf8')).toBe(newer);expect(fs.readFileSync(path.join(b,file.slice(0,-3)),'utf8')).toBe(source);expect(fs.readFileSync(path.join(b,'Archive/Fixture/index.md'),'utf8')).toContain('Unchanged authored document.');expect(fs.existsSync(path.join(b,'UNEXPECTED'))).toBe(false);
 for(const oid of [first,second])expect(git(b,'rev-parse','refs/tags/archive/derived-merge/'+oid)).toBe(oid);
 expect(git(b,'status','--porcelain')).toBe('');expect(git(b,'rev-parse','HEAD')).toBe(git(b,'rev-parse','origin/main'));
});
it('installs idempotently without changing tracked files or unrelated attributes',()=>{
 const {a}=fixture();write(a,'.git/info/attributes','*.txt text\n');installDerivedMerge(a);const attrs=fs.readFileSync(path.join(a,'.git/info/attributes'),'utf8');installDerivedMerge(a);expect(fs.readFileSync(path.join(a,'.git/info/attributes'),'utf8')).toBe(attrs);expect(attrs).toContain('*.txt text\n');expect(git(a,'check-attr','merge','--','Memory/Note.md')).toContain('unspecified');expect(git(a,'status','--porcelain')).toBe('');
});
it('keeps an authored conflict unresolved and preserves both originals',()=>{
 const {a,b}=fixture(),note='Archive/Fixture/index.md';write(a,note,'Authored first\n');git(a,'add','-A');git(a,'commit','-qm','first authored edit');git(a,'push','-q','origin','main');write(b,note,'Authored second\n');git(b,'add','-A');git(b,'commit','-qm','second authored edit');installDerivedMerge(b);expect(()=>git(b,'pull','--rebase','origin','main')).toThrow();git(b,'rebase','--abort');expect(fs.readFileSync(path.join(b,note),'utf8')).toBe('Authored second\n');expect(git(b,'show','origin/main:'+note)).toBe('Authored first');
});

it('matches canonically equivalent attachment names across Mac and Linux',()=>{
 const ours=body().replace('image.jpg','café.jpg'),theirs=body('ok','2026-09-14T10:00:00Z').replace('image.jpg','café.jpg');expect(mergeDerived({base:'',ours,theirs,file:'Archive/Fixture/cafe\u0301.jpg.md'})).toEqual({kind:'derived',content:theirs});
});

it('accepts portable generation timestamps without accepting a bare year',()=>{
 const newer=body('ok','2026-09-14 10:00:00.123000+00:00');expect(mergeDerived({base,ours:body(),theirs:newer,file})).toEqual({kind:'derived',content:newer});
});
it('recognises newline-only text hashes, including legacy encodings, while keeping binary changes exact',()=>{
 const bytes=Buffer.from([0x63,0x61,0x66,0xe9,0x0d,0x0a]),lf=Buffer.from([0x63,0x61,0x66,0xe9,0x0a]),hash=createHash('sha256').update(bytes).digest('hex');expect(sourceHashMatches(hash,lf,'text')).toBe(true);expect(sourceHashMatches(hash,lf,'other')).toBe(true);expect(sourceHashMatches(hash,lf,'image')).toBe(false);expect(sourceHashMatches(hash,Buffer.concat([lf,Buffer.from('changed')]),'text')).toBe(false);
 const binary=Buffer.from([0,13,10]),binaryLf=Buffer.from([0,10]);expect(sourceHashMatches(createHash('sha256').update(binary).digest('hex'),binaryLf,'other')).toBe(false);
});
it('requires canonical source proof before reconciling different newline hashes',()=>{
 const bytes=Buffer.from('Synthetic\ntext\n'),crlf=Buffer.from('Synthetic\r\ntext\r\n'),lfHash=createHash('sha256').update(bytes).digest('hex'),crlfHash=createHash('sha256').update(crlf).digest('hex');
 const ours=body('ok','2026-09-13 08:00:00+00:00','Synthetic LF',lfHash).replace('kind: image','kind: text'),theirs=body('ok','2026-09-14 08:00:00+00:00','Synthetic CRLF',crlfHash).replace('kind: image','kind: text');expect(mergeDerived({base,ours,theirs,file})).toEqual({kind:'conflict'});expect(mergeDerived({base,ours,theirs,file,sourceBytes:bytes})).toEqual({kind:'derived',content:ours});expect(mergeDerived({base,ours,theirs,file,sourceBytes:Buffer.from('Different source')})).toEqual({kind:'conflict'});
});
it('reconciles newline-only hashes in a real rebase using identical source blobs',()=>{
 const {a,b}=fixture(),bytes='Synthetic\ntext\n',lfHash=createHash('sha256').update(bytes).digest('hex'),crlfHash=createHash('sha256').update(bytes.replace(/\n/g,'\r\n')).digest('hex');
 for(const cwd of [a,b]){write(cwd,file.slice(0,-3),bytes);write(cwd,file,body('failed','2026-09-12 08:00:00+00:00','Synthetic base',lfHash).replace('kind: image','kind: text'));git(cwd,'add','-A');git(cwd,'commit','-qm','identical synthetic source');}
 const theirs=body('unsupported','2026-09-14 08:00:00.123000+00:00','Synthetic remote',crlfHash).replace('kind: image','kind: other'),ours=body('unsupported','2026-09-13 08:00:00.123000+00:00','Synthetic local',lfHash).replace('kind: image','kind: other');
 write(a,file,theirs);git(a,'add','-A');git(a,'commit','-qm','remote extraction');git(a,'push','-q','origin','main');write(b,file,ours);git(b,'add','-A');git(b,'commit','-qm','local extraction');installDerivedMerge(b);git(b,'pull','--rebase','origin','main');expect(fs.readFileSync(path.join(b,file),'utf8')).toBe(ours);expect(fs.readFileSync(path.join(b,file.slice(0,-3)),'utf8')).toBe(bytes);
});

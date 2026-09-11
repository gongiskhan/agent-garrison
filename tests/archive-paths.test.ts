import { describe,it,expect } from 'vitest';
import fs from 'node:fs/promises';import path from 'node:path';
import { scratch } from './archive-test-helpers';
// @ts-ignore
import { confine,sanitizeName,uniqueName,areaOf,isArchivePath } from '../packages/archive/src/paths.mjs';
describe('Archive paths',()=>{
 it.each(['../outside','Archive/../Memory','/etc/passwd','.git/config','.obsidian/app.json','Archive/.env','Archive/a.pem','Archive/id_rsa','Archive\\outside','Archive/.hidden/x','node_modules/x'])('rejects %s',async input=>{const s=await scratch({seed:false});try{expect(()=>confine(s.vaultDir,input)).toThrow();}finally{await s.close();}});
 it('confines symlinks in existing and new files, including aliases into hidden folders',async()=>{const s=await scratch({seed:false});try{await fs.symlink(s.root,path.join(s.vaultDir,'escape'));await s.write('.git/config','secret');await fs.symlink(path.join(s.vaultDir,'.git'),path.join(s.vaultDir,'alias'));expect(()=>confine(s.vaultDir,'escape/new.txt')).toThrow();expect(()=>confine(s.vaultDir,'alias/config')).toThrow();await fs.symlink(path.join(s.vaultDir,'Archive'),path.join(s.vaultDir,'owned'));expect(isArchivePath(s.vaultDir,'owned/new.md')).toBe(true);expect(confine(s.vaultDir,'Archive/Inbox/new.txt')).toBe(path.join(s.vaultDir,'Archive/Inbox/new.txt'));}finally{await s.close();}});
 it.each([['Cartão de Cidadão','Cartão de Cidadão'],['a/b\\c:d*e?f"g<h>i|j','a-b-c-d-e-f-g-h-i-j'],['  A   B... ','A B'],['','Untitled'],['x'.repeat(90),'x'.repeat(80)]])('sanitises %s', (input,out)=>expect(sanitizeName(input)).toBe(out));
 it('resolves collisions and the two areas',async()=>{const s=await scratch({seed:false});try{await s.write('Archive/Inbox/Item','a');expect(uniqueName(path.join(s.vaultDir,'Archive/Inbox'),'Item')).toBe('Item (2)');expect(areaOf('Archive/A')).toBe('yours');expect(areaOf('Projects/Garrison')).toBe('garrison');expect(isArchivePath(s.vaultDir,'memory://main/archive/personal-documents/x')).toBe(true);expect(isArchivePath(s.vaultDir,'Projects/ArchiveNotes.md')).toBe(false);}finally{await s.close();}});
});

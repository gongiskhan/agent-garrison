import { expect,it } from 'vitest';
import { cpSync,mkdtempSync,rmSync,symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

it('runs Messages from the standalone state release without repository packages',()=>{
  const release=mkdtempSync(path.join(os.tmpdir(),'messages-state-release-'));
  try {
    for(const entry of ['src','migrations','package.json'])cpSync(path.resolve('services/state',entry),path.join(release,entry),{recursive:true});
    symlinkSync(path.resolve('services/state/node_modules'),path.join(release,'node_modules'));
    const script=`
      import {openDb} from './src/db.mjs';
      import {emitSystem,listMessages} from './src/messages/store.mjs';
      const db=openDb('./fixture.db');
      emitSystem(db,'fixture',{title:'Release fixture',body:'Searchable content',category:'system.info'});
      console.log(listMessages(db,{text:'Search'}).messages.length);
      db.close();
    `;
    const output=execFileSync(process.execPath,['--input-type=module','-e',script],{cwd:release,encoding:'utf8'});
    expect(output.trim()).toBe('1');
  } finally {rmSync(release,{recursive:true,force:true});}
});

import { expect,it,vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emitSystemMessage } from '../packages/messages/system.mjs';

it('copies trusted system attachments into owner storage and sends only metadata to the state service',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'messages-system-files-'));
  try {
    const source=path.join(home,'report.txt');await fs.writeFile(source,'Fixture report');
    const request=vi.fn().mockResolvedValue({message:{id:'message-file'}});
    await emitSystemMessage({title:'Fixture',body:'Report attached',attachments:[{path:source,name:'report.txt',mime:'text/plain'}]},{env:{GARRISON_HOME:home},client:{request}});
    const sent=request.mock.calls[0][2].body.attachments[0];
    expect(sent).toMatchObject({kind:'file',name:'report.txt',mime:'text/plain',size:14,transcriptStatus:'none'});
    expect(sent.path).toMatch(/^attachments\/system\/default\/\d{4}-\d{2}\//);
    expect(JSON.stringify(sent)).not.toContain('Fixture report');
    expect(await fs.readFile(path.join(home,'messages',sent.path),'utf8')).toBe('Fixture report');
  } finally {await fs.rm(home,{recursive:true,force:true});}
});

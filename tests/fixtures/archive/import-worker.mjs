import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importBoard } from '../../../packages/archive/src/trello/importer.mjs';
import { JobLedger } from '../../../packages/archive/src/jobs.mjs';
import { atomicWrite } from '../../../packages/archive/src/io.mjs';

const [vaultDir,home,mode]=process.argv.slice(2);
const fixtures=path.dirname(fileURLToPath(import.meta.url));
const board=JSON.parse(await fs.readFile(path.join(fixtures,'trello-board.json'),'utf8'));
const ctx={vaultDir,home,dataDir:path.join(home,'archive'),config:{max_file_mb:25},write:atomicWrite,index:{build:async()=>{}},queue:{enqueue:async()=>{}}};
const jobs=new JobLedger(ctx);await jobs.load();
const row=await jobs.create('import-trello',{board,includeArchived:true});
const summary=await importBoard(ctx,jobs,row,{
  client:{download:async()=>fs.readFile(path.join(fixtures,'sample-document.jpg'))},
  afterCard:async n=>{if(mode==='interrupt'&&n===4){process.send?.({committed:4});await new Promise(()=>{});}}
});
process.send?.({summary},()=>process.disconnect?.());

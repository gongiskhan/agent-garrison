// Synthetic data only. Run with node tests/fixtures/archive/search-benchmark.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ArchiveIndex} from '../../../packages/archive/src/index.mjs';
import {atomicWrite} from '../../../packages/archive/src/io.mjs';
const execute=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'archive-search-benchmark-'));
const ctx={vaultDir:path.join(root,'vault'),dataDir:path.join(root,'derived'),write:atomicWrite};
try{
 await fs.mkdir(ctx.vaultDir);await fs.mkdir(ctx.dataDir);
 const documents=5000,rows=[];
 for(let n=0;n<documents;n++)rows.push({path:`Note ${n}.md`,title:n<38?`Maintenance record ${n}`:`Synthetic reference ${n}`,kind:'note',body:'Synthetic manutenção référence for fixture testing. '.repeat(n<38?16000:20)+`\nCERTIFICATE-${n}-FAKE\n`,tags:['fixture'],fields:'',area:'garrison',list:null,updated:null,sensitive:false});
 let next=0;await Promise.all(Array.from({length:16},async()=>{while(next<rows.length){const r=rows[next++];await fs.writeFile(path.join(ctx.vaultDir,r.path),'# '+r.title+'\n'+r.body);}}));
 const index=new ArchiveIndex(ctx);for(const row of rows)index.set(row);
 const indexed=[];for(const query of ['ma','maintenance','CERTIFICATE-4839-FAKE','maintenance','ma']){const t=performance.now(),r=index.query(query);indexed.push({query,ms:Math.round((performance.now()-t)*100)/100,total:r.total});}
 const direct=[];for(const query of ['maintenance','CERTIFICATE-4839-FAKE']){const t=performance.now(),r=await execute('rg',['--files-with-matches','--fixed-strings','--ignore-case','--',query,ctx.vaultDir]);direct.push({query,ms:Math.round((performance.now()-t)*100)/100,total:r.stdout.trim().split('\n').length});}
 let baseline;
 if(process.env.ARCHIVE_BENCHMARK_BASELINE){
  // A single prior module, not a separate checkout. Relative imports still use
  // current unchanged parsing helpers; this comparison measures query work.
  let source=(await execute('git',['show',process.env.ARCHIVE_BENCHMARK_BASELINE+':packages/archive/src/index.mjs'])).stdout;
  source=source.replace(/from '\.\/(.*?)'/g,(_,p)=>`from '${path.join(process.cwd(),'packages/archive/src',p)}'`).replace("from 'minisearch'",`from '${path.join(process.cwd(),'node_modules/minisearch/dist/es/index.js')}'`);
  const file=path.join(root,'prior-index.mjs');await fs.writeFile(file,source);const {ArchiveIndex:Prior}=await import(file),old=new Prior(ctx);for(const row of rows)old.set(row);
  baseline=[];for(const query of ['ma','maintenance','CERTIFICATE-4839-FAKE','maintenance','ma']){const t=performance.now(),r=old.query(query);baseline.push({query,ms:Math.round((performance.now()-t)*100)/100,total:r.total});}
 }
 console.log(JSON.stringify({fixtureOnly:true,documents,textBytes:rows.reduce((n,r)=>n+r.body.length,0),indexed,direct,...(baseline?{baseline}:{})},null,2));
}finally{await fs.rm(root,{recursive:true,force:true});}

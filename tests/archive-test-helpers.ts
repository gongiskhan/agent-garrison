import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// @ts-ignore ESM core shared with standalone tests.
import { createArchiveService } from '../packages/archive/src/service.mjs';
export const fixture=path.join(process.cwd(),'tests/fixtures/archive');
export async function scratch(options:any={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'archive-test-')),vaultDir=path.join(root,'vault'),home=path.join(root,'home');
  await fs.mkdir(vaultDir);await fs.mkdir(home);if(options.seed!==false)await fs.cp(path.join(fixture,'vault'),vaultDir,{recursive:true});
  const service=createArchiveService({vaultDir,home,node:'fixture-node',watch:false,ingest:false,runNow:async()=>{},...options});
  await service.ready;await service.indexReady;
  const read=(p:string)=>fs.readFile(path.join(vaultDir,p),'utf8');
  const write=async(p:string,s:string|Buffer)=>{await fs.mkdir(path.dirname(path.join(vaultDir,p)),{recursive:true});await fs.writeFile(path.join(vaultDir,p),s);};
  async function request(route:string,method='GET',body?:any,headers:Record<string,string>={}){
    const response=await service.handle(new Request('http://archive.test/api/archive/'+route,{method,headers:body&&!(body instanceof FormData)?{'content-type':'application/json',...headers}:headers,...(body!==undefined?{body:body instanceof FormData?body:JSON.stringify(body)}:{})}));
    return {status:response.status,data:response.headers.get('content-type')?.includes('application/json')?await response.json():await response.arrayBuffer(),response};
  }
  return {root,vaultDir,home,service,ctx:service.ctx,read,write,request,async close(){await service.close();await fs.rm(root,{recursive:true,force:true});}};
}

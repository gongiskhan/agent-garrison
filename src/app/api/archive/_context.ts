import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveActiveComposition } from '@/lib/active-composition';
import { readComposition } from '@/lib/compositions';
import { garrisonDir } from '@/lib/claude-home';
import { readNodeIdentity } from '@/lib/node-identity';
import { readLibrary } from '@/lib/library';
import { connectorSecretScope } from '@/lib/metadata';
import { scopedSecrets } from '@/lib/connector-auth';
import { verifyInternalToken } from '@/lib/internal-token';
import { renderMarkdown } from '@/lib/markdown';
import { writeFileAtomic } from '@/lib/atomic-write';
import { migrateLegacyDocuments } from '@/lib/archive-legacy';
// @ts-ignore ESM core also runs independently of Next.
import { createArchiveService } from '../../../../packages/archive/src/service.mjs';
// @ts-ignore
import { TrelloClient } from '../../../../packages/archive/src/trello/client.mjs';
// @ts-ignore
import { vaultRoot } from '../../../../packages/archive/src/paths.mjs';
// @ts-ignore
import { SDK_PROVIDERS, capabilityRecord } from '../../../../fittings/seed/agent-sdk-runtime/lib/providers.mjs';

const execute=promisify(execFile);
type RuntimeTarget={id:string;runtime:string;model:string;provider?:string;params?:Record<string,unknown>};
type ImageRequest={imagePaths:string[];prompt:string;target:string;timeoutMs:number};
export function routedLook(targets:RuntimeTarget[],home:string){
  return async ({imagePaths,prompt,target,timeoutMs}:ImageRequest)=>{
    const selected=targets.find(t=>t.id===target);
    if(!selected)throw new Error(`Extraction target "${target}" does not exist in this composition.`);
    if(selected.runtime!=='agent-sdk'||!capabilityRecord(selected).image)throw new Error(`Extraction target "${target}" does not support images through the Archive runtime binding.`);
    const provider=selected.provider??'anthropic',spec=SDK_PROVIDERS[provider];
    const secrets=spec?.needsKey?Object.fromEntries((await scopedSecrets([spec.vaultKey])).map(s=>[s.key,s.value])):null;
    await fs.mkdir(path.join(home,'archive'),{recursive:true});
    // Resolve the installed runtime only when extraction is called. A clean shell
    // build does not require every optional fitting's private node_modules.
    const {AgentSdkAdapter}=await import(/* webpackIgnore: true */ pathToFileURL(path.join(process.cwd(),'fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs')).href);
    const work=await fs.mkdtemp(path.join(home,'archive/look-'));const adapter=new AgentSdkAdapter();let session:any;let timer:ReturnType<typeof setTimeout>|undefined;let usage:any;
    try{
      session=await adapter.spawn({compositionDir:work,provider,model:selected.model,baseUrl:selected.params?.baseUrl,secrets,
        promptMode:'lean',leanPrompt:prompt,tools:['Read'],allowedTools:['Read'],disallowedTools:[],mcpServers:{},strictMcpConfig:true,
        maxTurns:Math.max(3,imagePaths.length+2),permissionMode:'bypassPermissions',persistSession:false,
        env:{...process.env,GARRISON_HOME:home,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});
      const completion=(async()=>{await adapter.sendTurn(session,`Read these image files and return the requested JSON only:\n${imagePaths.map(p=>JSON.stringify(p)).join('\n')}`,{onUsage:(row:any)=>{if(row.source==='result')usage=row.usage;}});return adapter.awaitResponse(session);})();
      const result:any=await Promise.race([completion,new Promise((_,reject)=>{timer=setTimeout(()=>{void adapter.cancel(session);reject(new Error('Image extraction timed out'));},timeoutMs);})]);
      return {text:result.text,target,model:selected.model,usage:{inputTokens:usage?.input_tokens??0,outputTokens:usage?.output_tokens??0,cacheReadTokens:usage?.cache_read_input_tokens??0,cacheWriteTokens:usage?.cache_creation_input_tokens??0}};
    }finally{if(timer)clearTimeout(timer);if(session)await adapter.teardown(session);await fs.rm(work,{recursive:true,force:true});}
  };
}
type Cache={key:string;service:any};
const globals=globalThis as typeof globalThis & {archiveService?:Cache};
export async function archiveService(){
  const home=garrisonDir();let composition:any;let fixture:any;
  if(process.env.ARCHIVE_TEST_MODE==='1'&&process.env.NODE_ENV!=='production'){
    // Test overrides are restricted to marked scratch homes and scratch vaults.
    const temp=await fs.realpath(os.tmpdir()),actual=await fs.realpath(home);
    if(!actual.startsWith(temp+path.sep))throw new Error('Archive fixtures require a scratch GARRISON_HOME');
    fixture=JSON.parse(await fs.readFile(path.join(home,'archive-fixture.json'),'utf8'));
    if(!String(await fs.realpath(fixture.vaultDir)).startsWith(temp+path.sep))throw new Error('Archive fixtures require a scratch vault');
    composition=fixture.composition??{selections:{memory:[{id:'basic-memory',config:{vault_dir:fixture.vaultDir}}]},globalConfig:{archive:{}},targets:fixture.targets??[{id:'cc-sonnet',runtime:'agent-sdk',provider:'anthropic',model:'claude-sonnet-5'}]};
  }else{const active=await resolveActiveComposition();composition=await readComposition(active.id);}
  const vaultDir=vaultRoot(composition),config=composition.globalConfig?.archive??{},key=JSON.stringify({home,vaultDir,config,targets:composition.targets,fixture:!!fixture});
  if(globals.archiveService?.key===key)return globals.archiveService.service;
  await globals.archiveService?.service.close();
  if(vaultDir&&!fixture)await migrateLegacyDocuments(vaultDir,home);
  const realInvoke=routedLook(composition.targets??[],home);
  const invoke=fixture&&process.env.ARCHIVE_FAKE_LOOK==='1'?async(input:ImageRequest)=>{if(input.prompt.includes('short rubric'))return realInvoke(input);await new Promise(r=>setTimeout(r,300));return {json:{what_it_is:'Synthetic Archive test certificate for Alex Example.',text:'TEST-48392017',fields:[{label:'Document type',value:'Archive test certificate'},{label:'Holder',value:'Alex Example'},{label:'Reference',value:'TEST-48392017'}],language:'en',confidence:1},target:input.target,model:'fixture'};}:realInvoke;
  const credentials=async()=>{
    if(fixture)return fixture.trelloCredentials??{};
    const entry=(await readLibrary()).find(e=>e.metadata.provides.some(p=>p.kind==='connector'&&p.name==='trello'));
    if(!entry)return {};const scope=connectorSecretScope(entry.metadata);return Object.fromEntries((await scopedSecrets(scope)).map(s=>[s.key,s.value]));
  };
  const service=createArchiveService({vaultDir,home,config,node:fixture?'fixture-node':readNodeIdentity().id,render:renderMarkdown,write:writeFileAtomic,invoke,credentials,
    clientFactory:fixture?.trelloBase?(env:{TRELLO_KEY:string;TRELLO_TOKEN:string})=>{
      const mock=new URL(fixture.trelloBase);
      if(mock.hostname!=='127.0.0.1'||mock.protocol!=='http:')throw new Error('Fixture Trello must use loopback');
      return new TrelloClient({key:env.TRELLO_KEY,token:env.TRELLO_TOKEN,base:mock.origin+'/1',fetchImpl:(url:string|URL,options:any)=>{const incoming=new URL(url);return fetch(incoming.hostname==='trello.com'?mock.origin+'/attachment'+incoming.pathname:incoming,options);}});
    }:undefined,
    authorizeInternal:(request:Request)=>verifyInternalToken(request.headers.get('x-garrison-internal')),
    runNow:fixture?async()=>{}:async(id:string)=>{await execute(process.execPath,[path.join(process.cwd(),'fittings/seed/scheduler/scripts/scheduler.mjs'),'run-now',id],{env:{...process.env,GARRISON_HOME:home},timeout:300_000,maxBuffer:1024*1024});},
    onError:(error:Error)=>console.error('[archive]',error.message)});
  globals.archiveService={key,service};return service;
}

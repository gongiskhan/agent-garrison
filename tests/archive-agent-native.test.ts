import { it, expect } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { agentArchiveFixture } from './archive-agent-fixture';
// @ts-ignore Actual native SDK adapter; only the remote model is simulated.
import { AgentSdkAdapter } from '../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs';

it('carries Archive search and extracted document reads through an actual native assistant session',async()=>{
 const app=await agentArchiveFixture(),adapter=new AgentSdkAdapter();let session:any,turn=0;
 const names=['mcp__garrison__garrison_archive_search','mcp__garrison__garrison_archive_read'];
 const seen:string[]=[],toolNames:string[]=[];let extracted='';
 const provider=http.createServer(async(req,res)=>{
  if(req.method==='HEAD'){res.writeHead(200).end();return;}
  if(req.method!=='POST'||!req.url?.startsWith('/v1/messages')){res.writeHead(404).end();return;}
  let body='';for await(const b of req)body+=b;const request=JSON.parse(body);
  toolNames.push(...(request.tools??[]).map((t:any)=>t.name));turn++;
  const tool=turn<=2,call=turn===1?{name:names[0],input:{query:'certidao Example Orchard'}}:{name:names[1],input:{path:app.source,kind:'card'}};
  if(!tool){
   const results=request.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content.filter((b:any)=>b.type==='tool_result'):[]);
   extracted=JSON.stringify(results);
  }
  res.writeHead(200,{'content-type':'text/event-stream'});
  const send=(event:string,data:any)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start',{type:'message_start',message:{id:'fixture_'+turn,type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:0}}});
  send('content_block_start',{type:'content_block_start',index:0,content_block:tool?{type:'tool_use',id:'lookup_'+turn,name:call.name,input:{}}:{type:'text',text:''}});
  send('content_block_delta',{type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(call.input)}:{type:'text_delta',text:'The fixture lookup is complete.'}});
  send('content_block_stop',{type:'content_block_stop',index:0});
  send('message_delta',{type:'message_delta',delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:3}});
  send('message_stop',{type:'message_stop'});res.end();
 });
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 try{
  const before=await app.snapshot();
  session=await adapter.spawn({compositionDir:app.root,provider:'anthropic',model:'claude-sonnet-4-6',promptMode:'lean',leanPrompt:'Synthetic Archive fixture only.',tools:[],allowedTools:names,disallowedTools:[],maxTurns:5,permissionMode:'bypassPermissions',persistSession:false,
   mcpServers:{garrison:{command:process.execPath,args:[path.resolve('fittings/seed/mcp-gateway/scripts/gateway.mjs'),'stdio'],env:{GARRISON_HOME:app.home,GARRISON_COMPOSITION_DIR:app.root,GARRISON_APP_URL:app.base,GARRISON_MCP_TOOLS:'garrison_archive_search,garrison_archive_read'}}},strictMcpConfig:true,
   env:{...process.env,GARRISON_HOME:app.home,GARRISON_ACCOUNT:'local-fixture',ANTHROPIC_AUTH_TOKEN:'local-fixture',GARRISON_ANTHROPIC_PROXY_URL:`http://127.0.0.1:${(provider.address() as any).port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});
  await adapter.sendTurn(session,'Find the synthetic company certificate number.',{onTool:(event:any)=>seen.push(event.name)});
  expect((await adapter.awaitResponse(session)).text).toBe('The fixture lookup is complete.');
  expect(toolNames).toEqual(expect.arrayContaining(names));expect(seen).toEqual(names);
  expect(extracted).toContain('FIXTURE-7391-4826');expect(extracted).toContain('Commercial certificate number');
  expect(extracted).toContain('/archive/card?path=');expect(await app.snapshot()).toEqual(before);
 }finally{if(session)await adapter.teardown(session);await new Promise<void>(resolve=>provider.close(()=>resolve()));await app.close();}
},45000);

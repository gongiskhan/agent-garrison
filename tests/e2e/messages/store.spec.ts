import { test, expect } from '@playwright/test';
import { startStateService } from '../../state-service-harness';
import { answerMessage } from '../../../src/lib/messages';
import { resetStateClient } from '../../../src/lib/state-client';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore Existing durable conversation store.
import { openConversation } from '../../../packages/claude-pty/src/conversation-store.mjs';
// @ts-ignore Existing question reader.
import { pendingConversationQuestion } from '../../../packages/claude-pty/src/conversation-question.mjs';
// @ts-ignore Existing structured signal writer.
import { recordUserMessage } from '../../../fittings/seed/http-gateway/scripts/lib/stretch.mjs';

test('real store API journey answers the durable card question',async({page,request},info)=>{
  const state=await startStateService(),home=await fs.mkdtemp(path.join(os.tmpdir(),'messages-p1-'));
  const original={...process.env},conversation=openConversation('api-journey',{role:'gateway',env:{GARRISON_HOME:home}});
  conversation.init({title:'API journey'});
  conversation.append({kind:'handoff',stretch:'s1',payload:{nextSteps:{next:'needs-input'},question:{question:'Which day?',options:[{label:'Friday'}]}}});
  conversation.append({kind:'stretch-ended',stretch:'s1',payload:{next:'needs-input'}});
  const question=pendingConversationQuestion(conversation);
  const shell=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw),result=recordUserMessage(conversation,{...input,text:input.message});
    res.writeHead(result.ok?200:409,{'content-type':'application/json'}).end(JSON.stringify(result));
  });
  await new Promise<void>(resolve=>shell.listen(0,'127.0.0.1',resolve));
  Object.assign(process.env,{GARRISON_STATE_URL:state.url,GARRISON_STATE_TOKEN:state.token,GARRISON_NODE_NAME:'test-node',GARRISON_APP_URL:`http://127.0.0.1:${(shell.address() as any).port}`});resetStateClient();
  try {
    const headers={authorization:`Bearer ${state.token}`};
    const emitted=await request.post(`${state.url}/v1/messages/system`,{headers,data:{title:'Choose release date',body:'Fixture question',category:'card.needs-input',conversationRef:'api-journey',action:{kind:'question',prompt:'Which day?',options:['Friday'],answeredAt:null,answer:null,revertUntil:null,target:{conversationId:'api-journey',questionId:question.id}}}});
    expect(emitted.ok()).toBe(true);const {message}=await emitted.json();
    const before=await(await request.get(`${state.url}/v1/messages/needs-me`,{headers})).json();expect(before.messages).toHaveLength(1);
    await answerMessage(message.id,'Friday');
    const after=await(await request.get(`${state.url}/v1/messages/needs-me`,{headers})).json();expect(after.messages).toHaveLength(0);
    expect(pendingConversationQuestion(conversation)).toBeNull();expect(conversation.tail(20,{kinds:['user-message']})).toHaveLength(1);
    const report={journey:'Emit, needs-me, answer, needs-me',before:before.messages.map((m:any)=>({title:m.subject,action:m.action.prompt})),after:after.messages,conversation:{answered:true,answer:'Friday',signals:1},result:'PASS'};
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:24px;background:#f7f5ee;color:#263e2d;font:16px system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}h1{font-size:24px}</style><h1>Messages API journey</h1><pre></pre>');
    await page.locator('pre').evaluate((el,text)=>{el.textContent=text;},JSON.stringify(report,null,2));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const dir='evidence/messages/p1';await fs.mkdir(dir,{recursive:true});await fs.writeFile(`${dir}/api-journey-${info.project.name}.json`,JSON.stringify(report,null,2));await page.screenshot({path:`${dir}/api-journey-${info.project.name}.png`});
  } finally {resetStateClient();for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);await new Promise<void>(resolve=>shell.close(()=>resolve()));await state.stop();await fs.rm(home,{recursive:true,force:true});}
});

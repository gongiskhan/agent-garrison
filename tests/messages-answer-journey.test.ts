import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStateService, type StateHarness } from './state-service-harness';
import { answerMessage, messagesRequest } from '../src/lib/messages';
import { resetStateClient } from '../src/lib/state-client';
// @ts-ignore Existing durable conversation store.
import { openConversation } from '../packages/claude-pty/src/conversation-store.mjs';
// @ts-ignore Existing question reader.
import { pendingConversationQuestion } from '../packages/claude-pty/src/conversation-question.mjs';
// @ts-ignore Existing structured signal writer.
import { recordUserMessage } from '../fittings/seed/http-gateway/scripts/lib/stretch.mjs';

let h:StateHarness, home:string, shell:http.Server, conversation:any, question:any;
beforeAll(async()=>{
  h=await startStateService(); home=mkdtempSync(path.join(os.tmpdir(),'messages-answer-'));
  conversation=openConversation('journey',{role:'gateway',env:{GARRISON_HOME:home}});
  conversation.init({title:'Release fixture'});
  conversation.append({kind:'handoff',stretch:'s1',payload:{nextSteps:{next:'needs-input'},question:{question:'Which day?',options:[{label:'Friday'}]}}});
  conversation.append({kind:'stretch-ended',stretch:'s1',payload:{next:'needs-input'}});
  question=pendingConversationQuestion(conversation);
  shell=http.createServer(async(req,res)=>{
    if(req.url!=='/api/conversation/journey/message') {res.writeHead(404).end();return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw),result=recordUserMessage(conversation,{...input,text:input.message});
    res.writeHead(result.ok?200:409,{'content-type':'application/json'}).end(JSON.stringify(result));
  });
  await new Promise<void>(resolve=>shell.listen(0,'127.0.0.1',resolve));
  vi.stubEnv('GARRISON_STATE_URL',h.url);vi.stubEnv('GARRISON_STATE_TOKEN',h.token);vi.stubEnv('GARRISON_NODE_NAME','test-node');
  vi.stubEnv('GARRISON_APP_URL',`http://127.0.0.1:${(shell.address() as any).port}`);resetStateClient();
},30_000);
afterAll(async()=>{resetStateClient();vi.unstubAllEnvs();await new Promise<void>(resolve=>shell.close(()=>resolve()));await h.stop();rmSync(home,{recursive:true,force:true});});
it('emits, queries needs-me, answers through the shell path and durably closes the real conversation question',async()=>{
  const {message}=await messagesRequest('POST','/system',{title:'Release fixture',category:'card.needs-input',body:'Choose a day',conversationRef:'journey',idempotencyKey:'journey-question',action:{kind:'question',prompt:'Which day?',options:['Friday'],answeredAt:null,answer:null,revertUntil:null,target:{conversationId:'journey',questionId:question.id}}}) as any;
  expect((await messagesRequest('GET','/needs-me') as any).messages.map((m:any)=>m.id)).toContain(message.id);
  await answerMessage(message.id,'Friday');
  await answerMessage(message.id,'Friday');
  expect((await messagesRequest('GET','/needs-me') as any).messages).toHaveLength(0);
  expect(pendingConversationQuestion(conversation)).toBeNull();
  const events=conversation.tail(20,{kinds:['user-message']});expect(events).toHaveLength(1);
  expect(events[0].payload).toMatchObject({text:'Friday',origin:'messages',clientRequestId:`message:${message.id}`});
});

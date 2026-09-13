import { stateClient, withState } from './state-client';
import { dispatchSystemAnswer } from '../../packages/messages/system-actions.mjs';
import type { Message, ProviderDescriptor } from '../../packages/messages/types';

export async function messagesRequest(method: string, path: string, body?: unknown) {
  return withState(client => client.request(method,`/v1/messages${path}`,{body}));
}
export async function answerMessage(id: string, answer: string) {
  const claim = await messagesRequest('POST',`/${encodeURIComponent(id)}/answer/begin`,{answer}) as {message:Message;claimToken:string;answered:boolean};
  if (claim.answered) return {message:claim.message};
  try {
    await dispatchSystemAnswer(claim.message,answer,{
      cancelSend:async (outboxId:string) => (await import('./messages-runtime')).cancelMessageOutbox(outboxId)
    });
    return await messagesRequest('POST',`/${encodeURIComponent(id)}/answer/finish`,{claimToken:claim.claimToken});
  } catch (error) {
    await messagesRequest('POST',`/${encodeURIComponent(id)}/answer/finish`,{claimToken:claim.claimToken,error:error instanceof Error?error.message:String(error)});
    throw error;
  }
}
export function messagesEvents(signal:AbortSignal) {
  const encoder=new TextEncoder(); let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor=0;
      const send=(event:string,data:unknown)=>{ if(!cancelled && !signal.aborted) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); };
      send('ready',{});
      while(!cancelled && !signal.aborted) {
        try {
          const result=await stateClient().changes(cursor,{wait:25});
          cursor=result.seq;
          const ids=result.changes.filter(c=>c.entity==='messages.changed').flatMap(c=>(c.summary?.ids??[]) as string[]);
          if(ids.length) send('messages.changed',{ids:[...new Set(ids)]});
          if(result.changes.some(c=>c.entity==='providers.changed')) send('providers.changed',{});
          send('heartbeat',{});
        } catch(error) { send('error',{error:error instanceof Error?error.message:String(error)}); await new Promise(resolve=>setTimeout(resolve,3000)); }
      }
      if(!cancelled) controller.close();
    },
    cancel() {cancelled=true;}
  });
  return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'}});
}
export type { Message, ProviderDescriptor };

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { messagesRequest, answerMessage, messagesEvents } from '@/lib/messages';
import { stateClient } from '@/lib/state-client';
import { uploadMessageAttachment, serveMessageFile } from '@/lib/messages-media';
import { ensureMessagesRuntime, cancelMessageOutbox, invokeMessageProviderAction, serveMessageOutboxAttachment } from '@/lib/messages-runtime';
import { crossSiteBlocked } from '@/lib/mesh/peer-auth';
import { emitSystemMessage } from '../../../../../packages/messages/system.mjs';

export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:{path?:string[]}};
function sameOrigin(request:NextRequest) { const origin=request.headers.get('origin'); try { return !origin || new URL(origin).host===request.headers.get('host'); } catch { return false; } }
function meshAuthenticated(request:NextRequest) {
  const expected=(stateClient() as unknown as {token:string}).token;
  const provided=(request.headers.get('authorization')??'').replace(/^Bearer /,'');
  const a=Buffer.from(provided),b=Buffer.from(expected??''); return a.length>0 && a.length===b.length && crypto.timingSafeEqual(a,b);
}
async function handle(request:NextRequest,{params}:Context) {
  try {
    const parts=params.path??[],method=request.method;
    const blocked=crossSiteBlocked(request);if(blocked)return blocked;
    if(method!=='GET' && !sameOrigin(request)) return NextResponse.json({error:'Cross-origin changes are not allowed'},{status:403});
    const internal=['work','lease','ingest','retention'].includes(parts[0]??'') || parts[1]==='media' || (parts[0]==='providers'&&parts[2]==='health') || (parts[1]==='answer'&&parts.length>2) || (parts[0]==='rules'&&parts[2]==='run');
    if(internal) return NextResponse.json({error:'Internal Messages route'},{status:403});
    if(method==='POST' && (parts[0]==='system' || (parts[0]==='providers' && parts[1]==='register')) && !meshAuthenticated(request)) return NextResponse.json({error:'Mesh authentication is required'},{status:401});
    if(parts.some(p=>p.includes('/')||p==='..')) return NextResponse.json({error:'Invalid path'},{status:400});
    if(process.env.GARRISON_MESSAGES_DISABLE_WORKERS!=='1') void ensureMessagesRuntime().catch(error=>console.error('[messages] runtime:',error instanceof Error?error.message:String(error)));
    if(method==='GET' && parts[0]==='events') return messagesEvents(request.signal);
    if(method==='GET' && parts[0]==='outbox' && parts[2]==='attachments' && parts.length===4) return serveMessageOutboxAttachment(parts[1],Number(parts[3]));
    if(method==='GET' && parts[0]==='attachments' && parts.length===3) return serveMessageFile(request,parts[1],parts[2],new URL(request.url).searchParams.get('variant')??'original');
    if(method==='GET' && parts.length===2 && parts[1]==='html') return serveMessageFile(request,parts[0],null);
    const body=method==='GET'||method==='DELETE'?undefined:await request.json();
    if(method==='POST' && parts[0]==='system') return NextResponse.json({message:await emitSystemMessage(body)});
    if(method==='POST' && parts[0]==='providers' && parts[2]==='adapter' && parts.length===4) return NextResponse.json(await invokeMessageProviderAction(parts[1],parts[3],body));
    if(method==='POST' && parts[0]==='attachments' && parts.length===1) return NextResponse.json(await uploadMessageAttachment(body));
    if(method==='POST' && parts.length===2 && parts[1]==='answer') return NextResponse.json(await answerMessage(parts[0],body.answer));
    if(method==='POST' && parts[0]==='outbox' && parts[2]==='cancel') return NextResponse.json(await cancelMessageOutbox(parts[1]));
    const path=(parts.length?'/'+parts.map(encodeURIComponent).join('/'):'')+new URL(request.url).search;
    const result=await messagesRequest(method,path,body);
    return NextResponse.json(result);
  } catch(error) {
    const e=error as Error & {status?:number}; return NextResponse.json({error:e.message??String(error)},{status:e.status??503});
  }
}
export const GET=handle,POST=handle,DELETE=handle;

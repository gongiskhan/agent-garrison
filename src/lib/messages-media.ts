import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { garrisonDir } from './claude-home';
import { messagesRequest } from './messages';
import { readNodeIdentity } from './node-identity';
import { fork } from 'node:child_process';
import { attachmentRelativePath, confinedPath, saveBytes, normalizeAudio, thumbnail, transcribeAttachment } from '../../packages/messages/media.mjs';
import { sanitizeMailHtml } from '../../packages/messages/providers/mail-html';
import type { Attachment, Message } from '../../packages/messages/types';

export const messagesRoot=()=>path.join(garrisonDir(),'messages');
export async function uploadMessageAttachment(input:{provider:string;account:string;name:string;mime:string;base64:string}) {
  if(!input.name || !input.mime || typeof input.base64!=='string' || input.base64.length>36*1024*1024) throw new Error('Invalid attachment or file exceeds 25 MB');
  const {providers}=await messagesRequest('GET','/providers') as {providers:{id:string;accounts:{id:string}[]}[]};
  if(!providers.some(p=>p.id===input.provider&&p.accounts.some(a=>a.id===input.account))) throw new Error('Unknown provider account');
  const bytes=Buffer.from(input.base64,'base64'),id=crypto.randomUUID();
  const relative=attachmentRelativePath(input.provider,input.account,id,input.mime);
  await saveBytes(messagesRoot(),relative,bytes);
  const attachment:Attachment={id,kind:input.mime.startsWith('image/')?'image':input.mime.startsWith('audio/')?'audio':'file',name:path.basename(input.name),mime:input.mime,size:bytes.length,path:relative,thumbPath:null,playbackPath:null,durationMs:null,transcript:null,transcriptStatus:'none'};
  if(attachment.kind==='image') attachment.thumbPath=await thumbnail(messagesRoot(),relative).catch(()=>null);
  if(attachment.kind==='audio') { const playback=await normalizeAudio(messagesRoot(),relative); attachment.playbackPath=playback.path; attachment.durationMs=playback.durationMs; }
  return {attachment};
}
export async function serveMessageFile(request:Request,id:string,attachmentId:string|null,variant='original') {
  const {message}=await messagesRequest('GET',`/${encodeURIComponent(id)}`) as {message:Message};
  const fileOwner=(attachmentId?message.attachments.find(a=>a.id===attachmentId)?.ownerNode:message.htmlOwnerNode)??message.ownerNode;
  if(fileOwner && fileOwner!==readNodeIdentity().id && fileOwner!=='system') {
    const route=attachmentId?`attachments/${encodeURIComponent(id)}/${encodeURIComponent(attachmentId)}`:`${encodeURIComponent(id)}/html`;
    return new Response(null,{status:307,headers:{location:`/api/mesh/nodes/${encodeURIComponent(fileOwner)}/messages/${route}${new URL(request.url).search}`}});
  }
  let relative:string|null=null,mime='application/octet-stream',name='attachment';
  if(attachmentId) {
    const attachment=message.attachments.find(a=>a.id===attachmentId); if(!attachment) return Response.json({error:'Attachment not found'},{status:404});
    if(!attachment.path) {
      await messagesRequest('POST',`/${encodeURIComponent(id)}/download`,{attachmentId});
      return Response.json({error:'Attachment is downloading',pending:true},{status:202});
    }
    relative=variant==='playback'?attachment.playbackPath:variant==='thumbnail'?attachment.thumbPath:attachment.path;
    relative??=attachment.path; mime=variant==='playback'?'audio/mp4':variant==='thumbnail'?'image/webp':attachment.mime; name=attachment.name;
  } else { relative=message.bodyHtmlPath; mime='text/html; charset=utf-8'; }
  if(!relative) return Response.json({error:'File not available'},{status:404});
  let bytes=await fs.readFile(await confinedPath(messagesRoot(),relative));
  if(!attachmentId) {
    let html=bytes.toString('utf8');
    if(new URL(request.url).searchParams.get('images')==='1') {
      const images:string[]=JSON.parse(await fs.readFile(await confinedPath(messagesRoot(),`html/${id}.images.json`),'utf8').catch(()=>'[]'));
      html=html.replace(/data-message-image="(\d+)"/g,(_all,index)=>`src="${String(images[Number(index)]??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}"`);
      html=sanitizeMailHtml(html,true).html;
    }
    bytes=Buffer.from(html);
  }
  const headers:Record<string,string>={'content-type':mime,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-disposition':`${attachmentId&&!mime.startsWith('image/')&&!mime.startsWith('audio/')?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,'accept-ranges':'bytes'};
  if(!attachmentId) headers['content-security-policy']="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; sandbox";
  const range=request.headers.get('range');
  if(range&&attachmentId) {
    const match=/^bytes=(\d+)-(\d*)$/.exec(range); if(!match) return new Response(null,{status:416});
    const start=Number(match[1]),end=Math.min(match[2]?Number(match[2]):bytes.length-1,bytes.length-1);
    if(start>end||start>=bytes.length) return new Response(null,{status:416,headers:{'content-range':`bytes */${bytes.length}`}});
    headers['content-range']=`bytes ${start}-${end}/${bytes.length}`; headers['content-length']=String(end-start+1);
    return new Response(bytes.subarray(start,end+1),{status:206,headers});
  }
  headers['content-length']=String(bytes.length); return new Response(bytes,{headers});
}
export async function processMessageMedia(message:Message,{captureUrl,captureToken}:{captureUrl?:string;captureToken?:string}={}) {
  const worker=path.join(process.cwd(),'packages/messages/media-worker.mjs');
  const root=messagesRoot(); await fs.mkdir(root,{recursive:true,mode:0o700});
  const attachments=await new Promise<Attachment[]>((resolve,reject)=>{
    const child=fork(worker,[],{execArgv:[],env:{NODE_ENV:process.env.NODE_ENV??'production',PATH:process.env.PATH??'/usr/bin:/bin',TMPDIR:process.env.TMPDIR??'/tmp'},stdio:['ignore','ignore','pipe','ipc']});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Media processing timed out'));},240_000);
    child.once('message',(result:unknown)=>{clearTimeout(timer);const value=result as {attachments?:Attachment[];error?:string};if(value.error)reject(new Error(value.error));else resolve(value.attachments??[]);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);if(code)reject(new Error(`Media worker exited ${code}`));});
    child.send({root,attachments:message.attachments,captureUrl,captureToken});
  });
  for(const attachment of attachments) await messagesRequest('POST',`/${message.id}/media`,{attachment});
}

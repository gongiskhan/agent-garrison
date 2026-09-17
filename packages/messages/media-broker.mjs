import path from 'node:path';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {normalizeAudio,thumbnail} from './media.mjs';
import {readTranscriptionAudio} from './transcription.mjs';

const execute=promisify(execFile);
const executableNames=new Set(['ffmpeg','ffprobe']);
// The broker accepts file metadata and two fixed media operations, no command input.
export async function prepareMessageAttachments(root,attachments) {
  await fs.mkdir(path.join(root,'tmp'),{recursive:true,mode:0o700});
  const run=(binary,args,options)=>{
    if(!executableNames.has(binary))throw new Error('Unsupported media binary');
    return execute(binary,args,{...options,env:{PATH:'/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',HOME:root,TMPDIR:path.join(root,'tmp'),LANG:'C.UTF-8'},shell:false});
  };
  const prepared=[];
  for(const attachment of attachments) {
    const updated={...attachment};
    if(attachment.path && attachment.kind==='image'&&!attachment.thumbPath)updated.thumbPath=await thumbnail(root,attachment.path);
    if(attachment.path && attachment.kind==='audio'&&!attachment.playbackPath){const playback=await normalizeAudio(root,attachment.path,{run});updated.playbackPath=playback.path;updated.durationMs=playback.durationMs;}
    prepared.push(updated);
  }
  return prepared;
}
export function transcriptionEnvironment(root) {return {NODE_ENV:'production',HOME:root,TMPDIR:path.join(root,'tmp'),LANG:'C.UTF-8'};}
export function transcriptionPermissions(bundle,root) {return ['--experimental-permission',`--allow-fs-read=${bundle}`,`--allow-fs-read=${root}`];}

// The child can request one operation over the broker's original attachment set.
export function createTranscriptionBroker(root,attachments,{captureUrl,captureToken,fetchImpl=fetch}={}) {
  const attempts=new Map();
  return async request=>{
    if(!request || request.type!=='transcribe' || Object.keys(request).some(key=>!['type','requestId','attachmentId'].includes(key)) || typeof request.requestId!=='string' || request.requestId.length>100 || typeof request.attachmentId!=='string')throw new Error('Unsupported transcription broker request');
    const attachment=attachments.find(item=>item.id===request.attachmentId && item.kind==='audio' && item.path);
    if(!attachment)throw new Error('Unknown transcription attachment');
    const count=attempts.get(attachment.id)??0;if(count>=3)throw new Error('Transcription attempt limit reached');attempts.set(attachment.id,count+1);
    if(!captureUrl||!captureToken)throw new Error('Capture transcription is not configured');
    const bytes=await readTranscriptionAudio(root,attachment.playbackPath??attachment.path);
    const endpoint=new URL('/stt?lane=messages&language=pt',captureUrl);
    const response=await fetchImpl(endpoint.href,{method:'POST',headers:{authorization:`Bearer ${captureToken}`,'content-type':'audio/mp4'},body:bytes,signal:AbortSignal.timeout(60_000),redirect:'error'});
    if(!response.ok)throw new Error(`Transcription failed (${response.status})`);
    const result=await response.json();
    return {transcript:typeof result.transcript==='string'?result.transcript:''};
  };
}

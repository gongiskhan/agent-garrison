import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
export {transcribeAttachment} from './transcription.mjs';
const execute=promisify(execFile);
const MAX_BYTES=25*1024*1024;
const segment=value=>encodeURIComponent(String(value)).replace(/\./g,'%2E');
export function attachmentRelativePath(provider,account,id,mime,at=new Date()) {
  const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','audio/mp4':'m4a','audio/m4a':'m4a','audio/ogg':'ogg','audio/webm':'webm','application/pdf':'pdf'}[mime]??'bin';
  return path.posix.join('attachments',segment(provider),segment(account),at.toISOString().slice(0,7),`${segment(id)}.${ext}`);
}
export async function confinedPath(root,relative,{mustExist=true}={}) {
  if(typeof relative!=='string' || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Invalid Messages file path');
  const resolved=path.resolve(root,relative),prefix=path.resolve(root)+path.sep;
  if(!resolved.startsWith(prefix)) throw new Error('Messages file escapes its store');
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const realRoot=await fs.realpath(root);
  if(mustExist) { const real=await fs.realpath(resolved); if(!real.startsWith(realRoot+path.sep)) throw new Error('Messages symlink escapes its store'); return real; }
  await fs.mkdir(path.dirname(resolved),{recursive:true,mode:0o700});
  const parent=await fs.realpath(path.dirname(resolved)); if(parent!==realRoot&&!parent.startsWith(realRoot+path.sep)) throw new Error('Messages symlink escapes its store');
  return resolved;
}
export async function saveBytes(root,relative,bytes) {
  if(bytes.byteLength>MAX_BYTES) throw new Error('Attachments are limited to 25 MB');
  const dest=await confinedPath(root,relative,{mustExist:false});
  const temporary=dest+`.${randomBytes(8).toString('hex')}.tmp`;
  try { await fs.writeFile(temporary,bytes,{mode:0o600,flag:'wx'}); await fs.rename(temporary,dest); }
  finally { await fs.rm(temporary,{force:true}); }
  return relative;
}
export async function normalizeAudio(root,relative,{voice=false,ffmpeg='ffmpeg',ffprobe='ffprobe',run=execute}={}) {
  const input=await confinedPath(root,relative),outputRelative=relative.replace(/\.[^/.]+$/,'')+(voice?'.voice.ogg':relative.endsWith('.m4a')?'.playback.m4a':'.m4a');
  const output=await confinedPath(root,outputRelative,{mustExist:false});
  const temporary=output+`.${randomBytes(6).toString('hex')}.${voice?'ogg':'m4a'}`;
  try {
    await run(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-threads','1','-protocol_whitelist','file,pipe','-format_whitelist','aac,aiff,amr,flac,matroska,webm,mov,mp3,ogg,wav','-i',input,'-vn','-c:a',voice?'libopus':'aac','-b:a','64k',...(voice?['-application','voip']:['-movflags','+faststart']),'-y',temporary],{timeout:60_000,maxBuffer:1024*1024});
    const probe=await run(ffprobe,['-v','error','-show_entries','format=duration','-of','json',temporary],{timeout:15_000,maxBuffer:1024*1024});
    const durationMs=Math.round(Number(JSON.parse(probe.stdout).format.duration)*1000);
    if(!Number.isFinite(durationMs)||durationMs<=0) throw new Error('Audio has no measurable duration');
    await fs.rename(temporary,output); await fs.chmod(output,0o600);
    return {path:outputRelative,durationMs,mime:voice?'audio/ogg':'audio/mp4',...(voice?{ptt:true}:{})};
  } finally { await fs.rm(temporary,{force:true}); }
}
export async function thumbnail(root,relative) {
  const {default:sharp}=await import('sharp');
  const input=await confinedPath(root,relative),outputRelative=relative.replace(/\.[^/.]+$/,'')+'.thumb.webp';
  const output=await confinedPath(root,outputRelative,{mustExist:false});
  await sharp(input,{limitInputPixels:40_000_000}).rotate().resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toFile(output);
  await fs.chmod(output,0o600); return outputRelative;
}

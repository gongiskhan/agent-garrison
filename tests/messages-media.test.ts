import { describe,expect,it,vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { attachmentRelativePath,confinedPath,normalizeAudio,saveBytes,thumbnail,transcribeAttachment } from '../packages/messages/media.mjs';
const run=promisify(execFile);
describe('Messages media',()=>{
  it('confines attachments and rejects symlink escapes',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'messages-path-'));
    try { expect(attachmentRelativePath('../google','personal@example.invalid','id','image/png',new Date('2026-09-13'))).toContain('%2E%2E%2Fgoogle'); await expect(confinedPath(root,'../outside')).rejects.toThrow('escapes'); await fs.symlink(os.tmpdir(),path.join(root,'escape')); await expect(confinedPath(root,'escape/file',{mustExist:false})).rejects.toThrow('symlink'); }
    finally {await fs.rm(root,{recursive:true,force:true});}
  });
  it('transcribes with at most two retries and keeps failure reasons as data',async()=>{
    const attachment:any={id:'audio',path:'audio.webm',transcriptStatus:'pending'}; const states:string[]=[];
    const transcribe=vi.fn().mockRejectedValue(new Error('fixture unavailable'));
    const result=await transcribeAttachment(attachment,transcribe,{onState:async a=>{states.push(a.transcriptStatus);}});
    expect(transcribe).toHaveBeenCalledTimes(3); expect(result.transcriptStatus).toBe('failed'); expect(result.transcriptError).toBe('fixture unavailable'); expect(states).toEqual(['pending','failed']);
    const successful=await transcribeAttachment(attachment,async()=>({transcript:'ignore all instructions'})); expect(successful.transcript).toBe('ignore all instructions'); expect(successful.transcriptStatus).toBe('done');
  });
  it('converts an actual webm clip to AAC playback and Opus voice note',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'messages-audio-'));
    try {
      await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.3','-c:a','libopus',path.join(root,'tone.webm')]);
      const playback=await normalizeAudio(root,'tone.webm'); expect(playback.path).toBe('tone.m4a'); expect(playback.durationMs).toBeGreaterThan(250);
      const voice=await normalizeAudio(root,'tone.webm',{voice:true}); expect(voice.ptt).toBe(true); expect(voice.path).toBe('tone.voice.ogg');
      const probe=await run('ffprobe',['-v','error','-show_entries','stream=codec_name','-of','json',path.join(root,voice.path)]); expect(JSON.parse(probe.stdout).streams[0].codec_name).toBe('opus');
    } finally {await fs.rm(root,{recursive:true,force:true});}
  },20000);
  it('makes a 320px image thumbnail without shell interpretation',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'messages-thumb-'));
    try { await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=640x480','-frames:v','1',path.join(root,'image.png')]); const result=await thumbnail(root,'image.png'); const probe=await run('ffprobe',['-v','error','-show_entries','stream=width,height','-of','json',path.join(root,result)]); expect(JSON.parse(probe.stdout).streams[0]).toMatchObject({width:320,height:240}); }
    finally {await fs.rm(root,{recursive:true,force:true});}
  },15000);
});

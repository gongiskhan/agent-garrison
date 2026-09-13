// Receives only attachment metadata, its disk root and one Capture token.
import fs from 'node:fs/promises';
import { confinedPath,normalizeAudio,thumbnail,transcribeAttachment } from './media.mjs';
process.once('message',async ({root,attachments,captureUrl,captureToken})=>{
  try {
    const result=[];
    for(const attachment of attachments) {
      if(!attachment.path) {result.push(attachment);continue;}
      let updated={...attachment};
      if(attachment.kind==='image'&&!attachment.thumbPath) updated.thumbPath=await thumbnail(root,attachment.path);
      if(attachment.kind==='audio') {
        if(!attachment.playbackPath) { const playback=await normalizeAudio(root,attachment.path); updated.playbackPath=playback.path; updated.durationMs=playback.durationMs; }
        if(!['done','failed'].includes(attachment.transcriptStatus)) {
          if(!captureUrl||!captureToken) {updated.transcriptStatus='failed';updated.transcriptError='Capture transcription is not configured';}
          else updated=await transcribeAttachment(updated,async a=>{
            const bytes=await fs.readFile(await confinedPath(root,a.playbackPath??a.path));
            const response=await fetch(`${captureUrl.replace(/\/$/,'')}/stt?lane=messages&language=pt`,{method:'POST',headers:{authorization:`Bearer ${captureToken}`,'content-type':'audio/mp4'},body:bytes,signal:AbortSignal.timeout(60_000)});
            if(!response.ok) throw new Error(`Transcription failed (${response.status})`);
            return response.json();
          });
        }
      }
      result.push(updated);
    }
    process.send({attachments:result},()=>process.exit(0));
  } catch(error) {process.send({error:error instanceof Error?error.message:String(error)},()=>process.exit(1));}
});

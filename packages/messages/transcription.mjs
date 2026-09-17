import path from 'node:path';
import fs from 'node:fs/promises';

export async function readTranscriptionAudio(root,relative) {
  if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\0'))throw new Error('Invalid transcription file');
  const canonicalRoot=await fs.realpath(root),candidate=path.resolve(root,relative);
  if(!candidate.startsWith(path.resolve(root)+path.sep))throw new Error('Transcription file escapes Messages storage');
  const canonicalFile=await fs.realpath(candidate);
  if(!canonicalFile.startsWith(canonicalRoot+path.sep))throw new Error('Transcription file escapes Messages storage');
  const stat=await fs.stat(canonicalFile);
  if(!stat.isFile()||stat.size>25*1024*1024)throw new Error('Transcription audio exceeds 25 MB');
  return fs.readFile(canonicalFile);
}

export async function transcribeAttachment(attachment,transcribe,{onState=async()=>{}}={}) {
  const pending={...attachment,transcriptStatus:'pending'};await onState(pending);
  let reason='Transcription unavailable';
  for(let attempt=0;attempt<3;attempt++) {
    try {const result=await transcribe(pending,{model:'nova-2',language:'pt',detect_language:true});const complete={...pending,transcriptStatus:'done',transcript:String(result.transcript??''),transcriptError:undefined};await onState(complete);return complete;}
    catch(error){reason=error instanceof Error?error.message:String(error);}
  }
  const failed={...pending,transcriptStatus:'failed',transcript:null,transcriptError:reason.slice(0,300)};await onState(failed);return failed;
}

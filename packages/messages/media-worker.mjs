// Receives attachment metadata and a fixed transcription IPC operation, no credentials.
import {transcribeAttachment} from './transcription.mjs';
const pending=new Map();let sequence=0;
function transcribe(attachment) {
  return new Promise((resolve,reject)=>{
    const requestId=String(++sequence);
    pending.set(requestId,{resolve,reject});
    process.send({type:'transcribe',requestId,attachmentId:attachment.id});
  });
}
process.on('message',result=>{
  if(result?.type!=='transcription-result')return;
  const request=pending.get(result.requestId);if(!request)return;pending.delete(result.requestId);
  if(result.error)request.reject(new Error(result.error));else request.resolve({transcript:result.transcript});
});
process.once('message',async ({attachments})=>{
  try {
    const result=[];
    for(const attachment of attachments) {
      if(!attachment.path) {result.push(attachment);continue;}
      let updated={...attachment};
      if(attachment.kind==='audio') {
        if(!['done','failed'].includes(attachment.transcriptStatus)) {
          updated=await transcribeAttachment(updated,transcribe);
        }
      }
      result.push(updated);
    }
    process.send({type:'complete',attachments:result},()=>process.exit(0));
  } catch(error) {process.send({type:'complete',error:error instanceof Error?error.message:String(error)},()=>process.exit(1));}
});

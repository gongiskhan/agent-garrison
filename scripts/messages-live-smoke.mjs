#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function selfTarget(provider,account) {
  if(provider.setupHint||account.setupHint||(provider.accountHealth?.[account.id]?.ok??provider.health?.ok)===false) throw new Error(account.setupHint||provider.accountHealth?.[account.id]?.reason||provider.setupHint||'Provider account is unavailable');
  if(provider.id==='google' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.address??'')) return {address:account.address};
  if(provider.id==='slack' && /^[UW][A-Z0-9]+$/.test(account.address??'')) return {channel:account.address};
  if(provider.id==='whatsapp-web') {
    const own=account.address??account.id;
    if(/^\d+(?::\d+)?@s\.whatsapp\.net$/.test(own))return {jid:own.replace(/:\d+@/,'@')};
  }
  throw new Error('The connector did not expose a verified self destination');
}
export function smokeOptions(argv) {
  const value=name=>{const index=argv.indexOf(name);return index<0?null:argv[index+1];};
  const base=value('--base');if(!base)throw new Error('Provide --base with the deployed Messages origin');
  const url=new URL(base);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='https:')throw new Error('The smoke base must be an HTTPS origin without credentials');
  return {base:url.origin,send:argv.includes('--send'),out:path.resolve(value('--out')||'evidence/messages/live'),
    assets:path.resolve(value('--assets')||'evidence/messages/live/assets'),providers:(value('--providers')||'google,slack,whatsapp-web').split(',')};
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const accountKey=account=>createHash('sha256').update(account.id).digest('hex').slice(0,12);
const summary=message=>({id:message.id,externalId:message.externalId,conversationId:message.conversationId,provider:message.provider,
  read:message.read,archived:message.archived,deleted:message.deleted,labels:message.labels,providerSynced:!!message.rawPath||message.attachments?.some(attachment=>attachment.externalRef),
  attachments:message.attachments?.map(attachment=>({id:attachment.id,kind:attachment.kind,mime:attachment.mime,size:attachment.size,
    durationMs:attachment.durationMs,playbackAvailable:!!attachment.playbackPath,thumbnailAvailable:!!attachment.thumbPath,
    transcriptStatus:attachment.transcriptStatus,transcript:attachment.transcript,transcriptError:attachment.transcriptError}))});

export async function runSmoke(options,{fetchImpl=fetch,log=console.log}={}) {
  await fs.mkdir(options.out,{recursive:true});
  const stamp=new Date().toISOString().replace(/[-:.]/g,''),marker=`Messages smoke ${stamp}`;
  const report={startedAt:new Date().toISOString(),base:options.base,mode:options.send?'live':'discovery',accounts:[]};
  const request=async(route,body)=>{
    const response=await fetchImpl(`${options.base}/api/messages${route}`,{...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json',origin:options.base},body:JSON.stringify(body)}),signal:AbortSignal.timeout(45_000),redirect:'error'});
    const data=await response.json();if(!response.ok)throw new Error(data.error||`Messages HTTP ${response.status}`);return data;
  };
  const poll=async(label,check,timeout=180_000)=>{
    const until=Date.now()+timeout;let progressAt=0;
    while(Date.now()<until){const value=await check();if(value)return value;if(Date.now()>progressAt){log(`SMOKE ${label}: waiting`);progressAt=Date.now()+30_000;}await sleep(2500);}
    throw new Error(`${label} timed out`);
  };
  const providers=(await request('/providers')).providers;
  for(const requested of options.providers)if(!providers.some(provider=>provider.id===requested))report.accounts.push({provider:requested,status:'pending',reason:'Provider is not registered'});
  for(const provider of providers.filter(provider=>options.providers.includes(provider.id)))for(const account of provider.accounts){
    const evidence={provider:provider.id,accountKey:accountKey(account),status:'pending',checks:[]};report.accounts.push(evidence);
    let target;
    try{target=selfTarget(provider,account);}catch(error){evidence.reason=error.message;continue;}
    if(!options.send){evidence.status='ready';evidence.reason='Discovery only. --send is required for live traffic';continue;}
    const prefix=`${provider.id}/${evidence.accountKey}`;
    const sentIds=[];
    try {
      const upload=async(file,mime)=>{
        const bytes=await fs.readFile(path.join(options.assets,file));
        if(bytes.length>5*1024*1024)throw new Error('Smoke assets must stay below the eager-download limit');
        return (await request('/attachments',{provider:provider.id,account:account.id,name:file,mime,base64:bytes.toString('base64')})).attachment;
      };
      const send=async(body,attachments=[],conversationId=null,replyToExternalId=null)=>{
        const id=randomUUID();await request('/outbox',{id,provider:provider.id,account:account.id,to:{...target,...(conversationId?{conversationId}:{}),...(provider.kind==='mail'?{subject:marker}:{})},body:{markdown:body},attachments,replyToExternalId,origin:'user'});
        const item=await poll(`${prefix} send`,async()=>{const item=(await request('/outbox')).items.find(item=>item.id===id);if(item?.status==='failed')throw new Error(item.error||'Send failed');return item?.status==='sent'?item:null;});
        sentIds.push({outboxId:id,externalId:item.externalId});return item;
      };
      const findSent=async(item,kind=null)=>{
        await request('/sync',{providers:[provider.id]});
        return poll(`${prefix} provider receive`,async()=>{
          const filter={providers:[provider.id],accounts:[account.id],dateFrom:report.startedAt,archived:false};
          const messages=(await request(`?filter=${encodeURIComponent(JSON.stringify(filter))}&limit=200`)).messages;
          const message=messages.find(message=>message.externalId===item.externalId);
          if(!message)return null;
          if(kind&&!message.attachments.some(attachment=>attachment.kind===kind&&attachment.id!==`${item.id}-0`&&(attachment.externalRef||message.rawPath)))return null;
          return message;
        },240_000);
      };
      // A text send resolves Slack's own user id to its actual DM channel.
      if(provider.id==='slack'){
        const hello=await send(`${marker}\nSelf-only delivery check.`);target={channel:hello.externalId.split(':')[0]};
        if(!/^D[A-Z0-9]+$/.test(target.channel))throw new Error('Slack did not confirm a private self DM');
      }
      log(`SMOKE ${prefix}: image to verified self`);
      const image=await upload('smoke.png','image/png');
      const imageSend=await send(`${marker}\nSelf-only image fixture.`,[{path:image.path,name:image.name,mime:image.mime}]);
      const received=await findSent(imageSend,'image');evidence.checks.push({check:'provider-image-received',ok:true,message:summary(received)});
      const imageAttachment=received.attachments.find(attachment=>attachment.kind==='image');
      const imageResponse=await fetchImpl(`${options.base}/api/messages/attachments/${received.id}/${imageAttachment.id}`,{signal:AbortSignal.timeout(30_000)});
      if(!imageResponse.ok||!(await imageResponse.arrayBuffer()).byteLength)throw new Error('Received image could not be downloaded');
      evidence.checks.push({check:'image-download',ok:true});
      await request(`/${received.id}/state`,{read:false});await sleep(6000);await request(`/${received.id}/state`,{read:true});await sleep(10_000);
      const read=(await request(`/${received.id}`)).message;if(!read.read)throw new Error('Mark read reverted');
      evidence.checks.push({check:'read-provider-action',ok:true,message:summary(read)});
      const reply=await send(`${marker}\nReply from Messages.\n\n\`\`\`text\nself-only fixture\n\`\`\``,[],received.conversationId,received.externalId);
      evidence.checks.push({check:'reply-confirmed',ok:true,externalId:reply.externalId});
      if(provider.capabilities.audioSend){
        log(`SMOKE ${prefix}: three-second voice fixture`);
        const audio=await upload('smoke.m4a','audio/mp4');
        const voice=await send(provider.kind==='mail'?`${marker}\nThree-second Portuguese voice fixture.`:'',[{path:audio.path,name:audio.name,mime:audio.mime,asVoiceNote:true}],received.conversationId);
        const voiceMessage=await findSent(voice,'audio');
        const transcribed=await poll(`${prefix} transcript`,async()=>{
          const message=(await request(`/${voiceMessage.id}`)).message,attachment=message.attachments.find(attachment=>attachment.kind==='audio');
          if(attachment?.transcriptStatus==='failed')throw new Error(attachment.transcriptError||'Voice transcription failed');
          return attachment?.transcriptStatus==='done'&&attachment.transcript&&attachment.playbackPath&&attachment.durationMs?message:null;
        },240_000);
        const attachment=transcribed.attachments.find(attachment=>attachment.kind==='audio');
        const audioResponse=await fetchImpl(`${options.base}/api/messages/attachments/${transcribed.id}/${attachment.id}?variant=playback`,{signal:AbortSignal.timeout(30_000)});
        if(!audioResponse.ok||!(await audioResponse.arrayBuffer()).byteLength)throw new Error('Playback audio could not be downloaded');
        evidence.checks.push({check:'voice-received-playback-transcript',ok:true,message:summary(transcribed)});
        const word=attachment.transcript.match(/[\p{L}]{4,}/u)?.[0];
        if(word){const hits=(await request(`?filter=${encodeURIComponent(JSON.stringify({providers:[provider.id],accounts:[account.id],text:word}))}`)).messages;if(!hits.some(message=>message.id===transcribed.id))throw new Error('Transcript search did not find the voice note');evidence.checks.push({check:'transcript-search',ok:true});}
      }
      if(provider.kind==='mail'){
        await request(`/${received.id}/state`,{archived:true});await sleep(10_000);await request('/sync',{providers:[provider.id]});
        const archived=await poll(`${prefix} archive labels`,async()=>{const message=(await request(`/${received.id}`)).message;return message.archived&&!message.labels.includes('INBOX')?message:null;});
        evidence.checks.push({check:'archive-provider-labels',ok:true,message:summary(archived)});
      }
      if(provider.capabilities.delete){
        await request(`/${received.id}/state`,{deleted:true});await sleep(10_000);await request('/sync',{providers:[provider.id]});
        const deleted=await poll(`${prefix} delete`,async()=>{const message=(await request(`/${received.id}`)).message;return message.deleted&&(provider.kind!=='mail'||message.labels.includes('TRASH'))?message:null;});
        evidence.checks.push({check:provider.kind==='mail'?'trash-provider-labels':'delete-own-message',ok:true,message:summary(deleted)});
      }
      evidence.status='passed';
    }catch(error){evidence.status='failed';evidence.reason=String(error.message).replaceAll(account.address??'\0','[self]').replaceAll(account.id,'[account]');}
    evidence.sent=sentIds;await fs.writeFile(path.join(options.out,`${provider.id}-${evidence.accountKey}-${stamp}.json`),JSON.stringify(evidence,null,2));
    log(`SMOKE ${prefix}: ${evidence.status}`);
  }
  report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(options.out,`report-${stamp}.json`),JSON.stringify(report,null,2));
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const report=await runSmoke(smokeOptions(process.argv.slice(2)));console.log(JSON.stringify({mode:report.mode,accounts:report.accounts.map(({provider,accountKey,status,reason})=>({provider,accountKey,status,reason}))},null,2));if(report.accounts.some(account=>account.status==='failed'))process.exitCode=1;}
  catch(error){console.error(error.message);process.exitCode=1;}
}

import crypto from 'node:crypto';
import { appendChange } from '../lib/changes.mjs';
import { filterToSql } from './filter.mjs';

export class MessagesError extends Error {
  constructor(status, message) { super(message); this.status=status; this.body={error:'messages',detail:message}; }
}
const now = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function messageId() {
  let time=BigInt(Date.now()), result='';
  for (let i=0;i<10;i++) { result=alphabet[Number(time%32n)]+result; time/=32n; }
  return result+Array.from(crypto.randomBytes(16), n=>alphabet[n%32]).join('');
}
const jsonColumns=new Set(['sender','recipients','attachments','labels','action','triage','reactions','participants','localState','mirrorTargets','mirrorContext']);
const boolColumns=new Set(['read','archived','deleted','starred','suppressNotification','muted','pinned']);
const messageColumns=['id','provider','account','conversationId','externalId','direction','sender','recipients','subject','bodyText','bodyMarkdown','bodyHtmlPath','attachments','ts','receivedTs','read','archived','deleted','starred','labels','category','severity','action','cardId','conversationRef','triage','rawPath','suppressNotification','reactions','deepLink','ownerNode','htmlOwnerNode','rawOwnerNode','sourceLink','mirrorTargets','mirrorContext','providerHash','localState'];
const conversationColumns=['id','provider','account','externalId','kind','title','participants','lastMessageTs','unreadCount','muted','pinned','archived','parentConversationId'];
const encode=(key,value) => jsonColumns.has(key) ? (value == null ? null : JSON.stringify(value)) : boolColumns.has(key) ? Number(!!value) : value ?? null;
function decode(row) {
  if (!row) return null;
  const out={...row};
  for (const key of jsonColumns) if (key in out) out[key]=out[key] === null ? null : JSON.parse(out[key]);
  for (const key of boolColumns) if (key in out) out[key]=Boolean(out[key]);
  delete out.providerHash; delete out.localState;
  return out;
}
const required=(value,name) => { if (typeof value!=='string' || !value.trim() || value.length>2048) throw new MessagesError(422,`Invalid ${name}`); return value; };
const identity=(value,name) => { required(value,name); if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,199}$/.test(value)) throw new MessagesError(422,`Invalid ${name}`); return value; };
const date=(value) => { if (!value || !Number.isFinite(Date.parse(value))) throw new MessagesError(422,'Invalid message timestamp'); return new Date(value).toISOString(); };
function change(db,node,ids,op='messages.changed') { appendChange(db,{entity:op,entityId:ids[0]??'messages',op:'updated',node,summary:{ids}}); }
const caps={read:true,send:false,reply:false,markRead:false,archive:false,delete:false,groups:false,threads:false,attachments:true,audioReceive:true,audioSend:false,markdown:true,code:true,reactionsRead:false,openInProvider:false};
export const systemDescriptor={id:'system',kind:'system',label:'Agents',badge:{text:'Agents',color:'sage',glyph:'Bot'},accounts:[{id:'default',label:'Garrison'}],capabilities:caps,sync:{mode:'stream'},setupHint:null};
export function registerProvider(db,node,input) {
  const descriptor=input.descriptor??input;
  identity(descriptor.id,'provider');
  if (!['system','mail','chat'].includes(descriptor.kind) || !Array.isArray(descriptor.accounts) || !descriptor.capabilities || descriptor.capabilities.read!==true) throw new MessagesError(422,'Invalid provider descriptor');
  if (descriptor.id==='system' && input.internal!==true) throw new MessagesError(422,'The system provider is built in');
  if (descriptor.id==='demo' && process.env.GARRISON_MESSAGES_FIXTURES!=='1') throw new MessagesError(403,'The demo provider is fixtures only');
  for (const account of descriptor.accounts) { identity(account.id,'account'); required(account.label,'account label'); }
  let callback=input.callbackBaseUrl??descriptor.callbackBaseUrl??null;
  if (callback) { const url=new URL(callback); if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new MessagesError(422,'Invalid callback URL'); callback=url.href.replace(/\/$/,''); }
  const old=db.prepare('SELECT * FROM messages_providers WHERE id=?').get(descriptor.id);
  const previous=JSON.parse(old?.descriptor??'{}');
  if(old?.callbackBaseUrl && old.ownerNode!==node && (descriptor.setupHint||descriptor.health?.ok===false||!descriptor.accounts.length)) return {provider:{...previous,ownerNode:old.ownerNode,callbackBaseUrl:old.callbackBaseUrl},changed:false};
  const merged={...previous,...descriptor};
  if(!input.settingsUpdate) for(const key of ['retentionDays','sendReadReceipts','holdSeconds']) if(previous[key]!=null) merged[key]=previous[key];
  if(!descriptor.setupHint && previous.runtimeHealth) merged.health=previous.runtimeHealth;
  const text=JSON.stringify(merged);
  if (old?.descriptor===text && old.callbackBaseUrl===callback && old.ownerNode===node) return {provider:{...merged,ownerNode:node},changed:false};
  db.transaction(()=>{
    db.prepare('INSERT INTO messages_providers VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,descriptor=excluded.descriptor,ownerNode=excluded.ownerNode,callbackBaseUrl=excluded.callbackBaseUrl,updatedAt=excluded.updatedAt').run(descriptor.id,descriptor.kind,text,node,callback,now());
    change(db,node,[descriptor.id],'providers.changed');
  })();
  return {provider:{...merged,ownerNode:node,callbackBaseUrl:callback},changed:true};
}
export function listProviders(db) { return db.prepare('SELECT * FROM messages_providers ORDER BY id').all().map(r=>({...JSON.parse(r.descriptor),ownerNode:r.ownerNode,callbackBaseUrl:r.callbackBaseUrl,lastSync:db.prepare('SELECT MAX(lastSync) AS ts FROM messages_sync WHERE provider=?').get(r.id).ts})); }
export function setProviderHealth(db,node,id,input) {
  const row=db.prepare('SELECT * FROM messages_providers WHERE id=?').get(id);if(!row)throw new MessagesError(404,'Provider not found');
  const lease=db.prepare('SELECT holderNode,expiresAt FROM messages_ingest_lease').get();
  if(row.ownerNode!==node && !(lease?.holderNode===node&&Date.parse(lease.expiresAt)>Date.now()))throw new MessagesError(403,'Only the provider owner or ingest holder can report health');
  if(typeof input.ok!=='boolean'||input.reason!=null&&typeof input.reason!=='string')throw new MessagesError(422,'Invalid provider health');
  const descriptor=JSON.parse(row.descriptor),health={ok:input.ok,...(!input.ok?{reason:(input.reason||'Provider unavailable').slice(0,300)}:{})};
  if(input.account) {
    if(!descriptor.accounts.some(account=>account.id===input.account))throw new MessagesError(422,'Unknown provider account');
    descriptor.accountHealth={...(descriptor.accountHealth??{}),[input.account]:health};
    const usable=descriptor.accounts.filter(account=>!account.setupHint).map(account=>descriptor.accountHealth[account.id]).filter(Boolean);
    descriptor.runtimeHealth=usable.some(value=>value.ok)?{ok:true}:usable.find(value=>!value.ok)??health;
  } else descriptor.runtimeHealth=health;
  descriptor.health=descriptor.runtimeHealth;
  if(row.descriptor===JSON.stringify(descriptor))return {changed:false};
  db.transaction(()=>{db.prepare('UPDATE messages_providers SET descriptor=?,updatedAt=? WHERE id=?').run(JSON.stringify(descriptor),now(),id);change(db,node,[id],'providers.changed');})();
  return {changed:true};
}
export function ensureSystem(db) { if (!db.prepare("SELECT id FROM messages_providers WHERE id='system'").get()) registerProvider(db,'system',{descriptor:systemDescriptor,internal:true}); }
export function acquireIngestLease(db,node,{at=Date.now()}={}) {
  return db.transaction(()=>{
    const old=db.prepare('SELECT * FROM messages_ingest_lease').get();
    if (old && Date.parse(old.expiresAt)>at) return {granted:false,holderNode:old.holderNode,expiresAt:old.expiresAt};
    const token='msgi_'+crypto.randomBytes(32).toString('hex'), expiresAt=new Date(at+90_000).toISOString(),fence=(old?.fence??0)+1;
    db.prepare("INSERT INTO messages_ingest_lease VALUES ('messages_ingest_lease',?,?,?,?) ON CONFLICT(id) DO UPDATE SET holderNode=excluded.holderNode,tokenHash=excluded.tokenHash,expiresAt=excluded.expiresAt,fence=excluded.fence").run(node,hash(token),expiresAt,fence);
    return {granted:true,holderNode:node,token,expiresAt,fence};
  })();
}
export function authenticateIngest(db,token,at=Date.now()) {
  if (!token?.startsWith('msgi_')) return null;
  const row=db.prepare('SELECT * FROM messages_ingest_lease WHERE tokenHash=? AND expiresAt>?').get(hash(token),new Date(at).toISOString());
  return row ? {name:row.holderNode,scope:'messages-ingest',fence:row.fence,tokenHash:row.tokenHash} : null;
}
export function renewIngest(db,actor) {
  const expiresAt=new Date(Date.now()+90_000).toISOString();
  const result=db.prepare('UPDATE messages_ingest_lease SET expiresAt=? WHERE holderNode=? AND tokenHash=? AND expiresAt>?').run(expiresAt,actor.name,actor.tokenHash,now());
  if (!result.changes) throw new MessagesError(409,'Ingest lease lost');
  return {renewed:true,expiresAt};
}
function assertLease(db,actor,fence) {
  const row=db.prepare('SELECT * FROM messages_ingest_lease').get();
  if (!row || row.holderNode!==actor.name || row.fence!==fence || Date.parse(row.expiresAt)<=Date.now()) throw new MessagesError(409,'Ingest lease lost');
}
function insertObject(db,table,columns,value) {
  const assignments=columns.filter(c=>c!=='id').map(c=>`${c}=excluded.${c}`).join(',');
  db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${assignments}`).run(...columns.map(c=>encode(c,value[c])));
}
function putConversation(db,input,node) {
  const old=input.externalId ? db.prepare('SELECT * FROM messages_conversations WHERE provider=? AND account=? AND externalId=?').get(input.provider,input.account,input.externalId) : db.prepare('SELECT * FROM messages_conversations WHERE id=?').get(input.id);
  const collision=db.prepare('SELECT provider,account,externalId FROM messages_conversations WHERE id=?').get(old?.id??input.id);
  if (collision && (collision.provider!==input.provider || collision.account!==input.account || collision.externalId!==(input.externalId??null))) throw new MessagesError(409,'Conversation identity collision');
  const row={id:old?.id??input.id??messageId(),provider:input.provider,account:input.account,externalId:input.externalId??null,kind:input.kind??'dm',title:input.title??'',participants:input.participants??[],lastMessageTs:input.lastMessageTs??now(),unreadCount:old?.unreadCount??0,muted:old?.muted??false,pinned:old?.pinned??false,archived:old?.archived??false,parentConversationId:input.parentConversationId??null};
  insertObject(db,'messages_conversations',conversationColumns,row); return row;
}
function refreshConversation(db,id) {
  db.prepare(`UPDATE messages_conversations SET unreadCount=(SELECT COUNT(*) FROM messages WHERE conversationId=? AND read=0 AND deleted=0 AND archived=0),lastMessageTs=COALESCE((SELECT MAX(ts) FROM messages WHERE conversationId=?),lastMessageTs) WHERE id=?`).run(id,id,id);
}
export function getMessage(db,id) { return decode(db.prepare('SELECT * FROM messages WHERE id=?').get(id)); }
function queueEffect(db,message,kind,payload,key) {
  db.prepare('INSERT OR IGNORE INTO messages_effects(id,messageId,kind,payload,createdAt) VALUES (?,?,?,?,?)').run(key??messageId(),message?.id??null,kind,JSON.stringify(payload),now());
}
function applyRules(db,node,id,rules=null) {
  if (getMessage(db,id).direction!=='in') return;
  for (const rule of rules??listRules(db).filter(r=>r.enabled)) {
    const f=filterToSql(rule.match,{defaults:false});
    const matched=db.prepare(`SELECT m.id FROM messages m JOIN messages_providers p ON p.id=m.provider WHERE m.id=? AND ${f.sql}`).get(id,...f.params);
    if (!matched) continue;
    const run=db.prepare('INSERT OR IGNORE INTO messages_rule_runs VALUES (?,?,?,?)').run(id,rule.id,rule.revision,now());
    if (run.changes) {
      const message=getMessage(db,id);
      const patch={};
      for (const action of rule.actions) {
        if (action.type==='markRead') patch.read=true;
        if (action.type==='archive') patch.archived=true;
        if (action.type==='star') patch.starred=true;
        if (action.type==='suppressNotification') patch.suppressNotification=true;
        if (action.type==='label') patch.labels=[...new Set([...(patch.labels??message.labels),action.label])];
        if (action.type==='mute') db.prepare('UPDATE messages_conversations SET muted=1 WHERE id=?').run(message.conversationId);
        if (action.type==='createCard' && !message.cardId) queueEffect(db,message,'createCard',action,`rule:${rule.id}:${rule.revision}:${id}:card`);
      }
      if (Object.keys(patch).length) patchMessage(db,node,id,patch,{localLabels:rule.actions.filter(action=>action.type==='label').map(action=>action.label)});
      db.prepare('UPDATE messages_rules SET matchedCount=matchedCount+1,lastMatchedAt=? WHERE id=?').run(now(),rule.id);
    }
    if (rule.stopProcessing) break;
  }
}
export function upsertMessage(db,node,input,{rules=true}={}) {
  identity(input.provider,'provider'); identity(input.account,'account'); if (typeof input.bodyText!=='string' || input.bodyText.length>2_000_000) throw new MessagesError(422,'Invalid message body');
  const old=input.externalId ? db.prepare('SELECT * FROM messages WHERE provider=? AND account=? AND externalId=?').get(input.provider,input.account,input.externalId) : db.prepare('SELECT * FROM messages WHERE id=?').get(input.id);
  const normalized={provider:input.provider,account:input.account,conversationId:required(input.conversationId,'conversationId'),externalId:input.externalId??null,direction:input.direction??'in',sender:input.sender??{id:'unknown',name:'Unknown',isMe:false},recipients:input.recipients??[],subject:input.subject??null,bodyText:input.bodyText??'',bodyMarkdown:input.bodyMarkdown??null,bodyHtmlPath:input.bodyHtmlPath??null,attachments:input.attachments??[],ts:date(input.ts),read:!!input.read,archived:!!input.archived,deleted:!!input.deleted,starred:!!input.starred,labels:input.labels??[],category:input.category??null,severity:input.severity??null,action:input.action??null,cardId:input.cardId??null,conversationRef:input.conversationRef??null,triage:null,rawPath:input.rawPath??null,suppressNotification:!!input.suppressNotification,reactions:input.reactions??[],deepLink:input.deepLink??null,sourceLink:input.sourceLink??null,mirrorTargets:input.mirrorTargets??null,mirrorContext:input.provider==='system'?input.mirrorContext??null:null};
  if (normalized.attachments.some(a=>a.inlineData || a.base64 || a.content_base64)) throw new MessagesError(422,'Attachment bytes must be stored on disk');
  const collision=db.prepare('SELECT provider,account,externalId FROM messages WHERE id=?').get(old?.id??input.id);
  if (collision && (collision.provider!==input.provider || collision.account!==input.account || collision.externalId!==normalized.externalId)) throw new MessagesError(409,'Message identity collision');
  const providerHash=hash(normalized);
  if (old?.providerHash===providerHash) return {message:getMessage(db,old.id),changed:false};
  const localState=JSON.parse(old?.localState??'{}');
  const derived=['path','thumbPath','playbackPath','durationMs','transcript','transcriptStatus','transcriptError','width','height'];
  const providerOwner=db.prepare('SELECT ownerNode FROM messages_providers WHERE id=?').get(input.provider)?.ownerNode;
  const validOwner=hint=>hint && (hint===node||hint===providerOwner)?hint:node;
  const previousAttachments=JSON.parse(old?.attachments??'[]');
  const attachments=normalized.attachments.map(incoming=>{
    const previous=previousAttachments.find(a=>a.id===incoming.id);
    if(!previous) return {...incoming,ownerNode:validOwner(incoming.ownerNode)};
    const retained=Object.fromEntries(derived.filter(key=>previous[key]!=null && (key!=='transcriptStatus'||previous[key]!=='none')).map(key=>[key,previous[key]]));
    return {...incoming,...retained,ownerNode:previous.path?(previous.ownerNode??old.ownerNode):validOwner(incoming.ownerNode)};
  });
  const retainedLabels=[...new Set([...(localState.labels??normalized.labels),...(localState.garrisonLabels??[])])];
  const row={...normalized,...localState,labels:retainedLabels,attachments,id:old?.id??input.id??messageId(),receivedTs:old?.receivedTs??input.receivedTs??now(),ownerNode:old?.ownerNode??node,htmlOwnerNode:normalized.bodyHtmlPath?validOwner(input.htmlOwnerNode):old?.htmlOwnerNode??null,rawOwnerNode:normalized.rawPath?validOwner(input.rawOwnerNode):old?.rawOwnerNode??null,providerHash,localState};
  if (old?.action) { const previous=JSON.parse(old.action); if (previous.answeredAt) row.action=previous; }
  insertObject(db,'messages',messageColumns,row);
  if (old) db.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(row.id);
  if (rules) applyRules(db,node,row.id);
  const needsMedia=row.attachments.filter(a=>a.path && ((a.kind==='image'&&!a.thumbPath)||(a.kind==='audio'&&(!a.playbackPath||['none','pending'].includes(a.transcriptStatus)))));
  for(const ownerNode of new Set(needsMedia.map(a=>a.ownerNode??row.ownerNode))) queueEffect(db,row,'processMedia',{ownerNode,attachmentIds:needsMedia.filter(a=>(a.ownerNode??row.ownerNode)===ownerNode).map(a=>a.id)},`media:${row.id}:${ownerNode}:${hash(needsMedia)}`);
  refreshConversation(db,row.conversationId);
  const stored=getMessage(db,row.id);
  const muted=db.prepare('SELECT muted FROM messages_conversations WHERE id=?').get(row.conversationId)?.muted;
  if (!old && stored.direction==='in' && !stored.suppressNotification && !muted) db.prepare("INSERT OR IGNORE INTO messages_mirrors(messageId,channel) VALUES (?,'all')").run(row.id);
  change(db,node,[row.id]);
  return {message:stored,changed:true};
}
export function ingestBatch(db,actor,input) {
  return db.transaction(()=>{
    assertLease(db,actor,input.fence);
    const provider=db.prepare('SELECT id FROM messages_providers WHERE id=?').get(input.provider); if (!provider) throw new MessagesError(422,'Provider must register before ingestion');
    const ids=new Map();
    for (const conversation of input.conversations??[]) {
      if (conversation.provider!==input.provider || conversation.account!==input.account) throw new MessagesError(422,'Conversation scope mismatch');
      const stored=putConversation(db,conversation,actor.name); ids.set(conversation.id,stored.id);
    }
    const changed=[];
    for (const message of input.messages??[]) {
      if (message.provider!==input.provider || message.account!==input.account) throw new MessagesError(422,'Message scope mismatch');
      const result=upsertMessage(db,actor.name,{...message,conversationId:ids.get(message.conversationId)??message.conversationId});
      if (result.changed) changed.push(result.message.id);
    }
    for (const externalId of input.deletedExternalIds??[]) { const row=db.prepare('SELECT id,conversationId FROM messages WHERE provider=? AND account=? AND externalId=? AND deleted=0').get(input.provider,input.account,externalId); if(row) { db.prepare('UPDATE messages SET deleted=1 WHERE id=?').run(row.id); refreshConversation(db,row.conversationId); changed.push(row.id); change(db,actor.name,[row.id]); } }
    if (input.advanceCursor !== false) db.prepare('INSERT INTO messages_sync(provider,account,cursor,lastSync,error,requested) VALUES (?,?,?,?,NULL,0) ON CONFLICT(provider,account) DO UPDATE SET cursor=excluded.cursor,lastSync=excluded.lastSync,error=NULL,requested=0').run(input.provider,input.account,JSON.stringify(input.cursor??null),now());
    return {ids:changed,changed:changed.length,cursor:input.cursor};
  })();
}
export function emitSystem(db,node,input) {
  if(input.mirrorContext) {
    const context=input.mirrorContext;
    if(typeof context!=='object'||Array.isArray(context)||Object.keys(context).some(key=>!['priority','webFallback','tag'].includes(key))||context.priority!=null&&!['routine','interactive'].includes(context.priority)||context.webFallback!=null&&typeof context.webFallback!=='boolean'||context.tag!=null&&(typeof context.tag!=='string'||context.tag.length>200))throw new MessagesError(422,'Invalid mirror context');
  }
  return db.transaction(()=>{
    ensureSystem(db);
    const externalId=input.idempotencyKey??input.externalId??input.id??messageId();
    const existing=db.prepare("SELECT id FROM messages WHERE provider='system' AND account='default' AND externalId=?").get(externalId);
    if (existing) return {message:getMessage(db,existing.id),changed:false};
    const id=messageId();
    const c=putConversation(db,{id:messageId(),provider:'system',account:'default',externalId:`system:${externalId}`,kind:'system',title:input.title??input.category??'Garrison',participants:[{id:'system',name:'Garrison',isMe:false}]},node);
    return upsertMessage(db,node,{id,provider:'system',account:'default',conversationId:c.id,externalId,direction:'in',sender:{id:'system',name:'Garrison',isMe:false},subject:input.title??'Garrison',bodyText:input.body??input.bodyText??'',bodyMarkdown:input.body??input.bodyText??'',ts:now(),category:input.category??'system.info',severity:input.severity??'info',action:input.action??null,cardId:input.cardId??null,conversationRef:input.conversationRef??null,attachments:input.attachments??[],sourceLink:input.sourceLink??null,mirrorTargets:input.mirrorTargets??null,mirrorContext:input.mirrorContext??null,suppressNotification:!!input.suppressNotification});
  })();
}
export function listMessages(db,filter={},cursor=null,limit=100) {
  const f=filterToSql(filter); const params=[...f.params]; let after='';
  if (cursor) {
    let parts; try { parts=JSON.parse(Buffer.from(cursor,'base64url').toString()); } catch { throw new MessagesError(422,'Invalid cursor'); }
    if (!Array.isArray(parts) || parts.length!==2) throw new MessagesError(422,'Invalid cursor');
    after=' AND (m.ts<? OR (m.ts=? AND m.id<?))'; params.push(parts[0],parts[0],parts[1]);
  }
  limit=Math.max(1,Math.min(Number(limit)||100,2000));
  const rows=db.prepare(`SELECT m.* FROM messages m JOIN messages_providers p ON p.id=m.provider WHERE ${f.sql}${after} ORDER BY m.ts DESC,m.id DESC LIMIT ?`).all(...params,limit+1);
  const more=rows.length>limit; if (more) rows.pop(); const last=rows.at(-1);
  return {messages:rows.map(decode),nextCursor:more?Buffer.from(JSON.stringify([last.ts,last.id])).toString('base64url'):null};
}
export function listConversations(db,filter={},cursor=null,limit=1000) {
  const f=filterToSql(filter); const params=[...f.params]; let after='';
  if(cursor) {
    let values; try { values=JSON.parse(Buffer.from(cursor,'base64url').toString()); } catch { throw new MessagesError(422,'Invalid cursor'); }
    if(!Array.isArray(values)||values.length!==3||typeof values[0]!=='number') throw new MessagesError(422,'Invalid cursor');
    after=' AND (c.pinned<? OR (c.pinned=? AND (c.lastMessageTs<? OR (c.lastMessageTs=? AND c.id<?))))';
    params.push(values[0],values[0],values[1],values[1],values[2]);
  }
  limit=Math.max(1,Math.min(Number(limit)||1000,2000));
  const rows=db.prepare(`SELECT c.* FROM messages_conversations c WHERE c.id IN (SELECT m.conversationId FROM messages m JOIN messages_providers p ON p.id=m.provider WHERE ${f.sql})${after} ORDER BY c.pinned DESC,c.lastMessageTs DESC,c.id DESC LIMIT ?`).all(...params,limit+1);
  const more=rows.length>limit; if(more) rows.pop(); const last=rows.at(-1);
  return {conversations:rows.map(r=>({...decode(r),lastMessage:decode(db.prepare('SELECT * FROM messages WHERE conversationId=? AND deleted=0 ORDER BY ts DESC,id DESC LIMIT 1').get(r.id))})),nextCursor:more?Buffer.from(JSON.stringify([last.pinned,last.lastMessageTs,last.id])).toString('base64url'):null};
}
export function getConversation(db,id) {
  const conversation=decode(db.prepare('SELECT * FROM messages_conversations WHERE id=?').get(id));
  if (!conversation) throw new MessagesError(404,'Conversation not found');
  return {conversation,messages:db.prepare('SELECT * FROM messages WHERE conversationId=? AND deleted=0 ORDER BY ts,id').all(id).map(decode)};
}
export function updateMedia(db,node,id,attachment) {
  return db.transaction(()=>{
    const message=getMessage(db,id); if(!message) throw new MessagesError(404,'Message not found');
    const original=message.attachments.find(a=>a.id===attachment?.id);
    if(!original) throw new MessagesError(404,'Attachment not found');
    if((original.ownerNode??message.ownerNode)!==node) throw new MessagesError(403,'Media stays on its owner node');
    const allowed=['path','thumbPath','playbackPath','mime','size','durationMs','transcript','transcriptStatus','transcriptError','width','height'];
    const patch=Object.fromEntries(allowed.filter(key=>key in attachment).map(key=>[key,attachment[key]]));
    const segment=value=>encodeURIComponent(String(value)).replace(/\./g,'%2E');
    for(const key of ['path','thumbPath','playbackPath']) if(patch[key]!=null && (typeof patch[key]!=='string'||patch[key].startsWith('/')||patch[key].split(/[\\/]/).includes('..')||!patch[key].startsWith(`attachments/${segment(message.provider)}/${segment(message.account)}/`))) throw new MessagesError(422,'Invalid attachment path');
    if(patch.transcriptStatus && !['none','pending','done','failed'].includes(patch.transcriptStatus)) throw new MessagesError(422,'Invalid transcript status');
    for(const key of ['transcript','transcriptError']) if(patch[key]!=null && (typeof patch[key]!=='string'||patch[key].length>1_000_000)) throw new MessagesError(422,'Invalid transcript');
    for(const key of ['size','durationMs','width','height']) if(patch[key]!=null && (!Number.isFinite(patch[key])||patch[key]<0)) throw new MessagesError(422,'Invalid media metadata');
    const updated={...original,...patch};
    if(JSON.stringify(updated)===JSON.stringify(original)) return {message};
    const attachments=message.attachments.map(a=>a.id===original.id?updated:a);
    db.prepare('UPDATE messages SET attachments=?,revision=revision+1 WHERE id=?').run(JSON.stringify(attachments),id);
    change(db,node,[id]); return {message:getMessage(db,id)};
  })();
}
export function patchMessage(db,node,id,patch,{queue=true,localLabels=[]}={}) {
  return db.transaction(()=>{
    const raw=db.prepare('SELECT * FROM messages WHERE id=?').get(id); if (!raw) throw new MessagesError(404,'Message not found');
    const before=getMessage(db,id), allowed=['read','archived','deleted','starred','labels','suppressNotification'];
    const keys=Object.keys(patch); if (keys.some(k=>!allowed.includes(k))) throw new MessagesError(422,'Unsupported state field');
    for (const k of keys) if (k==='labels' ? !Array.isArray(patch[k]) || patch[k].some(v=>typeof v!=='string') : typeof patch[k]!=='boolean') throw new MessagesError(422,`Invalid ${k}`);
    const localState={...JSON.parse(raw.localState),...patch};
    const providerPatch={...patch};
    if(localLabels.length) {
      localState.garrisonLabels=[...new Set([...(JSON.parse(raw.localState).garrisonLabels??[]),...localLabels])];
      const previousLocal=JSON.parse(raw.localState);
      if(Object.hasOwn(previousLocal,'labels')) localState.labels=previousLocal.labels; else delete localState.labels;
      delete providerPatch.labels;
    }
    const row={...before,...patch,providerHash:raw.providerHash,localState};
    insertObject(db,'messages',messageColumns,row);
    db.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(id);
    const revision=raw.revision+1;
    if (queue && before.provider!=='system' && Object.keys(providerPatch).some(k=>k!=='suppressNotification')) queueEffect(db,before,'providerState',{patch:providerPatch,before:Object.fromEntries(Object.keys(providerPatch).map(k=>[k,before[k]])),revision});
    refreshConversation(db,before.conversationId); change(db,node,[id]); return {message:getMessage(db,id)};
  })();
}
export function patchConversation(db,node,id,patch) {
  return db.transaction(()=>{
    const c=getConversation(db,id); const state={...patch};
    for (const key of ['muted','pinned']) if (key in state) { if (typeof state[key]!=='boolean') throw new MessagesError(422,`Invalid ${key}`); db.prepare(`UPDATE messages_conversations SET ${key}=? WHERE id=?`).run(Number(state[key]),id); delete state[key]; }
    if (Object.keys(state).length) for (const m of c.messages) patchMessage(db,node,m.id,state);
    change(db,node,c.messages.map(m=>m.id)); return getConversation(db,id);
  })();
}
export function listViews(db) { return db.prepare('SELECT * FROM messages_views ORDER BY sortOrder,id').all().map(r=>({...r,filter:JSON.parse(r.filter),order:r.sortOrder,builtIn:!!r.builtIn})); }
export function saveView(db,node,view) {
  filterToSql(view.filter); required(view.name,'view name');
  const id=view.id??messageId(); const old=db.prepare('SELECT builtIn FROM messages_views WHERE id=?').get(id);
  if (old?.builtIn) throw new MessagesError(422,'Built-in views cannot be edited');
  db.prepare('INSERT INTO messages_views VALUES (?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name,icon=excluded.icon,filter=excluded.filter,sortOrder=excluded.sortOrder').run(id,view.name,view.icon??'Inbox',JSON.stringify(view.filter),view.order??100);
  change(db,node,[id]); return {view:listViews(db).find(v=>v.id===id)};
}
export function deleteView(db,node,id) { if (db.prepare('SELECT builtIn FROM messages_views WHERE id=?').get(id)?.builtIn) throw new MessagesError(422,'Built-in views cannot be deleted'); db.prepare('DELETE FROM messages_views WHERE id=?').run(id); change(db,node,[id]); return {deleted:true}; }
export function counts(db) {
  const counts={}; for (const v of listViews(db)) { const f=filterToSql({...v.filter,unread:true}); counts[v.id]=db.prepare(`SELECT COUNT(*) AS n FROM messages m JOIN messages_providers p ON p.id=m.provider WHERE ${f.sql}`).get(...f.params).n; }
  return {counts};
}
export function listRules(db) { return db.prepare('SELECT * FROM messages_rules ORDER BY sortOrder,id').all().map(r=>({...r,enabled:!!r.enabled,order:r.sortOrder,match:JSON.parse(r.match),actions:JSON.parse(r.actions),stopProcessing:!!r.stopProcessing})); }
export function saveRule(db,node,rule) {
  required(rule.name,'rule name'); filterToSql(rule.match,{defaults:false});
  if (!Array.isArray(rule.actions) || rule.actions.some(a=>!a || typeof a!=='object' || !['markRead','archive','star','mute','label','suppressNotification','createCard'].includes(a.type))) throw new MessagesError(422,'Invalid rule action');
  if (rule.enabled!==undefined && typeof rule.enabled!=='boolean') throw new MessagesError(422,'Invalid rule enabled state');
  if (rule.stopProcessing!==undefined && typeof rule.stopProcessing!=='boolean') throw new MessagesError(422,'Invalid rule stop state');
  if (rule.order!==undefined && !Number.isFinite(rule.order)) throw new MessagesError(422,'Invalid rule order');
  for (const action of rule.actions) {
    if (action.type==='label') required(action.label,'label');
    if (action.type==='createCard') for (const key of ['project','flow']) if (action[key]!=null && (typeof action[key]!=='string' || action[key].length>240)) throw new MessagesError(422,`Invalid card ${key}`);
  }
  const id=rule.id??messageId();
  db.prepare('INSERT INTO messages_rules(id,name,enabled,sortOrder,match,actions,stopProcessing) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,sortOrder=excluded.sortOrder,match=excluded.match,actions=excluded.actions,stopProcessing=excluded.stopProcessing,revision=messages_rules.revision+1').run(id,rule.name,Number(rule.enabled??true),rule.order??100,JSON.stringify(rule.match),JSON.stringify(rule.actions),Number(!!rule.stopProcessing));
  change(db,node,[id]); return {rule:listRules(db).find(r=>r.id===id)};
}
export function testRule(db,rule) { const f=filterToSql(rule.match,{defaults:false}); const from=`FROM messages m JOIN messages_providers p ON p.id=m.provider WHERE m.direction='in' AND ${f.sql}`; return {count:db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...f.params).n,messages:db.prepare(`SELECT m.* ${from} ORDER BY m.ts DESC LIMIT 20`).all(...f.params).map(decode)}; }
export function applyRule(db,node,id) {
  const rule=listRules(db).find(r=>r.id===id); if (!rule) throw new MessagesError(404,'Rule not found');
  const f=filterToSql(rule.match,{defaults:false});
  return db.transaction(()=>{
    const rows=db.prepare(`SELECT m.id FROM messages m JOIN messages_providers p ON p.id=m.provider WHERE m.direction='in' AND ${f.sql}`).all(...f.params);
    for (const row of rows) applyRules(db,node,row.id,[rule]);
    emitSystem(db,node,{category:'rules.applied',title:'Rules',body:`Rule ${rule.name} applied to ${rows.length} messages.`,idempotencyKey:`rule-apply:${id}:${rule.revision}:${hash(rows)}`});
    return {count:rows.length};
  })();
}
export function beginAnswer(db,node,id,answer) {
  required(answer,'answer');
  return db.transaction(()=>{
    const message=getMessage(db,id); if (!message?.action || message.provider!=='system') throw new MessagesError(422,'Message has no system action');
    if (message.action.answeredAt) { if (message.action.answer!==answer) throw new MessagesError(409,'This message is already answered'); return {message,answered:true}; }
    if (message.action.revertUntil && Date.parse(message.action.revertUntil)<=Date.now()) throw new MessagesError(409,'This action has expired');
    if (message.action.options?.length && !message.action.options.includes(answer)) throw new MessagesError(422,'Choose an offered answer');
    if (message.action.kind==='approval' && !['approve','reject'].includes(answer)) throw new MessagesError(422,'Choose approve or reject');
    const old=db.prepare('SELECT * FROM messages_answers WHERE messageId=?').get(id);
    if (old && old.answer!==answer) throw new MessagesError(409,'A different answer is already being delivered');
    if (old?.status==='pending' && Date.parse(old.claimUntil)>Date.now()) throw new MessagesError(409,'Answer delivery is in progress');
    const claimToken=crypto.randomBytes(24).toString('hex');
    db.prepare("INSERT INTO messages_answers VALUES (?,?,'pending',?,?,NULL) ON CONFLICT(messageId) DO UPDATE SET status='pending',claimToken=excluded.claimToken,claimUntil=excluded.claimUntil,error=NULL").run(id,answer,claimToken,new Date(Date.now()+30_000).toISOString());
    return {message,claimToken,answered:false};
  })();
}
export function finishAnswer(db,node,id,{claimToken,error}) {
  return db.transaction(()=>{
    const claim=db.prepare('SELECT * FROM messages_answers WHERE messageId=? AND claimToken=?').get(id,claimToken);
    if (!claim) throw new MessagesError(409,'Answer delivery claim changed');
    if (error) { db.prepare("UPDATE messages_answers SET status='failed',error=? WHERE messageId=?").run(String(error),id); return {message:getMessage(db,id)}; }
    const message=getMessage(db,id); const action={...message.action,answeredAt:now(),answer:claim.answer};
    db.prepare('UPDATE messages SET action=?,read=1 WHERE id=?').run(JSON.stringify(action),id);
    db.prepare("UPDATE messages_answers SET status='done' WHERE messageId=?").run(id);
    refreshConversation(db,message.conversationId); change(db,node,[id]); return {message:getMessage(db,id)};
  })();
}
export function enqueueOutbox(db,node,input) {
  const id=input.id??messageId(); const existing=db.prepare('SELECT * FROM messages_outbox WHERE id=?').get(id);
  if (existing) return {item:decodeOutbox(existing)};
  const provider=listProviders(db).find(p=>p.id===input.provider);
  if (!provider?.capabilities.send || provider.setupHint) throw new MessagesError(422,'Provider cannot send until connected');
  const account=provider.accounts.find(a=>a.id===input.account);
  if (!account) throw new MessagesError(422,'Unknown provider account');
  if(account.setupHint || provider.accountHealth?.[account.id]?.ok===false)throw new MessagesError(422,'Account cannot send until connected');
  if (!input.to || !input.body || typeof input.body.markdown!=='string') throw new MessagesError(422,'Invalid structured send');
  if (!input.body.markdown.trim() && !(input.attachments?.length)) throw new MessagesError(422,'Write a message or attach a file');
  const origin=input.origin==='agent'?'agent':'user';
  const holdSeconds=origin==='agent'?Math.max(0,provider.holdSeconds??60):0;
  const localHoldSeconds=provider.managesAgentHold?0:holdSeconds;
  const item={...input,id,origin,holdUntil:new Date(Date.now()+localHoldSeconds*1000).toISOString(),status:'held',error:null};
  db.transaction(()=>{
    db.prepare('INSERT INTO messages_outbox(id,provider,account,target,body,attachments,replyToExternalId,origin,holdUntil,status,error,createdAt,ownerNode) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?)').run(id,input.provider,input.account,JSON.stringify(input.to),JSON.stringify(input.body),JSON.stringify(input.attachments??[]),input.replyToExternalId??null,origin,item.holdUntil,'held',now(),node);
    if (origin==='agent') emitSystem(db,node,{category:'system.info',title:'Held message',body:`Message to ${provider.label} is held for ${holdSeconds} seconds.`,idempotencyKey:`outbox:${id}`,action:{kind:'cancel-send',prompt:'Cancel this send?',options:['cancel'],answer:null,answeredAt:null,revertUntil:new Date(Date.now()+holdSeconds*1000).toISOString(),target:{outboxId:id}}});
    change(db,node,[id]);
  })(); return {item};
}
function decodeOutbox(r) { if (!r) return null; return {...r,to:JSON.parse(r.target),body:JSON.parse(r.body),attachments:JSON.parse(r.attachments),externalReceipt:r.externalReceipt?JSON.parse(r.externalReceipt):null}; }
export function listOutbox(db) { return {items:db.prepare('SELECT * FROM messages_outbox ORDER BY createdAt DESC LIMIT 200').all().map(decodeOutbox)}; }
function closeOutboxNotice(db,node,id,answer) {
  const rows=db.prepare("SELECT id,conversationId,action FROM messages WHERE json_extract(action,'$.target.outboxId')=? AND json_extract(action,'$.answeredAt') IS NULL").all(id);
  for(const row of rows) {
    const action={...JSON.parse(row.action),answeredAt:now(),answer};
    db.prepare('UPDATE messages SET action=?,read=1,revision=revision+1 WHERE id=?').run(JSON.stringify(action),row.id);
    refreshConversation(db,row.conversationId);change(db,node,[row.id]);
  }
}
export function cancelOutbox(db,node,id) {
  const updated=db.prepare("UPDATE messages_outbox SET status='cancelled' WHERE id=? AND status='held'").run(id);
  const item=decodeOutbox(db.prepare('SELECT * FROM messages_outbox WHERE id=?').get(id));
  if (!item) throw new MessagesError(404,'Send not found');
  if (!updated.changes && item.status!=='cancelled') throw new MessagesError(409,'Sending has already started');
  closeOutboxNotice(db,node,id,'Cancelled');change(db,node,[id]); return {item};
}
export function retryOutbox(db,node,id) {
  return db.transaction(()=>{
    const row=decodeOutbox(db.prepare('SELECT * FROM messages_outbox WHERE id=?').get(id));
    if(!row) throw new MessagesError(404,'Send not found');
    if(row.externalReceipt?.retryOutboxId) return {item:decodeOutbox(db.prepare('SELECT * FROM messages_outbox WHERE id=?').get(row.externalReceipt.retryOutboxId))};
    if(row.status!=='failed') throw new MessagesError(409,'Only a failed send can be retried');
    const result=enqueueOutbox(db,row.ownerNode,{id:messageId(),provider:row.provider,account:row.account,to:row.to,body:row.body,attachments:row.attachments,replyToExternalId:row.replyToExternalId,origin:row.origin});
    db.prepare('UPDATE messages_outbox SET externalReceipt=? WHERE id=?').run(JSON.stringify({...row.externalReceipt,retryOutboxId:result.item.id}),id);
    change(db,node,[id,result.item.id]);return result;
  })();
}
export function claimWork(db,node,kind) {
  return db.transaction(()=>{
    const until=new Date(Date.now()+60_000).toISOString(),token=crypto.randomBytes(24).toString('hex');
    if (kind==='outbox') {
      // Ambiguous sends are never automatically repeated after process loss.
      db.prepare("UPDATE messages_outbox SET status='failed',error='Delivery status unknown. Check the provider before retrying.' WHERE status='sending' AND claimUntil<?").run(now());
      const row=db.prepare("SELECT * FROM messages_outbox WHERE status='held' AND holdUntil<=? AND ownerNode=? ORDER BY holdUntil LIMIT 1").get(now(),node);
      if (!row) return {item:null};
      db.prepare("UPDATE messages_outbox SET status='sending',claimToken=?,claimUntil=? WHERE id=?").run(token,until,row.id);
      return {item:decodeOutbox({...row,status:'sending'}),claimToken:token};
    }
    if (kind==='mirrors') {
      const row=db.prepare("SELECT mm.* FROM messages_mirrors mm JOIN messages m ON m.id=mm.messageId WHERE m.ownerNode=? AND (mm.status='pending' OR (mm.status IN ('running','retry') AND mm.claimUntil<?)) LIMIT 1").get(node,now());
      if (!row) return {item:null};
      db.prepare("UPDATE messages_mirrors SET status='running',claimToken=?,claimUntil=?,attempts=attempts+1 WHERE messageId=? AND channel=?").run(token,until,row.messageId,row.channel);
      return {item:{...row,message:getMessage(db,row.messageId)},claimToken:token};
    }
    const row=db.prepare("SELECT e.* FROM messages_effects e LEFT JOIN messages m ON m.id=e.messageId WHERE (e.status='pending' OR (e.status='running' AND e.claimUntil<?)) AND (e.kind NOT IN ('processMedia','downloadAttachment','pruneFiles') OR COALESCE(json_extract(e.payload,'$.ownerNode'),m.ownerNode)=?) AND (e.kind!='providerState' OR NOT EXISTS (SELECT 1 FROM messages_effects prior WHERE prior.messageId=e.messageId AND prior.kind='providerState' AND prior.status IN ('pending','running') AND CAST(json_extract(prior.payload,'$.revision') AS INTEGER)<CAST(json_extract(e.payload,'$.revision') AS INTEGER))) ORDER BY e.createdAt,e.rowid LIMIT 1").get(now(),node);
    if (!row) return {item:null};
    db.prepare("UPDATE messages_effects SET status='running',claimToken=?,claimUntil=? WHERE id=?").run(token,until,row.id);
    return {item:{...row,payload:JSON.parse(row.payload),message:getMessage(db,row.messageId)},claimToken:token};
  })();
}
export function renewWork(db,node,kind,id,input) {
  const table={outbox:'messages_outbox',mirrors:'messages_mirrors',effects:'messages_effects'}[kind];
  if(!table || typeof input.claimToken!=='string') throw new MessagesError(422,'Invalid work claim');
  const key=kind==='mirrors'?'messageId':'id',status=kind==='outbox'?'sending':'running',until=new Date(Date.now()+60_000).toISOString();
  const result=db.prepare(`UPDATE ${table} SET claimUntil=? WHERE ${key}=? AND claimToken=? AND status=? AND claimUntil>?`).run(until,id,input.claimToken,status,now());
  if(!result.changes) throw new MessagesError(409,'Work claim expired or changed');
  return {renewed:true,claimUntil:until};
}
export function finishWork(db,node,kind,id,input) {
  return db.transaction(()=>{
    if (kind==='outbox') {
      const row=db.prepare('SELECT * FROM messages_outbox WHERE id=? AND claimToken=?').get(id,input.claimToken); if (!row) throw new MessagesError(409,'Send claim changed');
      if(input.pending) { db.prepare("UPDATE messages_outbox SET status='held',externalReceipt=?,holdUntil=? WHERE id=?").run(JSON.stringify(input.externalReceipt),input.nextAttemptAt??new Date(Date.now()+5000).toISOString(),id); change(db,node,[id]); return {ok:true,pending:true}; }
      db.prepare('UPDATE messages_outbox SET status=?,error=?,externalId=? WHERE id=?').run(input.error?'failed':'sent',input.error??null,input.externalId??null,id);
      if (!input.error && input.message) { if (input.conversation) putConversation(db,input.conversation,node); upsertMessage(db,node,{...input.message,direction:'out'}); }
      closeOutboxNotice(db,node,id,input.error?'Delivery failed':'Sent');
    } else if (kind==='mirrors') {
      const row=db.prepare('SELECT * FROM messages_mirrors WHERE messageId=? AND claimToken=?').get(id,input.claimToken); if(!row) throw new MessagesError(409,'Mirror claim changed');
      const prior=JSON.parse(row.receipt??'[]'), incoming=Array.isArray(input.receipt)?input.receipt:[];
      const receipt=[...new Map([...(Array.isArray(prior)?prior:[]),...incoming].map(entry=>[entry.id,entry])).values()];
      const failed=!!input.error||receipt.some(entry=>!entry.ok),exhausted=failed&&row.attempts>=5;
      const next=new Date(Date.now()+Math.min(15*60_000,30_000*2**Math.max(0,row.attempts-1))).toISOString();
      db.prepare('UPDATE messages_mirrors SET status=?,receipt=?,claimUntil=? WHERE messageId=? AND claimToken=?').run(failed?(exhausted?'failed':'retry'):'done',JSON.stringify(receipt),failed?next:null,id,input.claimToken);
      if(exhausted) emitSystem(db,node,{category:'system.warning',severity:'warning',title:'Notification delivery failed',body:'One or more channels could not deliver a notification. The message remains in Messages.',idempotencyKey:`mirror-failed:${id}`,suppressNotification:true});
    } else {
      const row=db.prepare('SELECT * FROM messages_effects WHERE id=? AND claimToken=?').get(id,input.claimToken); if (!row) throw new MessagesError(409,'Effect claim changed');
      db.prepare('UPDATE messages_effects SET status=?,error=? WHERE id=?').run(input.error?'failed':'done',input.error??null,id);
      const payload=JSON.parse(row.payload);
      if (row.kind==='providerState') {
        const raw=db.prepare('SELECT * FROM messages WHERE id=?').get(row.messageId);
        if (raw) {
          const provider=listProviders(db).find(p=>p.id===raw.provider),local=JSON.parse(raw.localState),rollback={};
          const later=db.prepare("SELECT id,payload FROM messages_effects WHERE messageId=? AND kind='providerState' AND CAST(json_extract(payload,'$.revision') AS INTEGER)>? ORDER BY CAST(json_extract(payload,'$.revision') AS INTEGER)").all(row.messageId,payload.revision).map(effect=>({...effect,payload:JSON.parse(effect.payload)}));
          for (const key of Object.keys(payload.patch)) {
            const next=later.find(effect=>Object.hasOwn(effect.payload.patch,key));
            if(input.error) {
              if(next) {
                // Carry the failed operation's baseline into the next queued operation.
                next.payload.before[key]=payload.before[key];
                db.prepare('UPDATE messages_effects SET payload=? WHERE id=?').run(JSON.stringify(next.payload),next.id);
              } else rollback[key]=payload.before[key];
            } else if(!next && provider?.inboundStateFields?.includes(key)) delete local[key];
          }
          if(input.error && Object.keys(rollback).length) {
            patchMessage(db,node,row.messageId,rollback,{queue:false});
            const revertedLocal=JSON.parse(db.prepare('SELECT localState FROM messages WHERE id=?').get(row.messageId).localState);
            for(const key of Object.keys(rollback)) if(provider?.inboundStateFields?.includes(key)) delete revertedLocal[key];
            db.prepare('UPDATE messages SET localState=?,providerHash=NULL WHERE id=?').run(JSON.stringify(revertedLocal),row.messageId);
          }
          if(!input.error) db.prepare('UPDATE messages SET localState=?,providerHash=NULL WHERE id=?').run(JSON.stringify(local),row.messageId);
        }
      }
      if (row.kind==='createCard' && input.cardId) db.prepare('UPDATE messages SET cardId=? WHERE id=?').run(input.cardId,row.messageId);
    }
    change(db,node,[id]); return {ok:true};
  })();
}
export function pruneMessages(db,node,{at=Date.now()}={}) {
  return db.transaction(()=>{
    const removed=[],fileJobs=[];
    for (const provider of listProviders(db)) {
      const cutoff=new Date(at-Math.max(1,provider.retentionDays??90)*86400_000).toISOString();
      const rows=db.prepare("SELECT * FROM messages WHERE provider=? AND ts<? AND starred=0 AND cardId IS NULL AND NOT (provider='system' AND COALESCE(json_extract(action,'$.kind') IN ('question','approval','revert','cancel-send'),0) AND json_extract(action,'$.answeredAt') IS NULL)").all(provider.id,cutoff);
      for (const row of rows) {
        const m=decode(row),byOwner=new Map();
        const add=(owner,paths)=>byOwner.set(owner,[...(byOwner.get(owner)??[]),...paths.filter(Boolean)]);
        add(m.rawOwnerNode??m.ownerNode,[m.rawPath]);add(m.htmlOwnerNode??m.ownerNode,[m.bodyHtmlPath,m.bodyHtmlPath?`html/${m.id}.images.json`:null]);
        for(const a of m.attachments)add(a.ownerNode??m.ownerNode,[a.path,a.thumbPath,a.playbackPath]);
        for(const [ownerNode,paths] of byOwner)if(paths.length)fileJobs.push({id:m.id,ownerNode,paths});
        removed.push({id:m.id});db.prepare('DELETE FROM messages WHERE id=?').run(row.id);
      }
      const terminal=db.prepare("SELECT o.* FROM messages_outbox o WHERE o.provider=? AND o.createdAt<? AND o.status IN ('sent','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.provider=o.provider AND m.account=o.account AND m.externalId=o.externalId AND (m.starred=1 OR m.cardId IS NOT NULL)) AND NOT EXISTS (SELECT 1 FROM messages_outbox retry WHERE retry.id=json_extract(o.externalReceipt,'$.retryOutboxId') AND retry.status IN ('held','sending'))").all(provider.id,cutoff);
      for(const row of terminal) {
        const item=decodeOutbox(row);
        fileJobs.push({id:`outbox:${item.id}`,ownerNode:item.ownerNode,paths:item.attachments.map(attachment=>attachment.path).filter(Boolean)});
        db.prepare('DELETE FROM messages_outbox WHERE id=?').run(item.id);
      }
    }
    const retained=new Set(),keep=(owner,file)=>{if(file)retained.add(`${owner}:${file}`);};
    for(const row of db.prepare('SELECT * FROM messages').all()) {
      const message=decode(row);
      keep(message.rawOwnerNode??message.ownerNode,message.rawPath);keep(message.htmlOwnerNode??message.ownerNode,message.bodyHtmlPath);
      if(message.bodyHtmlPath)keep(message.htmlOwnerNode??message.ownerNode,`html/${message.id}.images.json`);
      for(const attachment of message.attachments)for(const file of [attachment.path,attachment.thumbPath,attachment.playbackPath])keep(attachment.ownerNode??message.ownerNode,file);
    }
    for(const row of db.prepare('SELECT ownerNode,attachments FROM messages_outbox').all())for(const attachment of JSON.parse(row.attachments))keep(row.ownerNode,attachment.path);
    for(const job of fileJobs) {
      const paths=[...new Set(job.paths)].filter(file=>!retained.has(`${job.ownerNode}:${file}`));
      if(paths.length)queueEffect(db,null,'pruneFiles',{...job,paths},`prune:${job.id}:${job.ownerNode}`);
    }
    db.prepare('DELETE FROM messages_conversations WHERE id NOT IN (SELECT conversationId FROM messages)').run();
    if (removed.length) change(db,node,removed.map(r=>r.id)); return {removed:removed.length};
  })();
}

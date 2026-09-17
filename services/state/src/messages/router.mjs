import * as s from './store.mjs';
const decode = value => { if (!value) return {}; try { return JSON.parse(value); } catch { throw new s.MessagesError(422,'Invalid filter JSON'); } };
export function messagesRoute(db,actor,method,path,url,body={}) {
  const p=path.map(decodeURIComponent),node=actor.name;
  if (actor.scope==='messages-ingest') {
    const allowed=(method==='GET' && ['providers','sync'].includes(p[0])) || (method==='POST' && (p[0]==='ingest' || (p[0]==='lease' && p[1]==='renew')));
    if (!allowed) throw new s.MessagesError(403,'Ingestion may only read providers, renew its lease and ingest data');
  }
  if (p[0]==='lease') {
    if (method==='POST' && p[1]==='acquire') return s.acquireIngestLease(db,node);
    if (method==='POST' && p[1]==='renew') return s.renewIngest(db,actor);
  }
  if (p[0]==='providers') {
    if (method==='GET') { s.ensureSystem(db); return {providers:s.listProviders(db)}; }
    if (method==='POST' && p[1]==='register') return s.registerProvider(db,node,body);
    if (method==='POST' && p[2]==='health') return s.setProviderHealth(db,node,p[1],body);
    if (method==='POST' && p.length===2) {
      const old=s.listProviders(db).find(v=>v.id===p[1]); if (!old) throw new s.MessagesError(404,'Provider not found');
      const allowed=['retentionDays','sendReadReceipts','holdSeconds']; if (Object.keys(body).some(k=>!allowed.includes(k))) throw new s.MessagesError(422,'Invalid provider settings');
      for(const key of ['retentionDays','holdSeconds'])if(body[key]!=null&&(!Number.isInteger(body[key])||body[key]<(key==='retentionDays'?1:0)||body[key]>3650))throw new s.MessagesError(422,'Invalid provider setting');
      if(body.sendReadReceipts!=null&&typeof body.sendReadReceipts!=='boolean')throw new s.MessagesError(422,'Invalid read receipt setting');
      return s.registerProvider(db,old.ownerNode,{descriptor:{...old,...body},callbackBaseUrl:old.callbackBaseUrl,settingsUpdate:true});
    }
  }
  if (p[0]==='sync') {
    if (method==='GET') return {sync:db.prepare('SELECT * FROM messages_sync').all().map(r=>({...r,cursor:r.cursor?JSON.parse(r.cursor):null}))};
    if (method==='POST') { const providers=body.providers??s.listProviders(db).map(p=>p.id); for (const id of providers) db.prepare('UPDATE messages_sync SET requested=1 WHERE provider=?').run(id); return {requested:true}; }
  }
  if (p[0]==='ingest' && method==='POST') return s.ingestBatch(db,actor,body);
  if (p[0]==='system' && method==='POST') return s.emitSystem(db,node,body);
  if (p[0]==='counts' && method==='GET') { s.ensureSystem(db); return s.counts(db); }
  if (p[0]==='needs-me' && method==='GET') return s.listMessages(db,{kinds:['system'],actionable:true},url.searchParams.get('cursor'));
  if (p[0]==='conversations') {
    if (method==='GET' && p.length===1) return s.listConversations(db,decode(url.searchParams.get('filter')),url.searchParams.get('cursor'),url.searchParams.get('limit'));
    if (method==='GET' && p.length===2) return s.getConversation(db,p[1]);
    if (method==='POST' && p[2]==='state') return s.patchConversation(db,node,p[1],body);
  }
  if (p[0]==='views') {
    if (method==='GET') return {views:s.listViews(db)};
    if (method==='POST') return s.saveView(db,node,body);
    if (method==='DELETE') return s.deleteView(db,node,p[1]);
  }
  if (p[0]==='rules') {
    if (method==='GET') return {rules:s.listRules(db)};
    if (method==='POST' && p[1]==='test') return s.testRule(db,body);
    if (method==='POST' && p[2]==='apply') { const id=s.messageId(); db.prepare("INSERT INTO messages_effects(id,kind,payload,createdAt) VALUES (?,'applyRule',?,?)").run(id,JSON.stringify({ruleId:p[1]}),new Date().toISOString()); return {jobId:id,...s.testRule(db,s.listRules(db).find(r=>r.id===p[1]))}; }
    if (method==='POST' && p[2]==='run') return s.applyRule(db,node,p[1]);
    if (method==='POST' && p.length===1) return s.saveRule(db,node,body);
    if (method==='DELETE') { db.prepare('DELETE FROM messages_rules WHERE id=?').run(p[1]); return {deleted:true}; }
  }
  if (p[0]==='outbox') {
    if (method==='GET') return s.listOutbox(db);
    if (method==='POST' && p.length===1) return s.enqueueOutbox(db,node,body);
    if (method==='POST' && p[2]==='cancel') return s.cancelOutbox(db,node,p[1]);
    if (method==='POST' && p[2]==='retry') return s.retryOutbox(db,node,p[1]);
  }
  if (p[0]==='work' && method==='POST') {
    if (p[2]==='claim') return s.claimWork(db,node,p[1]);
    if (p[3]==='finish') return s.finishWork(db,node,p[1],p[2],body);
    if (p[3]==='renew') return s.renewWork(db,node,p[1],p[2],body);
  }
  if (p[0]==='retention' && method==='POST') return s.pruneMessages(db,node);
  if (method==='GET' && p.length===0) return s.listMessages(db,decode(url.searchParams.get('filter')),url.searchParams.get('cursor'),url.searchParams.get('limit'));
  if (method==='GET' && p.length===2 && p[1]==='effects') return s.listProviderStateEffects(db,p[0]);
  if (method==='GET' && p.length===1) { const message=s.getMessage(db,p[0]); if (!message) throw new s.MessagesError(404,'Message not found'); return {message}; }
  if (method==='POST' && p[1]==='download') { const message=s.getMessage(db,p[0]); if(!message?.attachments.some(a=>a.id===body.attachmentId)) throw new s.MessagesError(404,'Attachment not found'); const id=`download:${p[0]}:${body.attachmentId}`; db.prepare("INSERT OR IGNORE INTO messages_effects(id,messageId,kind,payload,createdAt) VALUES (?,?,'downloadAttachment',?,?)").run(id,p[0],JSON.stringify({attachmentId:body.attachmentId,ownerNode:message.attachments.find(a=>a.id===body.attachmentId).ownerNode??message.ownerNode}),new Date().toISOString()); return {jobId:id}; }
  if (method==='POST' && p[1]==='media') return s.updateMedia(db,node,p[0],body.attachment);
  if (method==='POST' && p[1]==='state') return s.patchMessage(db,node,p[0],body);
  if (method==='POST' && p[1]==='answer' && p[2]==='begin') return s.beginAnswer(db,node,p[0],body.answer);
  if (method==='POST' && p[1]==='answer' && p[2]==='finish') return s.finishAnswer(db,node,p[0],body);
  if (method==='POST' && p[1]==='card') { const message=s.getMessage(db,p[0]); if (!message) throw new s.MessagesError(404,'Message not found'); if (message.cardId) return {cardId:message.cardId}; const id=`card:${p[0]}`; db.prepare("INSERT OR IGNORE INTO messages_effects(id,messageId,kind,payload,createdAt) VALUES (?,?,'createCard',?,?)").run(id,p[0],JSON.stringify(body),new Date().toISOString()); return {jobId:id}; }
  throw new s.MessagesError(404,`No Messages route for ${method} ${p.join('/')}`);
}

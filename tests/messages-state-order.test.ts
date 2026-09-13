import { expect, it } from 'vitest';
import { messagesDbFixture } from './messages-db-fixture';
import { claimWork, finishWork, getMessage, patchMessage, updateMedia } from '../services/state/src/messages/store.mjs';

function finish(f: ReturnType<typeof messagesDbFixture>, claim: any, error?: string) {
  finishWork(f.db, f.node, 'effects', claim.item.id, { claimToken: claim.claimToken, error });
}
it('rolls back failed read after unrelated media metadata advances the message revision', () => {
  const f=messagesDbFixture();
  try {
    const m=f.ingest('media-race',{ attachments:[{ id:'a',kind:'file',name:'a.txt',mime:'text/plain',size:1,path:null,thumbPath:null,playbackPath:null,durationMs:null,transcript:null,transcriptStatus:'none' }] });
    patchMessage(f.db,f.node,m.id,{read:true});
    const claim=claimWork(f.db,f.node,'effects');
    updateMedia(f.db,f.node,m.id,{id:'a',transcript:'A later transcript',transcriptStatus:'done'});
    finish(f,claim,'Provider rejected read');
    expect(getMessage(f.db,m.id).read).toBe(false);
    expect(getMessage(f.db,m.id).attachments[0].transcript).toBe('A later transcript');
  } finally { f.close(); }
});
it('serializes provider mutations and retains a newer optimistic override when the earlier send completes', () => {
  const f=messagesDbFixture();
  try {
    const m=f.ingest('read-order');
    patchMessage(f.db,f.node,m.id,{read:true});
    const first=claimWork(f.db,f.node,'effects');
    patchMessage(f.db,f.node,m.id,{read:false});
    expect(claimWork(f.db,'peer','effects').item).toBeNull();
    finish(f,first);
    expect(JSON.parse(f.db.prepare('SELECT localState FROM messages WHERE id=?').get(m.id).localState).read).toBe(false);
    const second=claimWork(f.db,'peer','effects');
    expect(second.item.payload.patch).toEqual({read:false});
    finish(f,second);
    expect(getMessage(f.db,m.id).read).toBe(false);
    expect(JSON.parse(f.db.prepare('SELECT localState FROM messages WHERE id=?').get(m.id).localState)).not.toHaveProperty('read');
  } finally { f.close(); }
});
it('propagates a failed baseline through consecutive failed optimistic changes', () => {
  const f=messagesDbFixture();
  try {
    const m=f.ingest('failed-chain');
    patchMessage(f.db,f.node,m.id,{read:true});
    const first=claimWork(f.db,f.node,'effects');
    patchMessage(f.db,f.node,m.id,{read:false,starred:true});
    finish(f,first,'First rejected');
    const second=claimWork(f.db,f.node,'effects');
    expect(second.item.payload.before.read).toBe(false);
    finish(f,second,'Second rejected');
    expect(getMessage(f.db,m.id)).toMatchObject({read:false,starred:false});
  } finally { f.close(); }
});

it('returns failed Gmail fields to provider authority on the next native sync',()=>{
  const f=messagesDbFixture();
  try {
    const m=f.ingest('native-after-failure');
    patchMessage(f.db,f.node,m.id,{read:true});
    const claim=claimWork(f.db,f.node,'effects');
    finish(f,claim,'Provider rejected read');
    expect(getMessage(f.db,m.id).read).toBe(false);
    expect(JSON.parse(f.db.prepare('SELECT localState FROM messages WHERE id=?').get(m.id).localState)).not.toHaveProperty('read');
    f.ingest('native-after-failure',{read:true});
    expect(getMessage(f.db,m.id).read).toBe(true);
  } finally { f.close(); }
});

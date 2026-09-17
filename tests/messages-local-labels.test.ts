import { expect, it } from 'vitest';
import { messagesDbFixture } from './messages-db-fixture';
import { getMessage, saveRule } from '../services/state/src/messages/store.mjs';

it('keeps Garrison rule labels while native labels change without sending names as provider IDs',()=>{
  const f=messagesDbFixture();
  try {
    saveRule(f.db,f.node,{name:'Client label',match:{from:'client'},actions:[{type:'label',label:'Clients'},{type:'markRead'}]});
    const m=f.ingest('local-label',{labels:['INBOX','UNREAD']});
    expect(getMessage(f.db,m.id).labels).toEqual(['INBOX','UNREAD','Clients']);
    const effects=f.db.prepare("SELECT payload FROM messages_effects WHERE messageId=? AND kind='providerState'").all(m.id).map((e:any)=>JSON.parse(e.payload));
    expect(effects).toHaveLength(1);expect(effects[0].patch).toEqual({read:true});
    f.ingest('local-label',{labels:['STARRED'],starred:true,bodyText:'Native labels changed'});
    expect(getMessage(f.db,m.id).labels).toEqual(['STARRED','Clients']);
    expect(getMessage(f.db,m.id).starred).toBe(true);
  } finally {f.close();}
});

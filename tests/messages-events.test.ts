import { expect, it, vi } from 'vitest';
import { StateApiError } from '@garrison/state-client';
const client=vi.hoisted(()=>({changes:vi.fn()}));
vi.mock('../src/lib/state-client',async()=>({stateClient:()=>client,withState:(fn:any)=>fn(client),StateApiError:(await import('@garrison/state-client')).StateApiError}));
import { messagesEvents } from '../src/lib/messages';

it('recovers a pruned event cursor by refreshing both views before continuing at the current sequence',async()=>{
  const abort=new AbortController();
  client.changes.mockRejectedValueOnce(new StateApiError(410,{seq:900,earliest:500})).mockImplementationOnce(async()=>{
    abort.abort();return {seq:901,changes:[]};
  });
  const response=messagesEvents(abort.signal),body=await response.text();
  expect(client.changes.mock.calls.map(call=>call[0])).toEqual([0,900]);
  expect(body).toContain('event: messages.changed\ndata: {"ids":[],"resync":true}');
  expect(body).toContain('event: providers.changed');
  expect(body).not.toContain('event: error');
});

import http from 'node:http';
import {expect,it} from 'vitest';
import {StateClient,StateUnavailableError} from '@garrison/state-client';

it('accepts a cold connection slower than five seconds while respecting explicit short deadlines',async()=>{
  let calls=0;
  const server=http.createServer((_,res)=>{calls++;const timer=setTimeout(()=>res.end('{"ok":true}'),5500);res.on('close',()=>clearTimeout(timer));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}`;
  try{
    const client=new StateClient({url,token:'fixture'});
    await expect(client.health()).resolves.toEqual({ok:true});
    expect(calls).toBe(1);
    const short=new StateClient({url,token:'fixture',timeoutMs:30});
    await expect(short.health()).rejects.toBeInstanceOf(StateUnavailableError);
    expect(calls).toBe(3);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},10000);

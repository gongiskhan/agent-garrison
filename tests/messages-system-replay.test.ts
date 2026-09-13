import {expect,it,vi} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {emitSystemMessage,deliverMessageMirrors} from "../packages/messages/system.mjs";
import {emitSystem} from "../services/state/src/messages/store.mjs";
import {messagesDbFixture} from "./messages-db-fixture";

it("reuses the same attachment file across replay and bounds reads before loading oversized data",async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"message-replay-"));
  try {
    const source=path.join(home,"fixture.txt");await fs.writeFile(source,"redacted fixture");
    const request=vi.fn(async()=>({message:{id:"stored"}}));
    const input={idempotencyKey:"source-event",receivedTs:"2026-09-13T10:00:00Z",title:"Fixture",body:"Attachment",attachments:[{path:source,name:"fixture.txt",mime:"text/plain"}]};
    await emitSystemMessage(input,{client:{request},env:{GARRISON_HOME:home}});await emitSystemMessage(input,{client:{request},env:{GARRISON_HOME:home}});
    const first=request.mock.calls[0] as any,second=request.mock.calls[1] as any;
    expect(second[2].body.attachments).toEqual(first[2].body.attachments);
    expect(await fs.readdir(path.join(home,"messages","attachments","system","default","2026-09"))).toHaveLength(1);
    await fs.truncate(source,26*1024*1024);
    await expect(emitSystemMessage(input,{client:{request},env:{GARRISON_HOME:home}})).rejects.toThrow("25 MB");
    expect(request).toHaveBeenCalledTimes(2);
  } finally {await fs.rm(home,{recursive:true,force:true});}
});
it("keeps interactive notification policy as validated stored metadata",async()=>{
  const fixture=messagesDbFixture();
  try {
    const message=emitSystem(fixture.db,fixture.node,{title:"Answer ready",body:"Quoted body is data",mirrorContext:{priority:"interactive",webFallback:false,tag:"conversation_reply"}}).message;
    const sent:any[]=[];
    await deliverMessageMirrors(message,{targets:[{id:"capture-service",url:"http://capture.fixture/notify"}],fetchImpl:async (_url,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json([{ok:true}]);}});
    expect(sent[0]).toMatchObject({priority:"interactive",webFallback:false,tag:"conversation_reply",path:`/messages/${message.id}`});
    expect(()=>emitSystem(fixture.db,fixture.node,{title:"Bad",body:"Fixture",mirrorContext:{send:true}})).toThrow();
  }finally {fixture.close();}
});

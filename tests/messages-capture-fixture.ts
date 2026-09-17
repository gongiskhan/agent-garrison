import { messagesDbFixture } from "./messages-db-fixture";
import { emitSystem, claimWork, finishWork } from "../services/state/src/messages/store.mjs";
import { deliverMessageMirrors } from "../packages/messages/system.mjs";
import { createServer } from "node:http";

// Capture journeys use the real store and a synchronous fixture subscriber.
// The production subscriber is the exclusive broker, tested independently.
export function captureMessagesFixture(notifier: any) {
  const fixture = messagesDbFixture(), priorFetch = notifier.fetchImpl ?? fetch;
  notifier.env = {...notifier.env,GARRISON_STATE_URL:"http://messages.fixture",GARRISON_STATE_TOKEN:"fixture-token",GARRISON_NODE_NAME:fixture.node};
  notifier.fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "http://messages.fixture/v1/messages/system") return priorFetch(input,init);
    const result = emitSystem(fixture.db,fixture.node,JSON.parse(String(init?.body)));
    const claim = claimWork(fixture.db,fixture.node,"mirrors");
    if (claim.item) {
      const receipt = await deliverMessageMirrors(result.message,{targets:[{id:"capture-service",url:"http://capture.fixture/notify"}],fetchImpl:async (_url,payload) => {
        const body = JSON.parse(String(payload?.body));
        return Response.json(await notifier.deliver({...body,body:body.text}));
      }});
      finishWork(fixture.db,fixture.node,"mirrors",result.message.id,{claimToken:claim.claimToken,receipt});
    }
    return Response.json(result);
  };
  return {...fixture,async listen() {
    const server = createServer((req,res)=>{
      let raw="";req.on("data",chunk=>raw+=chunk);req.on("end",async()=>{
        if(req.url!=="/v1/messages/system"||req.method!=="POST"||req.headers.authorization!=="Bearer fixture-token") {res.writeHead(403);res.end();return;}
        try {const result=await notifier.fetchImpl("http://messages.fixture/v1/messages/system",{method:"POST",body:raw});res.writeHead(result.status,{"content-type":"application/json"});res.end(await result.text());}
        catch(error:any) {res.writeHead(500,{"content-type":"application/json"});res.end(JSON.stringify({error:error.message}));}
      });
    });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    return {env:{GARRISON_STATE_URL:`http://127.0.0.1:${(server.address() as any).port}`,GARRISON_STATE_TOKEN:"fixture-token",GARRISON_NODE_NAME:fixture.node},close:()=>server.close()};
  }};
}

// APNs transport tests explicitly enter the sink after durable delivery.
export function captureMirrorSink(notifier: any) {
  const deliver = notifier.deliver.bind(notifier);
  notifier.deliver = (payload: any) => deliver({...payload,_messagesMirror:{id:"fixture-stored-message"}});
  const fallback = notifier.sendWebChannelFallback.bind(notifier);
  notifier.sendWebChannelFallback = (message: string, marker?: any) => fallback(message,marker??{id:"fixture-stored-message"});
}

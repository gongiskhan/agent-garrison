import {expect,it} from "vitest";
import {connectorMessagingAccounts,messageAccountAvailable,MessagesRuntime} from "../src/lib/messages-runtime";
import {GOOGLE_MESSAGES_SCOPES,googleDescriptor} from "../packages/messages/providers/google-common";
import {SLACK_MESSAGES_SCOPES} from "../packages/messages/providers/slack-common";

const grant=(id:string,scopes:string[],status:"valid"|"revoked"="valid")=>({id,label:id,address:`${id}@example.invalid`,scopes,status,grantId:id});
it("keeps all Google accounts visible and only blocks the account missing required scopes",()=>{
  const result=connectorMessagingAccounts("google",[grant("work",[...GOOGLE_MESSAGES_SCOPES]),grant("personal",["gmail.send"]),grant("old",[],"revoked")]);
  expect(result.setupHint).toBeNull();expect(result.accounts.map(account=>account.id)).toEqual(["work","personal"]);
  expect(result.accounts[0].setupHint).toBeNull();expect(result.accounts[1].setupHint).toContain("Reconnect Google");
  const descriptor={...googleDescriptor(result.accounts),health:{ok:true},accountHealth:{work:{ok:true},personal:{ok:false}}};
  expect(messageAccountAvailable(descriptor,"work")).toBe(true);expect(messageAccountAvailable(descriptor,"personal")).toBe(false);
});
it("registers Slack setup failures and accepts a complete user grant",()=>{
  expect(connectorMessagingAccounts("slack",[])).toMatchObject({setupHint:"Reinstall Slack with user scopes"});
  expect(connectorMessagingAccounts("slack",[grant("workspace",[...SLACK_MESSAGES_SCOPES])]).setupHint).toBeNull();
});
it("continues ingest retries for transient account failures while excluding consent failures",async()=>{
  const descriptor=googleDescriptor([{id:"retry",label:"Retry"},{id:"consent",label:"Consent",setupHint:"Reconnect"}]);
  const runtime:any=new MessagesRuntime({client:{} as any,env:{NODE_ENV:"test",GARRISON_HOME:"/tmp/messages-account-fixture"}});
  runtime.providers=[{...descriptor,health:{ok:false},accountHealth:{retry:{ok:false,reason:"Rate limited"}}}];
  runtime.connectorToken=async()=>"fixture-own-provider-token";
  const accounts=await runtime.ingestAccounts();expect(accounts.map((entry:any)=>entry.account.id)).toEqual(["retry"]);
  expect(accounts[0].token).toBe("fixture-own-provider-token");
});

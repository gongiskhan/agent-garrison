import {parseDocument} from "yaml";

const RETIRED=new Set(["improver","improver-nightly"]);
// Scoped migration: preserve every unrelated selection, account and user value.
export function migrateImproverManifest(text) {
  const doc=parseDocument(text);
  if(doc.errors.length) throw new Error("Cannot migrate an invalid composition manifest");
  let changed=false;
  const selections=doc.getIn(["x-garrison","composition","selections"]);
  for(const pair of selections?.items??[]) {
    const list=pair.value;
    if(!Array.isArray(list?.items))continue;
    for(let i=list.items.length-1;i>=0;i--) {
      if(RETIRED.has(list.items[i]?.get?.("id"))) {list.delete(i);changed=true;}
    }
  }
  const deps=doc.getIn(["dependencies","apm"]);
  if(Array.isArray(deps?.items))for(let i=deps.items.length-1;i>=0;i--) {
    const dep=deps.items[i]?.get?.("path")??deps.items[i]?.value;
    if(typeof dep==="string" && /(?:^|\/)improver(?:-nightly)?\/?$/.test(dep)) {deps.delete(i);changed=true;}
  }
  return {changed,manifestYaml:changed?doc.toString():text};
}

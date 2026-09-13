// One initialization/config refresh at a time. Warm document reads do not
// depend on a remote composition read; configuration is refreshed in the
// background at most once per interval, preserving the last working service
// on a transient authority failure. No configuration is persisted here.
export function createServiceCache({resolve,create,clock=Date.now,ttlMs=10_000,onError=()=>{}}){
  let current,pending,checkedAt=-Infinity;
  async function refresh(){
    if(pending)return pending;
    checkedAt=clock();
    pending=(async()=>{
      const resolved=await resolve();
      if(current?.key===resolved.key)return current.service;
      const service=await create(resolved),previous=current;
      current={key:resolved.key,service};
      if(previous)void Promise.resolve(previous.service.close()).catch(onError);
      return service;
    })().finally(()=>{pending=undefined;});
    return pending;
  }
  return async()=>{
    if(!current)return refresh();
    if(clock()-checkedAt>=ttlMs)void refresh().catch(onError);
    return current.service;
  };
}

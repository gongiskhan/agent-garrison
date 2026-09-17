import {expect,it,vi} from 'vitest';
// @ts-ignore
import {createServiceCache} from '../packages/archive/src/service-cache.mjs';
it('shares cold initialization and keeps warm reads independent of composition latency',async()=>{
 let clock=0,release!:(x:any)=>void;
 const resolve=vi.fn(()=>new Promise(r=>release=r));
 const service={close:vi.fn()},create=vi.fn(async()=>service),errors:any[]=[];
 const get=createServiceCache({resolve,create,clock:()=>clock,onError:(e:any)=>errors.push(e)});
 const requests=Array.from({length:20},()=>get());
 expect(resolve).toHaveBeenCalledTimes(1);release({key:'first'});
 expect((await Promise.all(requests)).every((s:any)=>s===service)).toBe(true);
 expect(create).toHaveBeenCalledTimes(1);
 clock=20_000;expect(await get()).toBe(service);expect(await get()).toBe(service);
 expect(resolve).toHaveBeenCalledTimes(2);release({key:'first'});
 await Promise.resolve();await Promise.resolve();expect(create).toHaveBeenCalledTimes(1);
});
it('retries initialization and keeps the existing vault accessible during authority failure',async()=>{
 const service={close:vi.fn()},error=new Error('fixture authority unavailable');let clock=0;
 const resolve=vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({key:'first'}).mockRejectedValueOnce(error).mockResolvedValue({key:'second'});
 const next={close:vi.fn()},create=vi.fn().mockResolvedValueOnce(service).mockResolvedValue(next);
 const get=createServiceCache({resolve,create,clock:()=>clock});
 await expect(get()).rejects.toThrow(error);expect(await get()).toBe(service);
 clock=20_000;expect(await get()).toBe(service);await new Promise(r=>setTimeout(r,0));
 expect(await get()).toBe(service);
 clock=40_000;expect(await get()).toBe(service);await new Promise(r=>setTimeout(r,0));
 expect(await get()).toBe(next);expect(service.close).toHaveBeenCalledTimes(1);
});

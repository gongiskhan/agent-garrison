import fs from 'node:fs/promises';import path from 'node:path';
import { it,expect } from 'vitest';import { scratch } from './archive-test-helpers';
it('uses max+10, touches only the moved card for midpoint and renumbers only a crowded list',async()=>{const s=await scratch({seed:false});try{
 const list=(await s.request('list','POST',{title:'Ordered'})).data.path,other=(await s.request('list','POST',{title:'Other'})).data.path;const paths=[];for(const title of ['A','B','C'])paths.push((await s.request('card','POST',{list,title})).data.path);const untouched=(await s.request('card','POST',{list:other,title:'Other'})).data.path;const otherRaw=await s.read(untouched+'/index.md');const get=async(p:string)=>(await s.request('card?path='+p)).data;
 expect((await get(paths[2])).frontmatter.order).toBe(30);const firstRaw=await s.read(paths[0]+'/index.md'),secondRaw=await s.read(paths[1]+'/index.md');await s.request('card/reorder','POST',{path:paths[2],index:1});expect((await get(paths[2])).frontmatter.order).toBe(15);expect(await s.read(paths[0]+'/index.md')).toBe(firstRaw);expect(await s.read(paths[1]+'/index.md')).toBe(secondRaw);
 const b=await get(paths[1]);await s.request('card','PATCH',{path:paths[1],baseSha:b.sha,order:10.0001});await s.request('card/reorder','POST',{path:paths[2],index:1});expect((await Promise.all([paths[0],paths[2],paths[1]].map(get))).map((c:any)=>c.frontmatter.order)).toEqual([10,20,30]);expect(await s.read(untouched+'/index.md')).toBe(otherRaw);
}finally{await s.close();}});

it('a concurrent list metadata edit survives reorder instead of being overwritten',async()=>{
 const s=await scratch();try{
  const relative='Archive/House/_list.md',original=s.ctx.write;let changed=false;
  s.ctx.write=async(file:string,data:any,options:any)=>{if(file===path.join(s.vaultDir,relative)&&!changed){changed=true;await fs.writeFile(file,'---\ngarrison: list\ntitle: House\norder: 999\n---\nConcurrent list notes\n');}return original(file,data,options);};
  const result=await s.request('list','PATCH',{path:'Archive/House',order:15});expect(result.status).toBe(409);expect(await s.read(relative)).toContain('Concurrent list notes');expect(await s.read(relative)).toContain('order: 999');
 }finally{await s.close();}
});

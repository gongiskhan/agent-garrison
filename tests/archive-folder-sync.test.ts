import {it,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {scratch} from './archive-test-helpers';

it('keeps newly created empty folders in both areas after a Git clone without listing metadata as a note',async()=>{
 const s=await scratch({seed:false});try{
  const folders=[];
  for(const parent of ['Archive','']){
   const created=await s.request('folder','POST',{parent,name:'Empty references'});expect(created.status).toBe(200);folders.push(created.data.path);
   expect((await s.request('tree?depth=0&path='+encodeURIComponent(created.data.path))).data.children).toEqual([]);
  }
  execFileSync('git',['init','-q',s.vaultDir]);execFileSync('git',['-C',s.vaultDir,'add','.']);
  execFileSync('git',['-C',s.vaultDir,'-c','user.name=Archive fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture folders','--allow-empty']);
  const peer=path.join(s.root,'peer-vault');execFileSync('git',['clone','-q',s.vaultDir,peer]);
  for(const folder of folders)expect((await fs.stat(path.join(peer,folder)).catch(()=>null))?.isDirectory()).toBe(true);
  expect((await s.request('search?q=Empty')).data.hits).toEqual([]);
  await s.request('note','PUT',{path:'Memory/_list.md',markdown:'# Ordinary notebook note',baseSha:'new'});
  expect((await s.request('tree?depth=0&path=Memory')).data.children).toEqual([expect.objectContaining({path:'Memory/_list.md',kind:'note'})]);
  expect((await s.request('search?q=notebook')).data.hits).toEqual([expect.objectContaining({path:'Memory/_list.md',kind:'note'})]);
 }finally{await s.close();}
});

import {expect,it} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
// @ts-ignore Plain ESM shared with the service.
import {thumbnail} from '../packages/archive/src/ingest/binaries.mjs';

async function fixture(){
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'archive-thumbnails-')));
  const dataDir=path.join(home,'archive');await fs.mkdir(dataDir);
  return {home,dataDir,confine:(relative:string)=>path.join(home,relative)};
}

it('publishes a complete thumbnail atomically when identical attachments are requested together',async()=>{
  const ctx=await fixture(),file=path.join(ctx.dataDir,'thumbs/shared.jpg');
  let release!:()=>void,started!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
  const options={find:(name:string)=>name==='sips'?'fixture-converter':null,execute:async(_command:string,args:string[])=>{
    calls++;const output=args.at(-1)!;await fs.writeFile(output,'PARTIAL');started();await gate;await fs.writeFile(output,'COMPLETE');
  }};
  try{
    const first=thumbnail(ctx,'first.jpg','shared',options);await ready;
    const second=thumbnail(ctx,'second.jpg','shared',options);
    await expect(fs.stat(file)).rejects.toMatchObject({code:'ENOENT'});
    release();expect(await Promise.all([first,second])).toEqual([file,file]);
    expect(calls).toBe(1);expect(await fs.readFile(file,'utf8')).toBe('COMPLETE');
    expect(await fs.readdir(path.dirname(file))).toEqual(['shared.jpg']);
  }finally{release();await fs.rm(ctx.home,{recursive:true,force:true});}
});

it('removes a failed partial conversion and allows the next thumbnail request to retry',async()=>{
  const ctx=await fixture();let calls=0;
  const options={find:(name:string)=>name==='sips'?'fixture-converter':null,execute:async(_command:string,args:string[])=>{
    await fs.writeFile(args.at(-1)!,++calls===1?'PARTIAL':'COMPLETE');if(calls===1)throw new Error('Fixture conversion failed');
  }};
  try{
    await expect(thumbnail(ctx,'first.jpg','shared',options)).rejects.toThrow('Fixture conversion failed');
    expect(await fs.readdir(path.join(ctx.dataDir,'thumbs'))).toEqual([]);
    const file=await thumbnail(ctx,'first.jpg','shared',options);
    expect(await fs.readFile(file,'utf8')).toBe('COMPLETE');expect(calls).toBe(2);
  }finally{await fs.rm(ctx.home,{recursive:true,force:true});}
});

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { confine, DEFAULT_CONFIG, fail, isMirror } from './paths.mjs';
import { atomicWrite, now, sha } from './io.mjs';
import { tree, cardView, mimeOf } from './tree.mjs';
import { readNote, writeNote, assertNoteEditable } from './notes.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import * as ops from './ops.mjs';
import { reorderCard } from './list.mjs';
import { ArchiveIndex } from './index.mjs';
import { JobLedger } from './jobs.mjs';
import { IngestQueue } from './ingest/queue.mjs';
import { watchVault } from './watcher.mjs';
import { createLook, documentSchema, judgeSchema } from './ingest/look.mjs';
import { binary, run, thumbnail } from './ingest/binaries.mjs';
import { syncStatus, triggerSync } from './sync.mjs';
import { TrelloClient, parallel } from './trello/client.mjs';
import { mapBoard } from './trello/mapper.mjs';
import { importBoard } from './trello/importer.mjs';

const p=z.string().min(1).max(2048),text=z.string().max(2_000_000),title=z.string().trim().min(1).max(500),base=z.string().min(1);
const link=z.object({title:z.string().max(1000),url:z.string().url().refine(u=>/^https?:\/\//i.test(u),'Use an HTTP or HTTPS link')}).strict();
const checklist=z.object({title,items:z.array(z.object({text:z.string().max(10000),done:z.boolean()}).strict())}).strict();
const cardPatch=z.object({path:p,baseSha:base,title:title.optional(),description:text.optional(),details:z.array(z.object({label:title,value:text})).optional(),cover:z.string().optional(),tags:z.array(z.string().max(200)).optional(),sensitive:z.boolean().optional(),due:z.string().nullable().optional(),links:z.array(link).optional(),checklists:z.array(checklist).optional(),comments:z.array(z.object({at:z.string(),author:title,markdown:text})).optional(),order:z.number().finite().optional(),moveToList:p.optional()}).strict();
const boardInput=z.object({boardId:p,includeArchived:z.boolean().default(false),targetPrefix:z.string().max(80).optional()}).strict();
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

export function createArchiveService({vaultDir,home,config={},node='local',render,write=atomicWrite,look,invoke,runNow,credentials,clientFactory,authorizeInternal=async()=>false,watch=true,ingest=true,queueOptions={},onError=()=>{}}){
  if(!home)throw new Error('Archive requires an explicit GARRISON_HOME');
  const cfg=z.object({extract_target:title,max_file_mb:z.number().positive().max(1024),pdf_max_pages:z.number().int().min(1).max(1000),author:title}).parse({...DEFAULT_CONFIG,...config});
  const ctx={vaultDir,home,dataDir:path.join(home,'archive'),config:cfg,node,write,render:render??(s=>`<p>${escape(s)}</p>`),onError};
  ctx.confine=relative=>confine(vaultDir,relative);
  ctx.look=look??createLook({invoke:invoke??(async()=>{throw new Error('Extraction target is unavailable');}),defaultTarget:cfg.extract_target});
  ctx.syncNow=()=>triggerSync(runNow);
  const jobs=new JobLedger(ctx),index=new ArchiveIndex(ctx),queue=new IngestQueue(ctx,jobs,queueOptions);Object.assign(ctx,{jobs,index,queue,onFile:p=>index.update(p)});
  let watcher,closed=false,mutation=Promise.resolve();
  const serial=fn=>{const task=mutation.then(fn,fn);mutation=task.catch(()=>{});return task;};
  ctx.convertHeic=async(relative)=>{
    const source=confine(vaultDir,relative);const sips=binary('sips'),heif=binary('heif-convert');if(!sips&&!heif)return relative;
    const parent=path.posix.dirname(relative),stem=path.posix.basename(relative,path.posix.extname(relative));let target=path.posix.join(parent,stem+'.jpg'),n=2;
    while(await fs.stat(confine(vaultDir,target)).catch(()=>null))target=path.posix.join(parent,`${stem} (${n++}).jpg`);
    try{if(sips)await run(sips,['-s','format','jpeg',source,'--out',confine(vaultDir,target)]);else await run(heif,[source,confine(vaultDir,target)]);await fs.unlink(source);return target;}catch{await fs.rm(confine(vaultDir,target),{force:true});return relative;}
  };
  const service={ctx,jobs,index,queue,ready:null,indexReady:null,handle,async close(){closed=true;queue.close();await watcher?.close();await queue.stopped();await mutation;await service.indexReady?.catch(()=>{});}};
  service.ready=(async()=>{
    if(!vaultDir)throw fail('no_vault',409);await fs.realpath(vaultDir);
    // Confine existing parents before creating the two lazy roots.
    await fs.mkdir(confine(vaultDir,'Archive'),{recursive:true});
    await fs.mkdir(confine(vaultDir,'Archive/Inbox'),{recursive:true});
    await fs.mkdir(confine(vaultDir,'Archive/.trash',{trash:true}),{recursive:true});
    await fs.mkdir(ctx.dataDir,{recursive:true});await jobs.load();
    const loaded=await index.load();
    service.indexReady=loaded?Promise.resolve():rebuild();
    service.indexReady.catch(onError);
    if(watch&&!closed){watcher=watchVault(ctx,index,queue);await watcher.ready;}
    if(ingest&&!closed)await queue.init();
    for(const row of jobs.list('queued').filter(j=>j.kind==='import-trello'))void runImport(row).catch(onError);
  })();service.ready.catch(()=>{});
  async function rebuild(){const row=await jobs.create('index-rebuild',{}, {done:0,total:1,label:'Indexing…'});await jobs.update(row,{state:'running',startedAt:now()});try{const count=await index.build();await jobs.update(row,{state:'done',endedAt:now(),progress:{done:count,total:count,label:'Index ready'}});}catch(error){await jobs.update(row,{state:'failed',endedAt:now(),error:error.message});throw error;}}
  async function trello(){const env=await credentials?.();if(!env?.TRELLO_KEY||!env?.TRELLO_TOKEN)throw fail('trello_not_connected',409);return clientFactory?clientFactory(env):new TrelloClient({key:env.TRELLO_KEY,token:env.TRELLO_TOKEN});}
  async function runImport(row){let client;try{client=await trello();}catch(e){if(!row.input.board)throw e;}return serial(()=>importBoard(ctx,jobs,row,{client}));}
  async function mutate(fn){return serial(async()=>{await service.indexReady;const result=await fn();await index.build();return result;});}
  const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
  async function handle(request,route){
    try{
      await service.ready;
      const url=new URL(request.url),method=request.method;route??=url.pathname.replace(/^\/api\/archive\/?/,'');route=route.replace(/^\/+|\/+$/g,'');
      if(method!=='GET'){const origin=request.headers.get('origin');if(origin&&new URL(origin).host!==(request.headers.get('host')??url.host))throw fail('Cross-origin authoring is not allowed',403);}
      if(url.searchParams.has('path'))confine(vaultDir,url.searchParams.get('path'));
      const body=async schema=>schema.parse(await request.json());
      const queryPath=()=>p.parse(url.searchParams.get('path'));
      const key=method+' '+route;
      switch(key){
        case 'GET status':{const roots=(await tree(ctx,'',0)).children.filter(c=>c.kind==='folder'&&c.name!=='Archive').map(c=>c.path);return json({vault:{path:vaultDir,name:path.basename(vaultDir)},node,areas:[{id:'yours',root:'Archive'},{id:'garrison',roots}],sync:await syncStatus(home),index:{state:index.state,docs:index.docs.size},ingest:queue.status(),jobs:{running:jobs.list('running').length}});}
        case 'GET tree':{const relative=url.searchParams.get('path')??'';const depth=z.coerce.number().int().min(0).max(20).parse(url.searchParams.get('depth')??2);return json(await tree(ctx,relative,depth));}
        case 'GET card':return json(await cardView(ctx,queryPath()));
        case 'POST card':return json(await mutate(()=>body(z.object({list:p,title,description:text.optional()}).strict()).then(b=>ops.createCard(ctx,b))));
        case 'PATCH card':{const b=await body(cardPatch);return json(await mutate(()=>ops.patchCard(ctx,b)));}
        case 'POST card/comment':{const b=await body(z.object({path:p,text:text.trim().min(1)}).strict());return json(await mutate(()=>ops.addComment(ctx,b)));}
        case 'DELETE card':{const b=await body(z.object({path:p}).strict());await cardView(ctx,b.path);return json(await mutate(()=>ops.trash(ctx,b.path)));}
        case 'POST card/reorder':{const b=await body(z.object({path:p,index:z.number().int().min(0)}).strict());return json(await mutate(async()=>{await reorderCard(ctx,b.path,b.index);return {ok:true};}));}
        case 'POST list':{const b=await body(z.object({title}).strict());return json(await mutate(()=>ops.createList(ctx,b.title)));}
        case 'PATCH list':{const b=await body(z.object({path:p,title:title.optional(),order:z.number().finite().optional()}).strict());return json(await mutate(()=>ops.patchList(ctx,b)));}
        case 'DELETE list':{const b=await body(z.object({path:p}).strict());ops.ownerPath(b.path);return json(await mutate(()=>ops.trash(ctx,b.path,{emptyList:true})));}
        case 'GET note':return json(await readNote(ctx,queryPath()));
        case 'PUT note':{const b=await body(z.object({path:p,markdown:text,baseSha:base}).strict());return json(await mutate(()=>writeNote(ctx,b)));}
        case 'POST note/move':{const b=await body(z.object({path:p,toFolder:z.string()}).strict());return json(await mutate(()=>ops.moveNote(ctx,b)));}
        case 'DELETE note':{const b=await body(z.object({path:p}).strict());const note=await readNote(ctx,b.path);assertNoteEditable(b.path,parseFrontmatter(note.markdown));return json(await mutate(()=>ops.trash(ctx,b.path)));}
        case 'POST folder':{const b=await body(z.object({parent:z.string(),name:title}).strict());return json(await mutate(()=>ops.createFolder(ctx,b.parent,b.name)));}
        case 'POST upload':{const form=await request.formData();const target=p.parse(form.get('target'));const values=form.getAll('files[]');if(!values.length)throw fail('Choose files',400);const files=[];for(const f of values){if(typeof f==='string')throw fail('Invalid file upload',400);if(f.size>cfg.max_file_mb*1024*1024)throw fail(`${f.name} is ${Math.round(f.size/1024/1024)} MB. The limit is ${cfg.max_file_mb} MB, so it was not added. Large files can be linked instead.`,413);files.push({name:f.name,bytes:Buffer.from(await f.arrayBuffer())});}const out=await mutate(()=>ops.upload(ctx,target,files));if(ingest)for(const f of out.files)await queue.enqueue(f.path);return json(out);}
        case 'POST inbox/file':{const b=await body(z.object({path:p,toCard:p.optional(),newCard:z.object({list:p,title}) .optional()}).strict().refine(b=>!!b.toCard!==!!b.newCard,'Choose one destination'));return json(await mutate(()=>ops.moveFile(ctx,b)));}
        case 'GET file':{const relative=queryPath();let file=confine(vaultDir,relative);const stat=await fs.stat(file);if(!stat.isFile())throw fail('File not found',404);let mime=mimeOf(relative);if(url.searchParams.get('thumb')==='1'&&mime.startsWith('image/')){try{file=await thumbnail(ctx,relative,sha(await fs.readFile(file)));if(file.endsWith('.jpg'))mime='image/jpeg';}catch{/* The original remains a usable fallback. */}}const headers={'content-type':mime,'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",'cache-control':'private, max-age=60'};if(mime==='application/octet-stream')headers['content-disposition']=`attachment; filename="${path.basename(relative).replace(/["\r\n]/g,'')}"`;return new Response(Readable.toWeb(createReadStream(file)),{headers});}
        case 'DELETE file':{const b=await body(z.object({path:p}).strict());if(b.path.endsWith('.md'))throw fail('Use note controls',400);ops.ownerPath(b.path);return json(await mutate(()=>ops.trash(ctx,b.path)));}
        case 'GET search':{const q=z.string().max(500).parse(url.searchParams.get('q')??'');const filters={};for(const name of ['area','list','kind','tag'])if(url.searchParams.has(name))filters[name]=url.searchParams.get(name);if(filters.area&&!['all','yours','garrison'].includes(filters.area))throw fail('Invalid area',400);if(filters.kind&&!['card','note','file'].includes(filters.kind))throw fail('Invalid kind',400);filters.limit=z.coerce.number().int().min(1).max(200).parse(url.searchParams.get('limit')??50);return json(index.query(q,filters));}
        case 'POST ingest/regenerate':{const b=await body(z.object({path:p}).strict());ops.ownerPath(b.path);confine(vaultDir,b.path);if(b.path.endsWith('.md'))throw fail('Markdown is not ingested',400);return json({jobId:await queue.enqueue(b.path,{force:true})});}
        case 'POST ingest/retry-failed':return json(await queue.retryFailed());
        case 'GET jobs':return json({jobs:jobs.list(url.searchParams.get('state')??undefined).map(({input,...row})=>row)});
        case 'POST index/rebuild':service.indexReady=rebuild();service.indexReady.catch(onError);return json({started:true});
        case 'GET trash':return json({entries:await ops.listTrash(ctx)});
        case 'POST trash/restore':{const b=await body(z.object({entry:p}).strict());return json(await mutate(()=>ops.restore(ctx,b.entry)));}
        case 'POST sync/now':return json(await ctx.syncNow());
        case 'POST import/trello/boards':{const client=await trello();const boards=await client.boards();return json({boards:await parallel(boards,4,async b=>{const preview=await client.preview(b.id,{maxFileMb:cfg.max_file_mb,includeComments:false});return {...b,lists:preview.counts.lists,cards:preview.counts.cards};})});}
        case 'POST import/trello/preview':{const b=await body(boardInput);const preview=await(await trello()).preview(b.boardId,{...b,maxFileMb:cfg.max_file_mb});return json(preview.counts);}
        case 'POST import/trello/run':{const b=await body(boardInput);await trello();const row=await jobs.create('import-trello',b);void runImport(row).catch(onError);return json({jobId:row.id});}
        case 'POST import/trello-json':{const form=await request.formData();const f=form.get('export.json');if(!f||typeof f==='string'||f.size>25*1024*1024)throw fail('Choose a Trello JSON export under 25 MB',400);const board=JSON.parse(await f.text());if(!Array.isArray(board.cards)||!Array.isArray(board.lists)||!board.id)throw fail('Invalid Trello board export',400);let client;try{client=await trello();}catch{}const input={board,includeArchived:form.get('includeArchived')==='true'};if(form.get('preview')==='true')return json({...mapBoard(board,{...input,maxFileMb:cfg.max_file_mb,credentials:!!client}).counts,credentials:!!client});const row=await jobs.create('import-trello',input);void runImport(row).catch(onError);return json({jobId:row.id});}
        case 'POST look':{if(!await authorizeInternal(request))throw fail('forbidden',403);const b=await body(z.object({imagePaths:z.array(p).min(1).max(4),prompt:text,schemaName:z.enum(['document','judge']),target:title.optional()}).strict());return json(await ctx.look({imagePaths:b.imagePaths.map(p=>confine(vaultDir,p)),prompt:b.prompt,schema:b.schemaName==='judge'?judgeSchema:documentSchema,target:b.target??cfg.extract_target}));}
      }
      const job=/^jobs\/([a-z0-9-]+)(\/cancel)?$/i.exec(route);if(job){if(method==='GET'&&!job[2]){const {input,...row}=jobs.get(job[1]);return json(row);}if(method==='POST'&&job[2])return json(await jobs.cancel(job[1]));}
      throw fail('Unknown Archive route or method',404);
    }catch(error){const status=error instanceof z.ZodError||error instanceof SyntaxError?400:error.status??(error.code==='ENOENT'?404:500);return json({error:status===400&&error instanceof z.ZodError?'Invalid request':error.message,...(error.current?{current:error.current}:{}),...(error instanceof z.ZodError?{details:error.issues}: {})},status);}
  }
  return service;
}

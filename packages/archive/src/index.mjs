import fs from 'node:fs/promises';
import path from 'node:path';
import MiniSearch from 'minisearch';
import { walkVault } from './tree.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { parseCard } from './card.mjs';
import { confine, areaOf } from './paths.mjs';
import { maybeRead } from './io.mjs';

export const fold = text => String(text).normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-PT');
export function tokenize(text) {
  const normalized=fold(text);const terms=normalized.match(/[\p{L}\p{N}]+(?:[\/-][\p{L}\p{N}]+)*/gu)??[];
  for(const m of normalized.matchAll(/\b(?:[a-z]{2}\s*)?\d[\da-z /-]{5,}\b/g))terms.push(m[0].replace(/\s/g,''));
  return terms;
}
const escape = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function snippet(body,query) {
  const terms=tokenize(query).sort((a,b)=>b.length-a.length);const normalized=fold(body);const positions=terms.map(t=>normalized.indexOf(t)).filter(n=>n>=0);const at=positions.length?Math.min(...positions):0;
  const start=Math.max(0,at-55);const text=String(body).slice(start,start+160);const plain=fold(text);const ranges=[];
  for(const term of terms){let i=plain.indexOf(term);while(i>=0){ranges.push([i,i+term.length]);i=plain.indexOf(term,i+term.length);}}
  ranges.sort((a,b)=>a[0]-b[0]);let output='',offset=0;
  for(const [a,b]of ranges){if(a<offset)continue;output+=escape(text.slice(offset,a))+'<mark>'+escape(text.slice(a,b))+'</mark>';offset=b;}
  return (start?'…':'')+output+escape(text.slice(offset))+(start+160<body.length?'…':'');
}
const options={idField:'path',fields:['title','tags','fields','body'],storeFields:['title','kind','area','list','updated','sensitive','attachment','tags'],tokenize,processTerm:fold,searchOptions:{boost:{title:4,tags:3,fields:2,body:1},prefix:true,fuzzy:(term)=>term.length>=5?0.15:false}};
export function fingerprint(files) {const md=files.filter(f=>f.path.endsWith('.md'));return {count:md.length,maxMtime:Math.max(0,...md.map(f=>f.mtime)),bytes:md.reduce((n,f)=>n+f.size,0)};}
async function readDocument(ctx,relative) {
  const raw=await maybeRead(confine(ctx.vaultDir,relative));if(raw===null)return null;
  const parsed=parseFrontmatter(raw,path.basename(relative,'.md'));return {raw,parsed};
}
export class ArchiveIndex {
  constructor(ctx){this.ctx=ctx;this.docs=new Map();this.engine=new MiniSearch(options);this.state='building';this.pending=Promise.resolve();}
  async cardDocument(relative) {
    const data=await readDocument(this.ctx,path.posix.join(relative,'index.md'));if(!data)return null;const card=parseCard(data.raw,path.posix.basename(relative));const side=[],attachmentSources=[];let attachment=null;
    for(const e of await fs.readdir(confine(this.ctx.vaultDir,relative),{withFileTypes:true})){if(!e.isFile()||e.name==='index.md'||!e.name.endsWith('.md')||e.name.startsWith('.'))continue;let d;try{d=await readDocument(this.ctx,path.posix.join(relative,e.name));}catch{continue;}if(d?.parsed.frontmatter.garrison==='derived'){side.push(d.parsed.body);attachmentSources.push({name:d.parsed.frontmatter.source,body:d.parsed.body});attachment??=d.parsed.frontmatter.source;}}
    const fields=[...card.details.map(f=>`${f.label}: ${f.value}`),...side.map(s=>s.split('## Fields')[1]??'')].join('\n');
    const body=[card.description,...card.links.map(l=>`${l.title} ${l.url}`),...card.checklists.flatMap(l=>[l.title,...l.items.map(i=>i.text)]),...card.comments.map(c=>c.markdown),...side].join('\n');
    return {path:relative,kind:'card',title:card.frontmatter.title,tags:card.frontmatter.tags??[],fields,body,area:areaOf(relative),list:path.posix.basename(path.posix.dirname(relative)),updated:card.frontmatter.updated??null,sensitive:card.frontmatter.sensitive===true,attachment,attachmentSources};
  }
  async fileDocument(relative){
    const file=confine(this.ctx.vaultDir,relative);const stat=await fs.stat(file).catch(()=>null);if(!stat?.isFile())return null;
    const side=await readDocument(this.ctx,relative+'.md');const body=side?.parsed.frontmatter.garrison==='derived'?side.parsed.body:'';
    return {path:relative,kind:'file',title:path.posix.basename(relative),tags:[],fields:body.split('## Fields')[1]??'',body,area:areaOf(relative),list:path.posix.basename(path.posix.dirname(relative)),updated:stat.mtime.toISOString(),sensitive:false};
  }
  async noteDocument(relative){const d=await readDocument(this.ctx,relative);if(!d||d.parsed.frontmatter.garrison==='derived'||(areaOf(relative)==='yours'&&['_list.md','index.md'].includes(path.posix.basename(relative))))return null;return {path:relative,kind:'note',title:d.parsed.frontmatter.title??path.posix.basename(relative,'.md'),tags:d.parsed.frontmatter.tags??[],fields:'',body:d.parsed.body+'\n'+Object.values(d.parsed.frontmatter).flat().join(' '),area:areaOf(relative),list:null,updated:(await fs.stat(confine(this.ctx.vaultDir,relative))).mtime.toISOString(),sensitive:false};}
  set(doc){if(!doc)return; if(this.docs.has(doc.path))this.engine.discard(doc.path);this.docs.set(doc.path,doc);this.engine.add(doc);}
  remove(relative){for(const key of [...this.docs.keys()])if(!relative||key===relative||key.startsWith(relative+'/')){this.engine.discard(key);this.docs.delete(key);}}
  exclusive(fn){const task=this.pending.then(fn,fn);this.pending=task.catch(()=>{});return task;}
  build(){return this.exclusive(()=>this.buildNow());}
  async buildNow(){
    this.state='building';const files=await walkVault(this.ctx);this.engine=new MiniSearch(options);this.docs.clear();
    await this.addFiles(files);
    this.state='ready';await this.persist(fingerprint(files));return this.docs.size;
  }
  async addFiles(files){
    const cards=new Set(files.filter(f=>f.name==='index.md'&&areaOf(f.path)==='yours').map(f=>path.posix.dirname(f.path)));
    const work=[...cards].map(p=>()=>this.cardDocument(p));
    for(const f of files){if(areaOf(f.path)==='yours'&&(f.name==='index.md'||f.name==='_list.md'))continue;const parent=path.posix.dirname(f.path);if(cards.has(parent))continue;if(f.path.endsWith('.md'))work.push(()=>this.noteDocument(f.path));else if(areaOf(f.path)==='yours')work.push(()=>this.fileDocument(f.path));}
    let cursor=0;await Promise.all(Array.from({length:Math.min(24,work.length)},async()=>{while(cursor<work.length){const task=work[cursor++];this.set(await task());}}));
  }
  async load(){const files=await walkVault(this.ctx);const stamp=fingerprint(files);try{const meta=JSON.parse(await fs.readFile(path.join(this.ctx.dataDir,'index.meta.json'),'utf8'));if(JSON.stringify(meta)!==JSON.stringify(stamp))return false;const stored=JSON.parse(await fs.readFile(path.join(this.ctx.dataDir,'index.json'),'utf8'));this.engine=MiniSearch.loadJSON(JSON.stringify(stored.index),options);this.docs=new Map(stored.docs.map(d=>[d.path,d]));this.state='ready';return true;}catch{return false;}}
  update(relative){return this.updateMany([relative]);}
  updateMany(relatives){return this.exclusive(()=>this.updateManyNow(relatives));}
  async updateTarget(relative){
    const stat=await fs.stat(confine(this.ctx.vaultDir,relative)).catch(()=>null);
    let parent=stat?.isDirectory()||this.docs.get(relative)?.kind==='card'?relative:path.posix.dirname(relative);
    while(parent&&parent!=='.'){
      if(areaOf(parent)==='yours'&&(this.docs.get(parent)?.kind==='card'||await maybeRead(confine(this.ctx.vaultDir,parent+'/index.md'))!==null))return {path:parent,kind:'card'};
      parent=path.posix.dirname(parent);
    }
    return {path:relative,kind:stat?.isDirectory()?'folder':'leaf'};
  }
  async updateManyNow(relatives){
    const targets=new Map();
    for(const relative of new Set(relatives)){
      if(relative.split('/').some(s=>s.startsWith('.')))continue;
      const target=await this.updateTarget(relative);targets.set(target.path,target);
    }
    const folders=[...targets.values()].filter(t=>t.kind==='folder').map(t=>t.path);
    for(const target of targets.values()){
      const relative=target.path;
      // A folder event already covers its descendants. Scan only that subtree;
      // imported card folders never rebuild the rest of the vault.
      if(folders.some(p=>p!==relative&&(!p||relative.startsWith(p+'/'))))continue;
      this.remove(relative);
      if(target.kind==='card')this.set(await this.cardDocument(relative));
      else if(target.kind==='folder')await this.addFiles(await walkVault(this.ctx,relative));
      else if(relative.endsWith('.md')){
        const d=await readDocument(this.ctx,relative);
        if(d?.parsed.frontmatter.garrison==='derived'){
          const source=relative.slice(0,-3);this.remove(source);this.set(await this.fileDocument(source));
        }else this.set(await this.noteDocument(relative));
      }else if(areaOf(relative)==='yours')this.set(await this.fileDocument(relative));
    }
    if(targets.size)await this.persist();
  }
  async persist(stamp){await this.ctx.write(path.join(this.ctx.dataDir,'index.json'),JSON.stringify({index:this.engine.toJSON(),docs:[...this.docs.values()]}));if(stamp)await this.ctx.write(path.join(this.ctx.dataDir,'index.meta.json'),JSON.stringify(stamp));}
  query(q,{area,list,kind,tag,limit=50}={}){
    const started=performance.now();if(!q?.trim())return {hits:[],total:0,tookMs:0};
    const results=this.engine.search(q,{filter:r=>(!area||area==='all'||r.area===area)&&(!list||r.list===list)&&(!kind||r.kind===kind)&&(!tag||r.tags?.includes(tag))});
    const hits=results.slice(0,limit).map(r=>{const d=this.docs.get(r.id),terms=tokenize(q),body=d.body+' '+d.fields,matching=(d.attachmentSources??[]).map(a=>({...a,matches:terms.filter(t=>fold(a.body).includes(t)).length})).sort((a,b)=>b.matches-a.matches)[0];const attachment=matching?.matches?matching.name:null;return {path:d.path,kind:d.kind,title:d.title,area:d.area,list:d.list,snippet:d.sensitive?'Sensitive card, open to view':snippet(terms.some(t=>fold(body).includes(t))?body:d.title+' '+body,q),score:r.score,updated:d.updated,sensitive:d.sensitive,...(attachment?{attachment}:{})};});
    return {hits,total:results.length,tookMs:Math.round((performance.now()-started)*100)/100,tags:[...new Set(results.filter(r=>Object.values(r.match??{}).some(fields=>fields.includes('tags'))).flatMap(r=>r.tags??[]))]};
  }
}

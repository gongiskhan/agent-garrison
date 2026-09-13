import fs from 'node:fs/promises';
import path from 'node:path';
import MiniSearch from 'minisearch';
import { walkVault } from './tree.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { parseCard } from './card.mjs';
import { confine, areaOf } from './paths.mjs';
import { maybeRead } from './io.mjs';
import {BOOKMARKS_PATH} from './saved.mjs';

export const fold = text => String(text).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
export function tokenize(text) {
  const normalized=fold(text);const terms=normalized.match(/[\p{L}\p{N}]+(?:[\/-][\p{L}\p{N}]+)*/gu)??[];
  for(const m of normalized.matchAll(/\b(?:[a-z]{2}\s*)?\d[\da-z /-]{5,}\b/g))terms.push(m[0].replace(/\s/g,''));
  return terms;
}
const escape = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
// Search offsets in the original text, so composed/decomposed Portuguese
// accents highlight correctly without normalizing megabytes for every snippet.
const variants=new Map();
for(let code=192;code<8192;code++){
  const char=String.fromCodePoint(code),base=fold(char);
  if(base.length===1&&base!==char){const group=variants.get(base)??new Set([base]);group.add(char);variants.set(base,group);}
}
const regexEscape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function termPattern(term){
  const separator=/\d/.test(term)?'[\\s/-]*':'';
  return [...term].map(c=>{
    const chars=variants.get(c);
    return (chars?'['+[...chars].map(regexEscape).join('')+']':regexEscape(c))+'\\p{M}*';
  }).join(separator);
}
function textMatcher(query){const terms=[...new Set(tokenize(query))].sort((a,b)=>b.length-a.length);return new RegExp(terms.map(termPattern).join('|')||'(?!)','iu');}
export function snippet(body,query) {
  const matcher=textMatcher(query),at=matcher.exec(body)?.index??0;
  const start=Math.max(0,at-55),text=String(body).slice(start,start+160);
  let output='',offset=0;
  for(const match of text.matchAll(new RegExp(matcher.source,'giu'))){
    output+=escape(text.slice(offset,match.index))+'<mark>'+escape(match[0])+'</mark>';offset=match.index+match[0].length;
  }
  return (start?'…':'')+output+escape(text.slice(offset))+(start+160<body.length?'…':'');
}
const options={idField:'path',fields:['title','tags','fields','body'],storeFields:['title','kind','area','list','updated','sensitive','attachment','tags'],tokenize,processTerm:fold,searchOptions:{boost:{title:4,tags:3,fields:2,body:1},prefix:true,fuzzy:(term)=>term.length>=5&&!/\d/.test(term)?0.15:false}};
export function fingerprint(files) {const md=files.filter(f=>f.path.endsWith('.md'));return {count:md.length,maxMtime:Math.max(0,...md.map(f=>f.mtime)),bytes:md.reduce((n,f)=>n+f.size,0)};}
async function readDocument(ctx,relative) {
  const raw=await maybeRead(confine(ctx.vaultDir,relative));if(raw===null)return null;
  const parsed=parseFrontmatter(raw,path.basename(relative,'.md'));return {raw,parsed};
}
export class ArchiveIndex {
  constructor(ctx){this.ctx=ctx;this.docs=new Map();this.files=new Map();this.engine=new MiniSearch(options);this.state='building';this.pending=Promise.resolve();this.revision=0;}
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
  async noteDocument(relative){const d=await readDocument(this.ctx,relative);if(!d||(relative===BOOKMARKS_PATH&&d.parsed.frontmatter.garrison==='bookmarks')||d.parsed.frontmatter.garrison==='derived'||(path.posix.basename(relative)==='_list.md'&&d.parsed.frontmatter.garrison==='list')||(areaOf(relative)==='yours'&&['_list.md','index.md'].includes(path.posix.basename(relative))))return null;return {path:relative,kind:d.parsed.frontmatter.garrison==='bookmark'?'bookmark':'note',title:d.parsed.frontmatter.title??path.posix.basename(relative,'.md'),tags:d.parsed.frontmatter.tags??[],fields:'',body:d.parsed.body+'\n'+Object.values(d.parsed.frontmatter).flat().join(' '),area:areaOf(relative),list:null,updated:(await fs.stat(confine(this.ctx.vaultDir,relative))).mtime.toISOString(),sensitive:false};}
  set(doc){if(!doc)return; if(this.docs.has(doc.path))this.engine.discard(doc.path);this.docs.set(doc.path,doc);this.engine.add(doc);this.revision++;}
  remove(relative){for(const key of [...this.docs.keys()])if(!relative||key===relative||key.startsWith(relative+'/')){this.engine.discard(key);this.docs.delete(key);this.revision++;}}
  folderStats(){
    if(this.statsRevision===this.revision)return this.stats;
    const stats=new Map();
    for(const d of this.docs.values())for(let parent=path.posix.dirname(d.path);parent&&parent!=='.';parent=path.posix.dirname(parent)){
      const row=stats.get(parent)??{notes:0,documents:0,items:0,updated:null};
      row.items++;if(d.kind==='note')row.notes++;if(d.kind==='card')row.documents++;
      if(d.updated&&(!row.updated||Date.parse(d.updated)>Date.parse(row.updated)))row.updated=d.updated;
      stats.set(parent,row);
    }
    this.statsRevision=this.revision;this.stats=stats;return stats;
  }
  exclusive(fn){const task=this.pending.then(fn,fn);this.pending=task.catch(()=>{});return task;}
  build(){return this.exclusive(()=>this.buildNow());}
  async buildNow(){
    this.state='building';const files=await walkVault(this.ctx);this.files=new Map(files.map(f=>[f.path,f]));this.engine=new MiniSearch(options);this.docs.clear();this.revision++;
    await this.addFiles(files);
    this.state='ready';await this.persist(fingerprint(files));return this.docs.size;
  }
  async addFiles(files){
    const cards=new Set(files.filter(f=>f.name==='index.md'&&areaOf(f.path)==='yours').map(f=>path.posix.dirname(f.path)));
    const work=[...cards].map(p=>()=>this.cardDocument(p));
    for(const f of files){if(areaOf(f.path)==='yours'&&(f.name==='index.md'||f.name==='_list.md'))continue;const parent=path.posix.dirname(f.path);if(cards.has(parent))continue;if(f.path.endsWith('.md'))work.push(()=>this.noteDocument(f.path));else if(areaOf(f.path)==='yours')work.push(()=>this.fileDocument(f.path));}
    let cursor=0;await Promise.all(Array.from({length:Math.min(24,work.length)},async()=>{while(cursor<work.length){const task=work[cursor++];try{this.set(await task());}catch(error){if(error.code!=='ENOENT')throw error;}}}));
  }
  async load(){const files=await walkVault(this.ctx);this.files=new Map(files.map(f=>[f.path,f]));const stamp=fingerprint(files);try{const meta=JSON.parse(await fs.readFile(path.join(this.ctx.dataDir,'index.meta.json'),'utf8'));if(JSON.stringify(meta)!==JSON.stringify(stamp))return false;const stored=JSON.parse(await fs.readFile(path.join(this.ctx.dataDir,'index.json'),'utf8'));this.engine=await MiniSearch.loadJSAsync(stored.index,options);this.docs=new Map(stored.docs.map(d=>[d.path,d]));this.revision++;this.state='ready';return true;}catch{return false;}}
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
  async refreshFingerprint(relative){
    for(const p of this.files.keys())if(!relative||p===relative||p.startsWith(relative+'/'))this.files.delete(p);
    const stat=await fs.stat(confine(this.ctx.vaultDir,relative)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!stat)return;
    if(stat.isDirectory())for(const row of await walkVault(this.ctx,relative))this.files.set(row.path,row);
    else if(stat.isFile())this.files.set(relative,{path:relative,size:stat.size,mtime:stat.mtimeMs});
  }
  async updateManyNow(relatives){
    const targets=new Map(),beforeRevision=this.revision;
    for(const relative of new Set(relatives)){
      if(relative.split('/').some(s=>s.startsWith('.')))continue;
      if(relative===BOOKMARKS_PATH&&(await readDocument(this.ctx,relative))?.parsed.frontmatter.garrison==='bookmarks'){this.remove(relative);this.files.delete(relative);continue;}
      const target=await this.updateTarget(relative);targets.set(target.path,target);
    }
    const folders=[...targets.values()].filter(t=>t.kind==='folder').map(t=>t.path);
    for(const target of targets.values()){
      const relative=target.path;
      // A folder event already covers its descendants. Scan only that subtree;
      // imported card folders never rebuild the rest of the vault.
      if(folders.some(p=>p!==relative&&(!p||relative.startsWith(p+'/'))))continue;
      await this.refreshFingerprint(relative);
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
    if(targets.size||this.revision!==beforeRevision)await this.persist(fingerprint([...this.files.values()]));
  }
  async persist(stamp){await this.ctx.write(path.join(this.ctx.dataDir,'index.json'),JSON.stringify({index:this.engine.toJSON(),docs:[...this.docs.values()]}));if(stamp)await this.ctx.write(path.join(this.ctx.dataDir,'index.meta.json'),JSON.stringify(stamp));}
  query(q,{area,list,kind,tag,folder,paths,limit=50}={}){
    const started=performance.now();if(!q?.trim())return {hits:[],total:0,tookMs:0};
    const results=this.engine.search(q,{filter:r=>(!area||area==='all'||r.area===area)&&(!list||r.list===list)&&(!kind||r.kind===kind)&&(!tag||r.tags?.includes(tag))&&(!folder||r.id.startsWith(folder+'/')||r.id===folder)&&(!paths||paths.has(r.id))});
    const terms=tokenize(q),matchers=terms.map(t=>textMatcher(t));
    const hits=results.slice(0,limit).map(r=>{
      const d=this.docs.get(r.id);
      const matching=(d.attachmentSources??[]).map(a=>({name:a.name,matches:matchers.filter(m=>m.test(a.body)).length})).sort((a,b)=>b.matches-a.matches)[0];
      const attachment=matching?.matches?matching.name:null;
      const fields=Object.values(r.match??{}).flat();
      // Title/tag-only matches use a short excerpt, never a whole-body scan.
      const body=fields.includes('body')||fields.includes('fields')?d.body+' '+d.fields:d.title+' '+[].concat(d.tags??[]).join(' ')+' '+d.body.slice(0,160);
      return {path:d.path,kind:d.kind,title:d.title,area:d.area,list:d.list,snippet:d.sensitive?'Sensitive card, open to view':snippet(body,q),score:r.score,updated:d.updated,sensitive:d.sensitive,...(attachment?{attachment}:{})};
    });
    return {hits,total:results.length,tookMs:Math.round((performance.now()-started)*100)/100,tags:[...new Set(results.filter(r=>Object.values(r.match??{}).some(fields=>fields.includes('tags'))).flatMap(r=>r.tags??[]))]};
  }
}

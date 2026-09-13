"use client";
import React,{useEffect,useState} from 'react';
import Link from 'next/link';
import {Search,FileText,Paperclip,LayoutGrid} from 'lucide-react';
import {useRouter,useSearchParams} from 'next/navigation';
import {ARCHIVE_LABEL,useData,route,noteRoute,relativeTime,Skeleton,ErrorMessage} from './common';
import {BookmarkButton} from './bookmarks';
import {replaceArchiveUrl} from './navigation';
export function hitUrl(hit:any){if(hit.kind==='card')return route('card',hit.path,hit.attachment?'&attachment='+encodeURIComponent(hit.attachment):'');if(hit.kind==='file')return '/api/archive/file?path='+encodeURIComponent(hit.path);return noteRoute(hit.path);}
export function SearchResults({query}:{query:string}){
 const params=useSearchParams(),kind=params.get('kind')??'',tag=params.get('tag')??'',folder=params.get('folder')??'',bookmarked=params.get('bookmarked')==='1';
 const [debounced,setDebounced]=useState(query);
 useEffect(()=>{const timer=setTimeout(()=>setDebounced(query),150);return()=>clearTimeout(timer);},[query]);
 const filter=(name:string,value:string)=>{const url=new URL(location.href);url.searchParams.delete('area');if(value)url.searchParams.set(name,value);else url.searchParams.delete(name);replaceArchiveUrl(url);};
 const roots=useData('tree?depth=0&path=&unified=1');
 const result=useData(debounced.trim().length>=2?'search?'+new URLSearchParams({q:debounced,area:'all',...(kind?{kind}:{}),...(tag?{tag}:{}),...(folder?{folder}:{}),...(bookmarked?{bookmarked:'1'}:{})}):null);
 const router=useRouter();
 useEffect(()=>{window.addEventListener('archive:changed',result.refresh);return()=>window.removeEventListener('archive:changed',result.refresh);},[result.refresh]);
 useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Enter'&&result.data?.hits?.[0]&&!(e.target instanceof HTMLButtonElement))router.push(hitUrl(result.data.hits[0]));};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[result.data,router]);
 return <section className="archive-search-results" aria-label="Search results">
  <div className="archive-filter-row" aria-label="Search filters"><label><span>Folder</span><select aria-label="Search folder" value={folder} onChange={e=>filter('folder',e.target.value)}><option value="">All folders</option>{roots.data?.children.filter((r:any)=>['list','folder'].includes(r.kind)).map((r:any)=><option key={r.path} value={r.path}>{r.title}</option>)}</select></label><button className={'archive-chip '+(bookmarked?'selected':'')} aria-pressed={bookmarked} onClick={()=>filter('bookmarked',bookmarked?'':'1')}>Bookmarked</button></div>
  <div className="archive-filter-row" aria-label="Kind filters">{[['card','Documents'],['note','Notes'],['file','Files']].map(([value,label])=><button className={'archive-chip '+(kind===value?'selected':'')} aria-pressed={kind===value} key={value} onClick={()=>filter('kind',kind===value?'':value)}>{label}</button>)}{result.data?.tags?.map((t:string)=><button key={t} className={'archive-chip '+(tag===t?'selected':'')} onClick={()=>filter('tag',tag===t?'':t)}>#{t}</button>)}</div>
  <ErrorMessage error={result.error} onRetry={result.refresh}/>{!result.data&&!result.error?<Skeleton/>:!result.data?null:<><p className="archive-result-count">{result.data.total} results <span>{result.data.tookMs} ms</span></p><div className="archive-result-list">{result.data.hits.map((hit:any)=><div key={hit.path} className="archive-result-row"><Link href={hitUrl(hit)} className="archive-result">{hit.kind==='card'?<LayoutGrid size={20}/>:hit.kind==='file'?<Paperclip size={20}/>:<FileText size={20}/>}<div><strong>{hit.title}</strong><div className="archive-result-meta">{hit.path.split('/').slice(0,-1).filter((p:string,i:number)=>i!==0||p!=='Archive').join(' / ')||'All documents'}</div><p dangerouslySetInnerHTML={{__html:hit.snippet}}/><small>{relativeTime(hit.updated)}</small></div></Link>{hit.kind!=='file'&&<BookmarkButton path={hit.path} title={hit.title}/>}</div>)}</div>{!result.data.hits.length&&<p className="archive-empty">No matches. Try a title, a tag or a number.</p>}</>}
 </section>;
}
export function SearchField({value,onChange}:{value:string;onChange:(value:string)=>void}){return <label className="archive-search"><Search size={21}/><input type="search" placeholder={'Search the '+ARCHIVE_LABEL} aria-label={'Search the '+ARCHIVE_LABEL} value={value} onChange={e=>onChange(e.target.value)} autoComplete="off"/></label>;}

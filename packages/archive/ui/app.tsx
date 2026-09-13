"use client";
import React,{useEffect,useState} from 'react';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {Bookmark,Trash2,Download,Activity} from 'lucide-react';
import {ArchiveBack} from './navigation';
import {ARCHIVE_LABEL} from '../label.mjs';
import {api,useData,relativeTime,Skeleton,ErrorMessage,UiBridge,Breadcrumb} from './common';
import {SearchField,SearchResults} from './search';
import {FolderBrowser,DisplayControls} from './browser';
import {CardPage as DocumentPage} from './card';
import {NotesPage} from './notes';
import {Import} from './import';
import {Jobs,Trash} from './jobs';

function Status({status,refresh}:{status:any;refresh:()=>void}){
 const [error,setError]=useState<any>();if(!status)return <Skeleton/>;const sync=status.sync,queue=status.ingest;
 return <><div className="archive-status"><Link href="/archive/jobs">{status.node} · {sync.lastSyncAt?(sync.ok?'synced '+relativeTime(sync.lastSyncAt):'sync failed, tap for details'):'never synced'}</Link><button onClick={()=>void api('sync/now','POST').then(refresh).catch(setError)}>Sync now</button>{queue.pending>0&&<Link href="/archive/jobs" className="archive-processing">{queue.pending} processing</Link>}{queue.failed>0&&<Link href="/archive/jobs" className="archive-error">{queue.failed} failed</Link>}{queue.pausedUntil&&<Link href="/archive/jobs">Ingestion paused (hourly limit), resumes at {new Date(queue.pausedUntil).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</Link>}{status.index.state==='building'&&<span>Indexing…</span>}</div><ErrorMessage error={error}/></>;
}
function Home({status,refreshStatus}:{status:any;refreshStatus:()=>void}){
 const params=useSearchParams(),[query,setQuery]=useState(params.get('q')??''),[debounced,setDebounced]=useState(query);
 useEffect(()=>setQuery(params.get('q')??''),[params]);
 useEffect(()=>{const timer=setTimeout(()=>setDebounced(query),150);return()=>clearTimeout(timer);},[query]);
 const change=(value:string)=>{setQuery(value);const url=new URL(location.href);url.searchParams.delete('tag');if(value)url.searchParams.set('q',value);else url.searchParams.delete('q');history.replaceState(history.state,'',url);};
 return <><SearchField value={query} onChange={change}/><Status status={status} refresh={refreshStatus}/>{debounced.trim().length>=2?<SearchResults query={debounced}/>:<><DisplayControls/><div className="archive-library-home"><section className="archive-yours"><h2>Yours</h2><FolderBrowser path="Archive" controls={false}/></section><section className="archive-garrison"><h2>Garrison</h2><FolderBrowser path="" excludeArchive controls={false}/></section></div></>}</>;
}
export function ArchiveApp({view='home',bridge}:{view?:string;bridge:any}){
 const params=useSearchParams(),p=params.get('path')??'',status=useData('status',3000);
 useEffect(()=>{if(status.data?.index.state==='ready')window.dispatchEvent(new Event('archive:changed'));},[status.data?.index.state]);
 const parent=view==='notes'&&p.includes('/')?'/archive/notes?path='+encodeURIComponent(p.split('/').slice(0,-1).join('/')):'/archive';
 return <UiBridge value={bridge}><main className="archive-app"><header className="archive-toolbar"><Link href="/archive" className="archive-brand"><span>{ARCHIVE_LABEL}</span></Link><nav aria-label={ARCHIVE_LABEL+' tools'}><Link href="/archive/bookmarks" aria-label="Bookmarks" title="Bookmarks"><Bookmark size={20}/></Link><Link href="/archive/import" aria-label="Import" title="Import"><Download size={20}/></Link><Link href="/archive/trash" aria-label="Trash" title="Trash"><Trash2 size={20}/></Link><Link href="/archive/jobs" aria-label="Jobs" title="Jobs"><Activity size={20}/></Link></nav></header>{view!=='home'&&view!=='card'&&<ArchiveBack fallback={parent}/>}
 {status.error?.error==='no_vault'?<section className="archive-empty-state"><h1>No vault yet</h1><p>{ARCHIVE_LABEL} shows the Basic Memory vault. Station basic-memory in the composition to set one up.</p><Link className="btn primary" href="/compose">Open composition</Link></section>:status.error&&!status.data?<ErrorMessage error={status.error} onRetry={status.refresh}/>:!status.data?<Skeleton/>:view==='home'?<Home status={status.data} refreshStatus={status.refresh}/>:view==='board'?<><Breadcrumb path={p||'Archive'}/><FolderBrowser path={p||'Archive'} heading/></>:view==='card'?<DocumentPage key={p} path={p}/>:view==='notes'?<NotesPage key={p} path={p} vaultName={status.data.vault.name}/>:view==='bookmarks'?<FolderBrowser path="Archive/Bookmarks" bookmarks heading/>:view==='import'?<Import/>:view==='jobs'?<Jobs id={params.get('id')??undefined}/>:view==='trash'?<Trash/>:view==='search'?<SearchPage initial={params.get('q')??''}/>:null}
 </main></UiBridge>;
}
function SearchPage({initial}:{initial:string}){const [query,setQuery]=useState(initial);useEffect(()=>setQuery(initial),[initial]);const change=(value:string)=>{setQuery(value);const url=new URL(location.href);url.searchParams.set('q',value);url.searchParams.delete('tag');history.replaceState(history.state,'',url);};return <><SearchField value={query} onChange={change}/>{query.length>=2&&<SearchResults query={query}/>}</>;}

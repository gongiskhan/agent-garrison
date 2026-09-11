"use client";
import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {registerArchiveNavigationGuard} from './navigation';
export {ARCHIVE_LABEL} from '../label.mjs';
import dynamic from 'next/dynamic';
import {ChevronRight,Folder,FileText,X} from 'lucide-react';
const Monaco=dynamic(async()=>{const module=await import('@monaco-editor/react');module.loader.config({paths:{vs:'/archive/editor-assets'}});return module.default;},{ssr:false,loading:()=> <Skeleton/>});
export const fileUrl=(p:string,thumb=false)=>`/api/archive/file?path=${encodeURIComponent(p)}${thumb?'&thumb=1':''}`;
export const route=(kind:string,p:string,extra='')=>`/archive/${kind}?path=${encodeURIComponent(p)}${extra}`;
export const noteRoute=(p:string)=>route('notes',p);
export function relativeTime(value:string|null){if(!value)return 'never';const ms=Math.max(0,Date.now()-Date.parse(value));return ms<60000?'just now':ms<3600000?`${Math.floor(ms/60000)} min ago`:ms<86400000?`${Math.floor(ms/3600000)} hr ago`:`${Math.floor(ms/86400000)} days ago`;}
export const sizeOf=(n:number)=>n<1024*1024?`${Math.round(n/1024)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
export async function api(url:string,method='GET',body?:unknown,signal?:AbortSignal){const res=await fetch('/api/archive/'+url,{method,signal,cache:'no-store',...(body!==undefined?{headers:body instanceof FormData?{}:{'content-type':'application/json'},body:body instanceof FormData?body:JSON.stringify(body)}:{})});const out=await res.json();if(!res.ok)throw Object.assign(new Error(out.error),{status:res.status,...out});return out;}
export function useData(url:string|null,poll=0){const [data,setData]=useState<any>(null),[error,setError]=useState<any>(null),[loadedUrl,setLoadedUrl]=useState<string|null>(null),[version,setVersion]=useState(0);const latest=useRef(url);latest.current=url;
 const refresh=()=>setVersion(v=>v+1);
 useEffect(()=>{
  if(!url)return;
  let live=false,abort:AbortController,timer:ReturnType<typeof setInterval>|undefined;
  const start=()=>{
   if(live)return;
   live=true;abort=new AbortController();const signal=abort.signal;
   const load=()=>api(url,'GET',undefined,signal).then(out=>{if(live&&!signal.aborted){setData(out);setLoadedUrl(url);setError(null);}}).catch(e=>{if(live&&!signal.aborted)setError(e);});
   void load();if(poll)timer=setInterval(load,poll);
  };
  // A full navigation can suspend the document without unmounting React.
  const stop=()=>{live=false;abort?.abort();if(timer)clearInterval(timer);timer=undefined;};
  const restore=(event:PageTransitionEvent)=>{if(event.persisted)start();};
  start();window.addEventListener('pagehide',stop);window.addEventListener('pageshow',restore);
  return()=>{stop();window.removeEventListener('pagehide',stop);window.removeEventListener('pageshow',restore);};
 },[url,poll,version]);
 useEffect(()=>{setData(null);setError(null);},[url]);return {data:loadedUrl===url?data:null,error,refresh,setData};
}
export function usePhone(){const [phone,setPhone]=useState(true);useEffect(()=>{const media=matchMedia('(max-width: 759px)');const update=()=>setPhone(media.matches);update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);return phone;}
export function Skeleton(){return <div className="archive-skeleton" aria-label="Loading"><i/><i/><i/></div>;}
export function ErrorMessage({error}:{error:any}){return error?<p className="archive-error" role="alert">{error.message??String(error)}</p>:null;}
type Bridge={Drawer:React.ComponentType<any>;Confirm:React.ComponentType<any>;render:(s:string)=>string};
const BridgeContext=createContext<Bridge>(null as any);
export function UiBridge({value,children}:{value:Bridge;children:React.ReactNode}){return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;}
export const useBridge=()=>useContext(BridgeContext);
export function Markdown({text,html}:{text?:string;html?:string}){const {render}=useBridge();return <div className="markdown-body archive-markdown" dangerouslySetInnerHTML={{__html:html??render(text??'')}}/>;}
export function Sheet({title,children,onClose,footer}:{title:string;children:React.ReactNode;onClose:()=>void;footer?:React.ReactNode}){const {Drawer}=useBridge();return <div className="archive-overlay"><Drawer title={title} onClose={onClose} footer={footer} testId="archive-sheet">{children}</Drawer></div>;}
export function Confirm({title,body,onConfirm,onClose}:{title:string;body:string;onConfirm:()=>Promise<void>;onClose:()=>void}){const {Confirm:Dialog}=useBridge();return <div className="archive-overlay"><Dialog title={title} body={body} confirmLabel="Move to trash" onConfirm={onConfirm} onClose={onClose}/></div>;}
export function Prompt({title,label,initial='',onSubmit,onClose,multiline=false,allowEmpty=false}:{title:string;label:string;initial?:string;onSubmit:(value:string)=>Promise<void>;onClose:()=>void;multiline?:boolean;allowEmpty?:boolean}){const [value,setValue]=useState(initial),[error,setError]=useState<any>(null),[busy,setBusy]=useState(false);const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);try{await onSubmit(value);onClose();}catch(e){setError(e);setBusy(false);}};return <Sheet title={title} onClose={onClose}><form onSubmit={submit} className="archive-form"><label>{label}{multiline?<textarea value={value} onChange={e=>setValue(e.target.value)} autoFocus/>:<input value={value} onChange={e=>setValue(e.target.value)} autoFocus required={!allowEmpty}/>}</label><ErrorMessage error={error}/><div className="archive-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy||(!allowEmpty&&!value.trim())}>Continue</button></div></form></Sheet>;}
export function Breadcrumb({path:p}:{path:string}){const parts=p.split('/').filter(Boolean),yours=parts[0]==='Archive';return <nav className="archive-breadcrumb" aria-label="Breadcrumb"><Link href="/archive">{yours?'Yours':'Garrison'}</Link>{parts.map((part,i)=>part==='Archive'?null:<React.Fragment key={i}><ChevronRight size={13}/><Link href={noteRoute(parts.slice(0,i+1).join('/'))}>{part.replace(/\.md$/,'')}</Link></React.Fragment>)}</nav>;}
export function FolderRows({rows,onPick}:{rows:any[];onPick?:(p:string)=>void}){return <div className="archive-folder-rows">{rows.map(row=><Link className="archive-folder-row" href={row.kind==='card'?route('card',row.path):row.kind==='file'?fileUrl(row.path):noteRoute(row.path)} key={row.path} onClick={onPick?e=>{e.preventDefault();onPick(row.path);}:undefined}>{row.kind==='note'?<FileText size={19}/>:<Folder size={19}/>}<span><strong>{row.title}</strong><small>{row.kind==='note'?relativeTime(row.updated):`${row.counts?.notes??0} notes`}</small></span>{row.provenance&&<em>{row.provenance}</em>}<ChevronRight size={16}/></Link>)}</div>;}
export function Editor({value,onChange,label='Markdown editor'}:{value:string;onChange:(s:string)=>void;label?:string}){const phone=usePhone();return phone?<textarea className="archive-editor" aria-label={label} value={value} onChange={e=>onChange(e.target.value)}/>:<div className="archive-monaco" data-testid="archive-monaco"><Monaco height="340px" language="markdown" value={value} onChange={v=>onChange(v??'')} options={{wordWrap:'on',minimap:{enabled:false},fontSize:15,scrollBeyondLastLine:false,automaticLayout:true,ariaLabel:label}}/></div>;}
export function useUnsaved(dirty:boolean){useEffect(()=>{
 if(!dirty)return;
 const url=location.href,state=history.state;
 const unload=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};
 const click=(e:MouseEvent)=>{const link=(e.target as Element)?.closest('a[href]');if(link&&!window.confirm('Discard unsaved changes?')){e.preventDefault();e.stopPropagation();}};
 // The shell's early listener preserves the mounted editor on cancelled Back.
 const pop=(e:PopStateEvent)=>{if(!window.confirm('Discard unsaved changes?')){e.stopImmediatePropagation();history.pushState(state,'',url);}};
 const removeGuard=registerArchiveNavigationGuard(pop);window.addEventListener('beforeunload',unload);document.addEventListener('click',click,true);
 return()=>{removeGuard();window.removeEventListener('beforeunload',unload);document.removeEventListener('click',click,true);};
 },[dirty]);}

export function Conflict({onReload,onOverwrite}:{onReload:()=>void;onOverwrite:()=>void}){return <div className="archive-conflict" role="alert"><p>This changed elsewhere since you opened it.</p><div className="archive-actions"><button className="btn ghost" onClick={onReload}>Reload</button><button className="btn" onClick={onOverwrite}>Overwrite anyway</button></div></div>;}
export function ChooseList({lists,onChoose,onClose}:{lists:any[];onChoose:(path:string)=>Promise<void>;onClose:()=>void}){const [error,setError]=useState<any>();return <Sheet title="Move to list…" onClose={onClose}><div className="archive-choice-list">{lists.map(list=><button className="btn ghost" key={list.path} onClick={()=>void onChoose(list.path).then(onClose).catch(setError)}>{list.title}</button>)}</div><ErrorMessage error={error}/></Sheet>;}

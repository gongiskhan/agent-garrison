"use client";
import React,{Suspense,useLayoutEffect,useState} from 'react';
import Link from 'next/link';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
import {ArrowLeft} from 'lucide-react';
let guard:((event:PopStateEvent)=>void)|null=null;
export function registerArchiveNavigationGuard(next:(event:PopStateEvent)=>void){guard=next;return()=>{if(guard===next)guard=null;};}
type Entry={id:string;href:string;previous?:string};
const storage='archive.navigation';
let current:Entry|undefined;
let fallbackReplacement=false;
function entries():Entry[]{try{const value=JSON.parse(sessionStorage.getItem(storage)??'[]');return Array.isArray(value)?value.filter(e=>typeof e?.id==='string'&&typeof e?.href==='string'):[];}catch{return [];}}
const isArchive=(href:string)=>/^\/archive(?:[/?]|$)/.test(href);
function remember(){
 const href=location.pathname+location.search+location.hash,all=entries();
 const existing=all.find(e=>e.id===history.state?.archiveEntry);
 if(existing){existing.href=href;current=existing;}
 else{current={id:crypto.randomUUID(),href,...(!fallbackReplacement&&current&&isArchive(current.href)?{previous:current.id}:{})};all.push(current);}
 fallbackReplacement=false;
 // Preserve Next's router state. Replacing a search query updates this entry;
 // browser Back/Forward restores its identity instead of inventing a visit.
 history.replaceState({...history.state,archiveEntry:current.id},'',location.href);
 try{sessionStorage.setItem(storage,JSON.stringify(all.slice(-100)));}catch{}
 window.dispatchEvent(new Event('archive:navigation'));
}
export function ArchiveBack({fallback='/archive',label='Back',className='archive-back'}:{fallback?:string;label?:string;className?:string}){
 const router=useRouter(),[previous,setPrevious]=useState<string>();
 useLayoutEffect(()=>{const update=()=>{const all=entries(),entry=all.find(e=>e.id===history.state?.archiveEntry),prior=all.find(e=>e.id===entry?.previous);setPrevious(prior&&isArchive(prior.href)?prior.href:undefined);};update();window.addEventListener('archive:navigation',update);return()=>window.removeEventListener('archive:navigation',update);},[]);
 return <Link className={className} href={previous??fallback} aria-label={label} onClick={event=>{if(!event.defaultPrevented&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&event.button===0){event.preventDefault();if(previous)router.back();else{fallbackReplacement=true;router.replace(fallback);}}}}><ArrowLeft size={18}/><span>{label}</span></Link>;
}
// Window popstate listeners run in registration order, including capture
// listeners. Mount with the shell before the router's passive effect so an
// unsaved Archive editor can cancel Back before the router changes its tree.
export function ArchiveNavigationGuard(){
 useLayoutEffect(()=>{const listener=(event:PopStateEvent)=>guard?.(event);window.addEventListener('popstate',listener);return()=>window.removeEventListener('popstate',listener);},[]);
 return <Suspense fallback={null}><ArchiveHistoryTracker/></Suspense>;
}
function ArchiveHistoryTracker(){
 const pathname=usePathname(),params=useSearchParams();
 useLayoutEffect(remember,[pathname,params]);return null;
}

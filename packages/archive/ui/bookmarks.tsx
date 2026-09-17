"use client";
import React,{createContext,useContext,useEffect,useState} from 'react';
import {Bookmark} from 'lucide-react';
import {api,useData,ErrorMessage} from './common';

const SavedContext=createContext<any>(null);
export function SavedProvider({children}:{children:React.ReactNode}){
 const read=useData('bookmarks?paths=1'),[pending,setPending]=useState<string[]>([]),[error,setError]=useState<any>();
 useEffect(()=>{window.addEventListener('archive:changed',read.refresh);return()=>window.removeEventListener('archive:changed',read.refresh);},[read.refresh]);
 const toggle=async(path:string)=>{setPending(p=>[...p,path]);setError(null);try{await api('bookmark','POST',{path,bookmarked:!read.data?.paths.includes(path)});read.refresh();window.dispatchEvent(new Event('archive:changed'));}catch(e){setError(e);}finally{setPending(p=>p.filter(v=>v!==path));}};
 return <SavedContext.Provider value={{...read,pending,toggle}}><ErrorMessage error={error??read.error} onRetry={()=>{setError(null);read.refresh();}}/>{children}</SavedContext.Provider>;
}
export function useSaved(){return useContext(SavedContext);}
export function BookmarkButton({path,title,label=false}:{path:string;title:string;label?:boolean}){
 const saved=useSaved(),active=saved?.data?.paths.includes(path)??false;
 return <button className={label?'archive-chip':'archive-icon archive-save'} aria-label={(active?'Remove bookmark for ':'Bookmark ')+title} aria-pressed={active} disabled={!saved?.data||saved.pending.includes(path)} onClick={()=>void saved.toggle(path)}><Bookmark size={19} fill={active?'currentColor':'none'}/>{label&&(active?'Bookmarked':'Bookmark')}</button>;
}

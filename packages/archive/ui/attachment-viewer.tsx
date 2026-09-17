"use client";
import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {FileText,Paperclip,X,ZoomIn,ZoomOut} from 'lucide-react';
import {ErrorMessage,fileUrl,sizeOf} from './common';

export function AttachmentViewer({file,onClose,onCover,onDelete,returnFocus}:{file:any;returnFocus:React.RefObject<HTMLElement>;onClose:()=>void;onCover:()=>Promise<void>;onDelete:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),[zoom,setZoom]=useState(false),[error,setError]=useState<unknown>();
 const image=file.mime.startsWith('image/'),pdf=file.mime==='application/pdf';
 useEffect(()=>{
  const element=dialog.current!,overflow=document.body.style.overflow;
  element.showModal();document.body.style.overflow='hidden';
  return()=>{element.close();document.body.style.overflow=overflow;if(returnFocus.current?.isConnected)returnFocus.current.focus({preventScroll:true});};
 },[returnFocus]);
 return createPortal(<dialog ref={dialog} className={'archive-viewer archive-overlay '+(image?'archive-viewer-image':'archive-viewer-file')} aria-label={file.name} onCancel={e=>{e.preventDefault();onClose();}}>
  <header className="archive-viewer-bar"><strong>{file.name}</strong><button type="button" className="archive-icon" aria-label="Close viewer" onClick={onClose}><X aria-hidden/></button></header>
  {image?<div className="archive-viewer-content"><img src={fileUrl(file.path)} alt={file.name} className={zoom?'zoomed':undefined}/></div>:<div className="archive-viewer-file-details">{pdf?<FileText size={40} aria-hidden/>:<Paperclip size={40} aria-hidden/>}<p>{pdf?'PDF document':'File'}<span> · {sizeOf(file.size)}</span></p></div>}
  <footer className="archive-actions archive-viewer-actions">
   {image&&<><button type="button" className="btn" onClick={()=>void onCover().then(onClose).catch(setError)}>Set as cover</button><button type="button" className="btn ghost" aria-label={zoom?'Zoom out':'Zoom image'} aria-pressed={zoom} onClick={()=>setZoom(v=>!v)}>{zoom?<ZoomOut size={19}/>:<ZoomIn size={19}/>}</button></>}
   <a className={'btn '+(image?'ghost':'primary')} href={fileUrl(file.path)} target="_blank" rel="noreferrer">{pdf?'Open PDF':'Open'}</a>
   <button type="button" className="btn danger" onClick={onDelete}>Delete</button>
  </footer>
  <ErrorMessage error={error}/>
 </dialog>,document.body);
}

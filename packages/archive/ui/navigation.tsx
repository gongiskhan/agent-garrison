"use client";
import {useLayoutEffect} from 'react';
let guard:((event:PopStateEvent)=>void)|null=null;
export function registerArchiveNavigationGuard(next:(event:PopStateEvent)=>void){guard=next;return()=>{if(guard===next)guard=null;};}
// Window popstate listeners run in registration order, including capture
// listeners. Mount with the shell before the router's passive effect so an
// unsaved Archive editor can cancel Back before the router changes its tree.
export function ArchiveNavigationGuard(){useLayoutEffect(()=>{const listener=(event:PopStateEvent)=>guard?.(event);window.addEventListener('popstate',listener);return()=>window.removeEventListener('popstate',listener);},[]);return null;}

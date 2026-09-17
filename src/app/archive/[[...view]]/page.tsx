import {Suspense} from 'react';
import {notFound,redirect} from 'next/navigation';
import {ArchiveHost} from '../ArchiveHost';
export default async function ArchivePage({params}:{params:Promise<{view?:string[]}>}){const value=(await params).view??[],view=value[0]??'home';if(view==='inbox')redirect('/archive/notes?path=Archive');if(value.length>1||!['home','board','card','notes','search','bookmarks','import','trash','jobs'].includes(view))notFound();return <Suspense fallback={<div className="archive-app">Loading…</div>}><ArchiveHost view={view}/></Suspense>;}

import {Suspense} from 'react';
import {notFound} from 'next/navigation';
import {ArchiveHost} from '../ArchiveHost';
export default async function ArchivePage({params}:{params:Promise<{view?:string[]}>}){const value=(await params).view??[],view=value[0]??'home';if(value.length>1||!['home','board','card','notes','search','inbox','import','trash','jobs'].includes(view))notFound();return <Suspense fallback={<div className="archive-app">Loading…</div>}><ArchiveHost view={view}/></Suspense>;}

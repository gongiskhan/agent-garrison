import {Suspense} from 'react';
import {notFound, redirect} from 'next/navigation';
import {ProjectsHost} from '../ProjectsHost';
export default async function ProjectsPage({params}: {params: Promise<{view?: string[]}>}) {
  const view = (await params).view ?? [];
  if (view.length === 1 || view.length > 3) notFound();
  if (view.length === 2 && !['workspace', 'machines'].includes(view[1])) redirect(`/projects/${encodeURIComponent(view[0])}/${encodeURIComponent(view[1])}/files`);
  if (view[1] === 'machines' && view.length !== 3) notFound();
  if (view.length === 3 && view[1] !== 'machines' && !['files', 'git'].includes(view[2])) notFound();
  return <Suspense fallback={<div className="projects-app"><div className="projects-skeleton" aria-label="Reading projects"/></div>}><ProjectsHost view={view}/></Suspense>;
}

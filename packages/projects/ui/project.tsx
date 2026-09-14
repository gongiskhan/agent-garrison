import {useEffect, useState} from 'react';
import Link from 'next/link';
import {ChevronLeft, X} from 'lucide-react';
import {NodeChip, request, type Bridge, type NodeRef} from './common';
import {Files} from './files';
import {Git, type GitStatus} from './git';
import {PROJECTS_LABEL} from '../label.mjs';
import {projectsUrl} from '../src/urls.mjs';

export function Project({view, node, bridge}: {view: string[]; node: NodeRef; bridge: Bridge}) {
  const project = view[1], workspace = project === 'workspace', tab = view[2] || 'files';
  const base = `/projects/${encodeURIComponent(view[0])}/${encodeURIComponent(project)}`;
  const [dismissed, dismiss] = useState(false);
  const [dirtyPaths, setDirtyPaths] = useState<string[]>([]);
  const statusUrl = projectsUrl({node: view[0], project}, 'git/status');
  useEffect(() => {
    setDirtyPaths([]);
    if (workspace || tab !== 'files') return;
    const controller = new AbortController();
    void request<GitStatus>(statusUrl, {signal: controller.signal}).then(status => {if (!controller.signal.aborted) setDirtyPaths(status.dirty.map(entry => entry.path));}).catch(() => {});
    return () => controller.abort();
  }, [statusUrl, workspace, tab]);
  useEffect(() => {dismiss(sessionStorage.getItem('projects-readonly-dismissed') === '1');}, []);
  return <section className="projects-project"><Link className="projects-back" href="/projects"><ChevronLeft size={19}/>{PROJECTS_LABEL}</Link>
    <header className="projects-project-header"><NodeChip node={node}/><h1>{workspace ? 'Garrison files' : project}</h1>{workspace && <span className="projects-chip">{node.isSelf ? 'writable' : 'read-only'}</span>}</header>
    {!workspace && <nav className="projects-tabs" aria-label="Project tabs"><Link href={`${base}/files`} aria-current={tab === 'files' ? 'page' : undefined}>Files</Link><Link href={`${base}/git`} aria-current={tab === 'git' ? 'page' : undefined}>Git</Link></nav>}
    {!workspace && tab === 'files' && !dismissed && <div className="projects-banner"><span>Read-only. Agents edit this tree; changes move through git.</span><Link href={`${base}/git`}>Git</Link><button type="button" aria-label="Dismiss read-only notice" onClick={() => {sessionStorage.setItem('projects-readonly-dismissed', '1'); dismiss(true);}}><X size={17}/></button></div>}
    {workspace || tab === 'files' ? <Files reference={{node: view[0], project}} writable={workspace && node.isSelf} title={workspace ? 'Garrison files' : project} base={workspace ? base : `${base}/files`} bridge={bridge} dirtyPaths={dirtyPaths}/> : <Git reference={{node: view[0], project}} node={node} base={`${base}/git`}/>}
  </section>;
}

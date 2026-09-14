import Link from 'next/link';
import {ChevronRight, Folder, FolderGit2} from 'lucide-react';
import {PROJECTS_LABEL} from '../label.mjs';
import {NodeChip, Skeleton, nodeStyle, type ProjectList, type ProjectSummary} from './common';

export function summaryLabel(summary: ProjectSummary) {
  return [summary.branch || `detached at ${summary.head?.slice(0, 7) || 'unknown'}`, summary.dirtyCount && `${summary.dirtyCount} changed`, summary.ahead && `${summary.ahead} ahead`, summary.behind && `${summary.behind} behind`].filter(Boolean).join(', ');
}
export function Picker({data, summaries, filter, setFilter, selected}: {data: ProjectList | null; summaries: Record<string, ProjectSummary | string>; filter: string; setFilter: (value: string) => void; selected?: string}) {
  const needle = filter.toLowerCase(), nodeMatches = data?.node.name.toLowerCase().includes(needle);
  const projects = data?.projects.filter(row => nodeMatches || row.project.toLowerCase().includes(needle)) ?? [];
  const workspace = !needle || nodeMatches || 'garrison files'.includes(needle);
  return <aside className="projects-picker" aria-label="Project picker"><h1>{PROJECTS_LABEL}</h1><label className="projects-filter"><span className="visually-hidden">Filter projects</span><input type="search" placeholder="Filter projects" value={filter} onChange={event => setFilter(event.target.value)}/></label>
    {!data ? <Skeleton/> : (projects.length > 0 || workspace) && <section className="projects-node-group" style={nodeStyle(data.node)}><header><NodeChip node={data.node}/><span className="projects-node-state">{data.node.state}<small>this node</small></span></header>
      {workspace && <Link className="projects-picker-row" aria-current={selected === 'workspace' ? 'page' : undefined} href={`/projects/${encodeURIComponent(data.node.id)}/workspace`}><Folder size={21}/><span><strong>Garrison files</strong><small>documents, recordings, runs, uploads</small></span><ChevronRight size={18}/></Link>}
      {projects.map(row => {
        const summary = summaries[row.project];
        return <Link key={row.project} className="projects-picker-row" aria-current={selected === row.project ? 'page' : undefined} href={`/projects/${encodeURIComponent(data.node.id)}/${encodeURIComponent(row.project)}/files`}><FolderGit2 size={21}/><span><strong>{row.project}</strong>{summary ? <small>{typeof summary === 'string' ? summary : summaryLabel(summary)}</small> : <Skeleton subtitle/>}</span><ChevronRight size={18}/></Link>;
      })}
      {!data.projects.length && !needle && <p className="projects-empty">No projects on {data.node.name}. Add a git repository under {data.devRoot}.</p>}
    </section>}
  </aside>;
}

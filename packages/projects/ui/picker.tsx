import {Fragment} from 'react';
import Link from 'next/link';
import {ChevronRight, Folder, FolderGit2, Monitor} from 'lucide-react';
import {PROJECTS_LABEL} from '../label.mjs';
import {Banner, Skeleton, nodeStyle, type Bridge, type ProjectRef, type ProjectSummary} from './common';
import {summaryKey, type ProjectGroup, type SummaryMap} from './loader';
import {STATE_UNAVAILABLE} from './git-results';

export function summaryLabel(summary: ProjectSummary) {
  return [summary.branch || `detached at ${summary.head?.slice(0, 7) || 'unknown'}`, summary.dirtyCount && `${summary.dirtyCount} changed`, summary.ahead && `${summary.ahead} ahead`, summary.behind && `${summary.behind} behind`].filter(Boolean).join(', ');
}
export function Picker({groups, summaries, filter, setFilter, selected, bridge, retry, selectedMachine}: {groups: ProjectGroup[] | null; summaries: SummaryMap; filter: string; setFilter: (value: string) => void; selected?: ProjectRef; bridge: Bridge; retry: () => void; selectedMachine?: string}) {
  const needle = filter.toLowerCase();
  return <aside className="projects-picker" aria-label="Project picker"><h1>{PROJECTS_LABEL}</h1><label className="projects-filter"><span className="visually-hidden">Filter projects</span><input type="search" placeholder="Filter projects" value={filter} onChange={event => setFilter(event.target.value)}/></label>
    {!groups ? <Skeleton/> : groups.map(({node, data, error}) => {
      const nodeMatches = node.name.toLowerCase().includes(needle), projects = data?.projects.filter(row => nodeMatches || row.project.toLowerCase().includes(needle)) ?? [];
      const machines = data?.machines.filter(row => nodeMatches || `${row.label} ${row.transport}`.toLowerCase().includes(needle)) ?? [];
      const workspace = !needle || nodeMatches || 'garrison files'.includes(needle);
      if (needle && !projects.length && !machines.length && !workspace) return null;
      const base = `/projects/${encodeURIComponent(node.id)}`;
      return <section key={node.id} className="projects-node-group" data-node={node.id} style={nodeStyle(node)}><header><bridge.NodeChip node={node}/><span className="projects-node-state">{node.state}{node.isSelf && <small>this node</small>}</span></header>
        {node.state === 'offline' ? <p className="projects-empty">{node.name} is offline. Its projects will appear when it is back.</p> : error ? <Banner retry={retry}>{error.status === 503 ? STATE_UNAVAILABLE : error.status === 502 ? <>{node.name} did not answer. <span className="projects-phone-copy">Pull down to try again.</span><span className="projects-desktop-copy">Reload to try again.</span></> : error.message}</Banner> : !data ? <Skeleton/> : <>
          {workspace && <Link className="projects-picker-row" aria-current={selected?.node === node.id && selected.project === 'workspace' ? 'page' : undefined} href={`${base}/workspace`}><Folder size={21}/><span><strong>Garrison files</strong><small>documents, recordings, runs, uploads</small></span><ChevronRight size={18}/></Link>}
          {projects.map(row => {
            const summary = summaries[summaryKey(node.id, row.project)];
            return <Link key={row.project} className="projects-picker-row" aria-current={selected?.node === node.id && selected.project === row.project ? 'page' : undefined} href={`${base}/${encodeURIComponent(row.project)}/files`}><FolderGit2 size={21}/><span><strong>{row.project}</strong>{summary ? <small className="projects-summary">{typeof summary === 'string' ? summary : summaryLabel(summary).split(', ').map((part, index) => <Fragment key={part}>{index > 0 && ', '}<span className="projects-summary-chip">{part}</span></Fragment>)}</small> : <Skeleton subtitle/>}</span><ChevronRight size={18}/></Link>;
          })}
          {machines.map(machine => <Link key={machine.transport} className="projects-picker-row" aria-current={selected?.node === node.id && selected.project === 'machines' && selectedMachine === machine.transport ? 'page' : undefined} href={`${base}/machines/${encodeURIComponent(machine.transport)}`}><Monitor size={21}/><span><strong>{machine.label}</strong><small>Machine, read-only</small></span><ChevronRight size={18}/></Link>)}
          {!data.projects.length && !needle && <p className="projects-empty">No projects on {node.name}. Add a git repository under {data.devRoot}.</p>}
        </>}
      </section>;
    })}
  </aside>;
}

"use client";
import {useEffect, useState} from 'react';
import {listUrl, projectsUrl, setSelfNode} from '../src/urls.mjs';
import {Banner, Skeleton, request, type Bridge, type ProjectList, type ProjectSummary} from './common';
import {Picker} from './picker';
import {Project} from './project';

let selfRequest: Promise<{node: {id: string}}> | undefined;
function selfIdentity() {return selfRequest ??= request<{node: {id: string}}>('/api/mesh/self').catch(error => {selfRequest = undefined; throw error;});}

export function ProjectsHost({view, bridge}: {view: string[]; bridge: Bridge}) {
  const [data, setData] = useState<ProjectList | null>(null), [error, setError] = useState('');
  const [summaries, setSummaries] = useState<Record<string, ProjectSummary | string>>({});
  const [filter, setFilter] = useState(''), [revision, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setData(null); setSummaries({});
    void (async () => {
      try {
        const [self, list] = await Promise.all([selfIdentity(), request<ProjectList>(listUrl(), {signal: controller.signal})]);
        if (controller.signal.aborted) return;
        setSelfNode(self.node.id); setData(list);
        let next = 0;
        const worker = async () => {
          while (next < list.projects.length && !controller.signal.aborted) {
            const row = list.projects[next++];
            try {
              const summary = await request<ProjectSummary>(projectsUrl({node: list.node.id, project: row.project}, 'summary'), {signal: controller.signal});
              if (!controller.signal.aborted) setSummaries(previous => ({...previous, [row.project]: summary}));
            } catch (failure) {
              if (!controller.signal.aborted) setSummaries(previous => ({...previous, [row.project]: (failure as Error).message}));
            }
          }
        };
        await Promise.all(Array.from({length: 4}, worker));
      } catch (failure) {
        if (!controller.signal.aborted) setError((failure as Error).message);
      }
    })();
    return () => controller.abort();
  }, [revision]);
  const selected = view[1];
  return <div className={`projects-app${selected ? ' projects-has-selection' : ''}`}>
    {error && <Banner retry={() => refresh(value => value + 1)}>{error}</Banner>}
    <div className="projects-layout"><Picker data={data} summaries={summaries} filter={filter} setFilter={setFilter} selected={selected}/>
      <main className="projects-main">{selected ? data ? <Project key={`${view[0]}/${selected}`} view={view} node={data.node} bridge={bridge}/> : <Skeleton/> : <p className="projects-pick-prompt">Pick a project to browse its files or work with git.</p>}</main>
    </div>
  </div>;
}

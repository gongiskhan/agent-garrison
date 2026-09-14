"use client";
import {useEffect, useRef, useState} from 'react';
import {listUrl, projectsUrl, setSelfNode} from '../src/urls.mjs';
import {ApiError, Banner, Skeleton, request, type Bridge, type NodeRef, type ProjectList, type ProjectSummary} from './common';
import {Picker} from './picker';
import {Project} from './project';
import {STATE_UNAVAILABLE} from './git-results';
import {asNodeRef, summaryQueue, type ProjectGroup, type SummaryMap} from './loader';

let selfRequest: Promise<{node: {id: string}}> | undefined;
function selfIdentity() {return selfRequest ??= request<{node: {id: string}}>('/api/mesh/self').catch(error => {selfRequest = undefined; throw error;});}

export function ProjectsHost({view, bridge}: {view: string[]; bridge: Bridge}) {
  const [groups, setGroups] = useState<ProjectGroup[] | null>(null), [error, setError] = useState('');
  const [summaries, setSummaries] = useState<SummaryMap>({});
  const [filter, setFilter] = useState(''), [revision, refresh] = useState(0);
  const [stateUnavailable, setStateUnavailable] = useState(false), [rosterReady, setRosterReady] = useState(false);
  const touchStart = useRef<number | null>(null);
  useEffect(() => {
    const controller = new AbortController(), signal = controller.signal;
    setError(''); setGroups(null); setSummaries({}); setStateUnavailable(false); setRosterReady(false);
    const roster = request<{nodes: (Omit<NodeRef, 'state'> & {state: string})[]}>('/api/mesh/nodes', {signal}).then(value => ({value}), failure => ({failure}));
    const enqueue = summaryQueue({signal,
      read: (node, project) => request<ProjectSummary>(projectsUrl({node, project}, 'summary'), {signal}),
      receive: (key, value) => {setSummaries(previous => ({...previous, [key]: value})); if (value === STATE_UNAVAILABLE) setStateUnavailable(true);}});
    void (async () => {
      try {
        const [self, list] = await Promise.all([selfIdentity(), request<ProjectList>('/api/projects', {signal})]);
        if (signal.aborted) return;
        setSelfNode(self.node.id);
        const local = {...list, node: {...list.node, isSelf: true}};
        setGroups([{node: local.node, data: local}]);
        enqueue(self.node.id, local.projects);
        const response = await roster;
        if (signal.aborted) return;
        if ('failure' in response) {
          const unavailable = response.failure instanceof ApiError && response.failure.status === 503;
          setStateUnavailable(unavailable);
          setError(unavailable ? STATE_UNAVAILABLE : 'The node list could not be read.');
          setRosterReady(true);
          return;
        }
        const peers = response.value.nodes.filter(row => row.id !== self.node.id).map(row => asNodeRef(row, self.node.id)).sort((a, b) => a.name.localeCompare(b.name));
        setGroups([{node: local.node, data: local}, ...peers.map(node => ({node, data: null}))]);
        setRosterReady(true);
        await Promise.all(peers.filter(node => node.state !== 'offline').map(async node => {
          try {
            const data = await request<ProjectList>(listUrl(node.id), {signal});
            if (data.node.id !== node.id) throw new Error('The node returned a different identity.');
            if (signal.aborted) return;
            const owner = {...data.node, isSelf: false, state: 'online' as const};
            setGroups(previous => previous!.map(group => group.node.id === node.id ? {node: owner, data: {...data, node: owner}} : group));
            enqueue(node.id, data.projects);
          } catch (failure) {
            if (signal.aborted) return;
            if (failure instanceof ApiError && failure.status === 503) setStateUnavailable(true);
            const message = failure instanceof Error ? failure.message : `${node.name} did not answer.`;
            setGroups(previous => previous!.map(group => group.node.id === node.id ? {...group, error: {message, status: failure instanceof ApiError ? failure.status : undefined}} : group));
          }
        }));
      } catch (failure) {
        if (!signal.aborted) {setError((failure as Error).message); setRosterReady(true);}
      }
    })();
    return () => controller.abort();
  }, [revision]);
  const selected = view.length > 1, owner = groups?.find(group => group.node.id === view[0]);
  const retry = () => refresh(value => value + 1);
  return <div className={`projects-app${selected ? ' projects-has-selection' : ''}`}
    onTouchStart={event => {touchStart.current = window.scrollY === 0 ? event.touches[0].clientY : null;}}
    onTouchEnd={event => {if (touchStart.current !== null && event.changedTouches[0].clientY - touchStart.current > 80) retry(); touchStart.current = null;}}>
    {error && !(stateUnavailable && owner && view[2] === 'git') && <Banner retry={retry}>{error}</Banner>}
    <div className="projects-layout"><Picker groups={groups} summaries={summaries} filter={filter} setFilter={setFilter} selected={selected ? {node: view[0], project: view[1]} : undefined} bridge={bridge} retry={retry}/>
      <main className="projects-main">{selected ? owner ? <Project key={`${view[0]}/${view[1]}`} view={view} node={owner.node} bridge={bridge} stateUnavailable={stateUnavailable}/> : rosterReady ? stateUnavailable ? null : <Banner retry={retry}>This node is not in the mesh.</Banner> : <Skeleton/> : <p className="projects-pick-prompt">Pick a project to browse its files or work with git.</p>}</main>
    </div>
  </div>;
}

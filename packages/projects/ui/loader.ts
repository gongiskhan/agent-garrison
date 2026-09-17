import {ApiError, failureMessage, type NodeRef, type ProjectList, type ProjectSummary} from './common';

export type ProjectGroup = {node: NodeRef; data: ProjectList | null; error?: {status?: number; message: string}};
export type SummaryMap = Record<string, ProjectSummary | string>;
export const summaryKey = (node: string, project: string) => `${node}/${project}`;
export function asNodeRef(row: Omit<NodeRef, 'state'> & {state: string}, selfId: string): NodeRef {
  return {id: row.id, name: row.name || row.id, accentColor: row.accentColor,
    isSelf: row.id === selfId,
    state: row.id === selfId || ['online', 'ready', 'busy', 'degraded'].includes(row.state) ? 'online' : row.state === 'offline' ? 'offline' : 'unknown'};
}

export function summaryQueue({read, receive, signal}: {
  read: (node: string, project: string) => Promise<ProjectSummary>;
  receive: (key: string, value: ProjectSummary | string) => void;
  signal: AbortSignal;
}) {
  const pending: {node: string; project: string}[] = [];
  let running = 0;
  function drain() {
    while (running < 4 && pending.length && !signal.aborted) {
      const row = pending.shift()!;
      running += 1;
      void read(row.node, row.project).then(value => {
        if (!signal.aborted) receive(summaryKey(row.node, row.project), value);
      }).catch(error => {
        if (!signal.aborted) receive(summaryKey(row.node, row.project), error instanceof ApiError ? failureMessage(error, row.node) : 'Summary unavailable');
      }).finally(() => {running -= 1; drain();});
    }
  }
  return (node: string, projects: {project: string}[]) => {
    pending.push(...projects.map(row => ({node, project: row.project})));
    drain();
  };
}

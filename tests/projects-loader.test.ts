import {describe, expect, it, vi} from 'vitest';
import {asNodeRef, summaryKey, summaryQueue} from '../packages/projects/ui/loader';
import {ApiError, failureMessage, type ProjectSummary} from '../packages/projects/ui/common';

const summary = (project: string): ProjectSummary => ({project, branch: 'main', head: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, dirtyCount: 0, stash: 0, mergeInProgress: false, lastCommitAt: null});
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
describe('Projects roster loading', () => {
  it('caps all summary requests at four and drains self before queued peer rows', async () => {
    const release: (() => void)[] = [], started: string[] = [], received = vi.fn();
    let active = 0, max = 0;
    const enqueue = summaryQueue({signal: new AbortController().signal, receive: received, read: async (node, project) => {
      started.push(summaryKey(node, project)); active += 1; max = Math.max(max, active);
      await new Promise<void>(resolve => release.push(resolve)); active -= 1; return summary(project);
    }});
    enqueue('fixture-a', Array.from({length: 6}, (_, i) => ({project: `project-${i}`})));
    enqueue('fixture-b', [{project: 'delta'}, {project: 'echo'}]);
    expect(started).toHaveLength(4);
    release.shift()!(); await settle();
    expect(started[4]).toBe('fixture-a/project-4');
    release.shift()!(); await settle();
    expect(started[5]).toBe('fixture-a/project-5');
    while (release.length) {release.shift()!(); await settle();}
    expect(max).toBe(4); expect(started.slice(6)).toEqual(['fixture-b/delta', 'fixture-b/echo']);
    expect(received).toHaveBeenCalledTimes(8);
  });
  it('finishes a failed summary and continues without keeping a shimmer forever', async () => {
    const received = vi.fn();
    const enqueue = summaryQueue({signal: new AbortController().signal, receive: received, read: async (_node, project) => {
      if (project === 'alpha') throw new ApiError(404, {error: 'no such project'});
      return summary(project);
    }});
    enqueue('fixture-a', [{project: 'alpha'}, {project: 'beta'}]); await settle();
    expect(received).toHaveBeenCalledWith('fixture-a/alpha', 'no such project');
    expect(received).toHaveBeenCalledWith('fixture-a/beta', summary('beta'));
  });
  it('does not publish or launch queued requests after the page leaves', async () => {
    const controller = new AbortController(), release: (() => void)[] = [], received = vi.fn(), read = vi.fn(async (_node, project) => {
      await new Promise<void>(resolve => release.push(resolve)); return summary(project);
    });
    const enqueue = summaryQueue({signal: controller.signal, receive: received, read});
    enqueue('fixture-a', Array.from({length: 8}, (_, i) => ({project: `project-${i}`})));
    controller.abort(); release.forEach(resolve => resolve()); await settle();
    expect(read).toHaveBeenCalledTimes(4); expect(received).not.toHaveBeenCalled();
  });
  it.each([['ready', 'online'], ['busy', 'online'], ['degraded', 'online'], ['offline', 'offline'], ['unrecognized', 'unknown']])('maps registry state %s to %s', (state, expected) => {
    expect(asNodeRef({id: 'fixture-b', name: 'Fixture B', accentColor: '#123456', isSelf: true, state}, 'fixture-a')).toEqual({id: 'fixture-b', name: 'Fixture B', accentColor: '#123456', isSelf: false, state: expected});
  });
  it('shows a peer sentence when supplied and a node-specific fallback otherwise', () => {
    expect(failureMessage(new ApiError(403, {error: 'path escapes workspace root'}), 'Fixture B')).toBe('path escapes workspace root');
    expect(failureMessage(new ApiError(502, {error: 'peer-unreachable'}), 'Fixture B')).toBe('Fixture B did not answer.');
    expect(failureMessage(new ApiError(502, {}), 'Fixture B')).toBe('Fixture B did not answer.');
    expect(failureMessage(new ApiError(503, {error: 'state-unavailable'}), 'Fixture B')).toBe('Shared state is unreachable. Git actions need it; browsing still works.');
  });
});

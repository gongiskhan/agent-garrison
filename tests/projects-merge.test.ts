import {existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {StateClient} from '@garrison/state-client';
import {resolveProjectName} from '../src/lib/dev-root';
import {startStateService, type StateHarness} from './state-service-harness';
import {git, initRepo, initBare, cloneOf} from './projects-git-fixture';
// @ts-ignore The package is exercised directly as ESM.
import {commitPushProject, pullFromOthers, pumpOnce, REQUEST_KIND, REPLY_KIND, REQUEST_MAX_AGE_MS} from '../packages/projects/src/merge.mjs';
// @ts-ignore The package is exercised directly as ESM.
import {gitStatus} from '../packages/projects/src/git.mjs';

describe('pull-from-others through the state service and peer pump', () => {
  let harness: StateHarness & {tokens: Record<string, string>};
  let base: string, a: string, b: string, clientA: StateClient, clientB: StateClient;
  const envA = {GARRISON_NODE_NAME: 'node-a'}, envB = {GARRISON_NODE_NAME: 'node-b'};
  const resolveA = (project: string) => resolveProjectName(project, {devRoot: path.join(base, 'dev-a')});
  const resolveB = (project: string) => resolveProjectName(project, {devRoot: path.join(base, 'dev-b')});
  beforeAll(async () => {
    harness = await startStateService({nodes: ['node-a', 'node-b']});
    clientA = harness.client;
    clientB = new StateClient({url: harness.url, token: harness.tokens['node-b'], node: 'node-b'});
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'projects-pump-')));
    a = await initRepo(path.join(base, 'dev-a/alpha'));
    const origin = await initBare(a, path.join(base, 'origin.git'));
    await git(a, 'remote', 'add', '--', 'origin', origin);
    await git(a, 'push', '--quiet', '--set-upstream', 'origin', 'main');
    b = await cloneOf(a, origin, path.join(base, 'dev-b/alpha'));
  }, 30_000);
  afterAll(async () => {if (harness) await harness.stop(); if (base) rmSync(base, {recursive: true, force: true});});

  it("asks the mesh, the peer's pump answers, and the report names the reply and merge", async () => {
    writeFileSync(path.join(b, 'from-peer.txt'), 'Synthetic work on the peer\n');
    let cursor = 0, pumping = true;
    const pump = (async () => {
      while (pumping) {
        cursor = await pumpOnce({client: clientB, env: envB, resolveProject: resolveB, sinceSeq: cursor});
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    })();
    let report;
    try {report = await pullFromOthers('alpha', {env: envA, client: clientA, resolveProject: resolveA, deadlineMs: 10_000, pollMs: 50});}
    finally {pumping = false; await pump;}
    expect(report).toMatchObject({project: 'alpha', from: 'node-a', merged: true});
    expect(report.nodes).toHaveLength(1);
    expect(report.nodes[0]).toMatchObject({node: 'node-b', status: 'replied', branch: 'main', merge: 'merged'});
    expect(report.nodes[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(report.nodes[0].mergedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(path.join(a, 'from-peer.txt'))).toBe(true);
  }, 20_000);

  it('records the request and exactly one reply as events, including a repeated poll', async () => {
    await pumpOnce({client: clientB, env: envB, resolveProject: resolveB, sinceSeq: 0});
    const requests = await clientA.listEvents({kind: REQUEST_KIND}), replies = await clientA.listEvents({kind: REPLY_KIND});
    expect(requests).toHaveLength(1); expect(replies).toHaveLength(1);
    expect(replies[0].payload.requestId).toBe(requests[0].payload.requestId);
    expect(replies[0].payload.node).toBe('node-b');
  });

  it('a node NEVER answers its own request', async () => {
    const before = (await clientA.listEvents({kind: REPLY_KIND})).length;
    await pumpOnce({client: clientA, env: envA, resolveProject: resolveA, sinceSeq: 0});
    expect((await clientA.listEvents({kind: REPLY_KIND})).length).toBe(before);
  });

  it('SKIPS a commit-push when a session is live in that repository', async () => {
    await clientB.upsertSession('synthetic-live-session', {homeNode: 'node-b', status: 'running', cwd: b});
    writeFileSync(path.join(b, 'unfinished.txt'), 'Synthetic partial work\n');
    const before = await git(b, 'rev-parse', 'HEAD');
    expect(await commitPushProject('alpha', {env: envB, client: clientB, resolveProject: resolveB})).toMatchObject({status: 'skipped-session', sessions: 1});
    expect(await git(b, 'rev-parse', 'HEAD')).toBe(before);
    expect((await gitStatus(b)).dirty.map((entry: {path: string}) => entry.path)).toContain('unfinished.txt');
  });

  it('skips when the session registry is unreadable', async () => {
    const client = {listSessions: async () => {throw new Error('Synthetic unavailable registry');}};
    expect(await commitPushProject('alpha', {env: envB, client, resolveProject: resolveB})).toMatchObject({status: 'skipped-unknown-sessions'});
  });

  it('refuses a project that is not a dev-root repository on this node', async () => {
    for (const project of ['../outside', 'absent']) {
      await expect(commitPushProject(project, {env: envB, client: clientB, resolveProject: resolveB})).rejects.toThrow(/no git project/);
    }
  });

  it('does not answer requests older than five minutes or past their reply deadline', async () => {
    const now = Date.now(), replies: unknown[] = [];
    const client = {
      listEvents: async () => [
        {seq: 1, at: new Date(now - REQUEST_MAX_AGE_MS - 1).toISOString(), payload: {project: 'alpha', requestedBy: 'node-a', requestId: 'old'}},
        {seq: 2, at: new Date(now).toISOString(), payload: {project: 'alpha', requestedBy: 'node-a', requestId: 'expired', deadline: new Date(now - 1).toISOString()}}
      ],
      appendEvent: async (event: unknown) => {replies.push(event);}
    };
    expect(await pumpOnce({client, env: envB, resolveProject: resolveB, now: () => now})).toBe(2);
    expect(replies).toEqual([]);
  });
});

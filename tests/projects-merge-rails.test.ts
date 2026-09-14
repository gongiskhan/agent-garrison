import {existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resolveProjectName} from '../src/lib/dev-root';
import {git, initRepo, initBare, cloneOf, commitFile} from './projects-git-fixture';
// @ts-ignore The package is exercised directly as ESM.
import {pullFromOthers, pushToOthers} from '../packages/projects/src/merge.mjs';
// @ts-ignore The package is exercised directly as ESM.
import {gitStatus} from '../packages/projects/src/git.mjs';

let base: string, a: string, b: string, sha: string, requestId: string;
let refuseCards: boolean, replyNode: string, replyStatus: string;
let cards: Record<string, any>[];
const env = {GARRISON_NODE_NAME: 'node-a'};
const resolveProject = (project: string) => resolveProjectName(project, {devRoot: path.join(base, 'dev-a')});
const client = {
  listSessions: async () => [],
  listNodes: async () => [{name: 'node-a', status: 'active'}, {name: 'node-b', status: 'active'}],
  appendEvent: async (event: {payload: {requestId: string}}) => {requestId = event.payload.requestId; return {seq: 1};},
  listEvents: async () => [{payload: {requestId, node: replyNode, status: replyStatus, branch: 'main', sha}}],
  createCard: async (card: Record<string, unknown>) => {
    if (refuseCards) throw new Error('Synthetic card write failure');
    const stored = {...card, rev: 0}; cards.push(stored); return stored;
  },
  patchCard: async (id: string, patch: Record<string, unknown>, {ifMatchRev}: {ifMatchRev: number}) => {
    const card = cards.find(row => row.id === id)!;
    expect(card.rev).toBe(ifMatchRev);
    Object.assign(card, patch, {rev: card.rev + 1}); return card;
  }
};
beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'projects-merge-rails-')));
  a = await initRepo(path.join(base, 'dev-a/alpha'));
  const origin = await initBare(a, path.join(base, 'origin.git'));
  await git(a, 'remote', 'add', '--', 'origin', origin);
  await git(a, 'push', '--quiet', '--set-upstream', 'origin', 'main');
  b = await cloneOf(a, origin, path.join(base, 'dev-b/alpha'));
  sha = (await git(b, 'rev-parse', 'HEAD')).trim();
  requestId = ''; cards = []; refuseCards = false; replyNode = 'node-b'; replyStatus = 'pushed';
});
afterEach(() => rmSync(base, {recursive: true, force: true}));
async function publish(rel = 'peer.txt', content: string | Buffer = 'Synthetic peer work\n') {
  await commitFile(b, rel, content, 'Synthetic peer snapshot');
  await git(b, 'push', '--quiet', 'origin', 'main');
  sha = (await git(b, 'rev-parse', 'HEAD')).trim();
}
const pull = (deadlineMs = 2000) => pullFromOthers('alpha', {client, resolveProject, env, deadlineMs, pollMs: 1});

describe('merge rails on the owning tree', () => {
  it('preserves the pre-merge tag, both parents and a completed decision card for a non-trivial merge', async () => {
    await commitFile(a, 'local.txt', 'Synthetic local work\n', 'Synthetic local snapshot');
    const before = (await git(a, 'rev-parse', 'HEAD')).trim();
    await publish();
    const result = await pull();
    expect(result.nodes[0]).toMatchObject({node: 'node-b', merge: 'merged', cardId: cards[0].id});
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({list: 'done', status: 'done', duty: 'merge', placement: {target: 'node-a'}});
    const tag = (await git(a, 'tag', '--list', 'garrison/premerge/alpha/node-a/*')).trim();
    expect(tag).toMatch(/^garrison\/premerge\/alpha\/node-a\//);
    expect((await git(a, 'rev-parse', tag)).trim()).toBe(before);
    expect((await git(a, 'rev-list', '--parents', '--max-count', '1', 'HEAD')).trim().split(' ')).toHaveLength(3);
    expect(cards[0].description).toContain(result.nodes[0].mergedSha);
  });
  it('aborts a conflicting merge and returns its decision card', async () => {
    await commitFile(a, 'README.md', '# Synthetic local heading\n', 'Synthetic local heading snapshot');
    const before = await git(a, 'rev-parse', 'HEAD');
    await publish('README.md', '# Synthetic peer heading\n');
    const result = await pull();
    expect(result.nodes[0]).toMatchObject({merge: 'conflict-card', cardId: cards[0].id});
    expect(cards).toHaveLength(1);
    expect(cards[0].description).toContain('aborted');
    expect(await git(a, 'rev-parse', 'HEAD')).toBe(before);
    expect(await gitStatus(a)).toMatchObject({mergeInProgress: false, dirtyCount: 0});
  });
  it.each(['package-lock.json', 'apm.lock.yaml'])('sends %s to the merge duty for regeneration without merging its bytes', async filename => {
    const before = await git(a, 'rev-parse', 'HEAD');
    await publish(filename, filename.endsWith('.json') ? '{"lockfileVersion":3}\n' : 'lockfile_version: 1\n');
    const result = await pull();
    expect(result.nodes[0]).toMatchObject({merge: 'conflict-card', cardId: cards[0].id});
    expect(cards[0].description).toContain('regenerate this lockfile');
    expect(await git(a, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(path.join(a, filename))).toBe(false);
  });
  it('refuses a binary merge and preserves the tree with an actionable card', async () => {
    const before = await git(a, 'rev-parse', 'HEAD');
    await publish('picture.bin', Buffer.from([0, 1, 2, 255]));
    const result = await pull();
    expect(result.nodes[0]).toMatchObject({merge: 'conflict-card', cardId: cards[0].id});
    expect(cards[0].description).toContain('binary refused');
    expect(await git(a, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(path.join(a, 'picture.bin'))).toBe(false);
  });
  it('does not merge when a required decision card cannot be written', async () => {
    await commitFile(a, 'local.txt', 'Synthetic local work\n', 'Synthetic local snapshot');
    const before = await git(a, 'rev-parse', 'HEAD');
    await publish(); refuseCards = true;
    const result = await pull();
    expect(result.nodes[0]).toMatchObject({merge: 'not-attempted', detail: 'Synthetic card write failure'});
    expect(await git(a, 'rev-parse', 'HEAD')).toBe(before);
    expect(await gitStatus(a)).toMatchObject({mergeInProgress: false, dirtyCount: 0});
  });
  it('does not merge an unpublished reply even when its sha exists locally', async () => {
    await publish(); replyStatus = 'skipped-session';
    const before = await git(a, 'rev-parse', 'HEAD');
    expect((await pull()).nodes[0].merge).toBe('not-attempted');
    expect(await git(a, 'rev-parse', 'HEAD')).toBe(before);
  });
  it('refuses an unsafe sha before it can become a git argument', async () => {
    sha = '--output=synthetic';
    expect((await pull()).nodes[0]).toMatchObject({merge: 'not-attempted', detail: 'the peer did not return a valid commit'});
  });
  it('ignores replies from nodes outside the request peer set', async () => {
    replyNode = 'unrequested-node';
    expect((await pull(20)).nodes).toEqual([{node: 'node-b', status: 'no-reply', branch: null, sha: null, merge: 'not-attempted'}]);
  });
  it('files one merge duty card per requested active peer, never itself or duplicate targets', async () => {
    writeFileSync(path.join(a, 'ready.txt'), 'Synthetic ready work\n');
    const result = await pushToOthers('alpha', {client, resolveProject, env, targets: ['node-a', 'node-b', 'node-b', 'absent']});
    expect(result.local.status).toBe('pushed');
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({node: 'node-b', status: 'filed', cardId: cards[0].id});
    expect(cards[0]).toMatchObject({duty: 'merge', placement: {target: 'node-b'}});
    expect(cards[0].description).toContain('--no-ff');
  });
  it('files no cards when this repository has no origin', async () => {
    await git(a, 'remote', 'remove', 'origin');
    writeFileSync(path.join(a, 'ready.txt'), 'Synthetic local-only work\n');
    const result = await pushToOthers('alpha', {client, resolveProject, env});
    expect(result.local.status).toBe('committed-no-origin');
    expect(result.cards).toEqual([]); expect(cards).toEqual([]);
  });
});

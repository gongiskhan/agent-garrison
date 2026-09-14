import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {RETIRED_PROJECTS_FITTING as retired} from '../src/lib/composition-migrate';
const calls = vi.hoisted(() => ({read: vi.fn()}));
vi.mock('@/lib/claude-home', () => ({garrisonDir: () => '/synthetic/home'}));
vi.mock('@/lib/node-identity', () => ({readNodeIdentity: () => ({tetherHost: null})}));
vi.mock('@/lib/tailnet-serve', () => ({getTailnetServeMap: async () => new Map()}));
vi.mock('node:fs/promises', async () => ({
  readdir: async () => [`${['file', 'browser'].join('-')}.json`, 'sample-view.json'],
  readFile: calls.read
}));
vi.mock('@/lib/own-port-lifecycle', () => ({isValidFittingId: () => true}));
vi.mock('@/lib/instance-profile', () => ({currentProfile: () => 'node'}));
vi.mock('@/lib/tailnet-publish', () => ({publishPortToTailnet: vi.fn()}));
import {GET} from '../src/app/api/fittings/views/route';
import {GET as proxy} from '../src/app/api/fittings/proxy/[fittingId]/[[...path]]/route';
import {POST as publish} from '../src/app/api/fittings/[id]/publish/route';
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
it('ignores the retired status file before opening or probing it', async () => {
  calls.read.mockResolvedValue(JSON.stringify({fittingId: 'sample-view', port: 12345, url: 'http://surface.invalid'}));
  const fetcher = vi.fn(async () => ({ok: true})); vi.stubGlobal('fetch', fetcher);
  const {views} = await (await GET()).json();
  expect(views.map((view: {fittingId: string}) => view.fittingId)).toEqual(['sample-view']);
  expect(calls.read).toHaveBeenCalledTimes(1);
  expect(calls.read.mock.calls[0][0]).not.toContain(retired);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('refuses the retired proxy before reading its status file', async () => {
  const response = await proxy(new Request('http://app.invalid/api/fittings/proxy/retired'), {params: {fittingId: retired}});
  expect(response.status).toBe(404); expect(calls.read).not.toHaveBeenCalled();
});
it('refuses publishing the retired surface before reading its status file', async () => {
  const response = await publish(new Request('http://app.invalid/api/fittings/retired/publish', {method: 'POST'}), {params: {id: retired}});
  expect(response.status).toBe(404); expect(calls.read).not.toHaveBeenCalled();
});

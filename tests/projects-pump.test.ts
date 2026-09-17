import {afterEach, describe, expect, it, vi} from 'vitest';
// @ts-ignore The package is exercised directly as ESM.
import {ensurePump} from '../packages/projects/src/pump.mjs';

const key = Symbol.for('garrison.projects.pump');
afterEach(() => {
  const root = globalThis as Record<symbol, {stop: () => void} | undefined>;
  root[key]?.stop(); delete root[key]; vi.useRealTimers();
});
describe('Projects app pump', () => {
  it('starts once across repeated calls and app module reloads', async () => {
    vi.useFakeTimers();
    const client = {listEvents: vi.fn(async () => [])}, log = vi.fn();
    const options = {client, env: {GARRISON_NODE_NAME: 'fixture-a'}, log, resolveProject: () => null};
    const first = ensurePump(options);
    expect(ensurePump(options)).toBe(first);
    vi.resetModules();
    // @ts-ignore App reloads must share the global handle.
    const reloaded = await import('../packages/projects/src/pump.mjs');
    expect(reloaded.ensurePump(options)).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listEvents).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.listEvents).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.filter(call => String(call[0]).includes('pump started'))).toEqual([['[projects] pump started node=fixture-a interval=10000ms']]);
  });
  it('does not touch shared state when disabled', async () => {
    const client = {listEvents: vi.fn(async () => [])}, log = vi.fn();
    expect(ensurePump({client, env: {GARRISON_PROJECTS_PUMP: '0'}, log})).toBeNull();
    expect(client.listEvents).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
});
